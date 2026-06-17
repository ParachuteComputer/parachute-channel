/**
 * The PROGRAMMATIC agent backend (design 2026-06-16-pluggable-agent-backend.md).
 *
 * Drives a channel agent by running ONE sandboxed `claude -p` turn per inbound
 * message and capturing the reply — NO idle interactive session, so the whole
 * deaf-on-restart fragility class (no-loss replay #67, per-session restart #68,
 * dev-channels consent gate #70/#71) simply does not exist here. "Wake" is "run the
 * next turn."
 *
 * ── The verified mechanic (spike against claude 2.1.179) ────────────────────────
 *   claude -p "<message>" \
 *     --output-format stream-json --verbose \
 *     --strict-mcp-config --mcp-config <path> \
 *     --dangerously-skip-permissions \
 *     [--resume <session_id>]
 *
 *   - Runs on the SUBSCRIPTION (`apiKeySource: "none"` in the init event; the
 *     rate_limit_event shows the `five_hour` subscription pool) — NOT metered API,
 *     as long as no `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` is in the env. The
 *     `total_cost_usd` in the result is an equivalent-cost figure, not a charge.
 *   - `--resume <session_id>` restores full conversation continuity. FIRST turn:
 *     omit `--resume`, capture `session_id` from the init/result event, persist it
 *     (AgentSessionState); subsequent turns pass `--resume <stored id>`.
 *   - `-p` has NO TUI → no consent gates at all (this backend avoids the #70/#71
 *     class by construction). Hence NO `--dangerously-load-development-channels`.
 *
 * ── What's deliberately ABSENT vs the interactive spawn ─────────────────────────
 *   - NO channel MCP entry. The daemon mediates messaging in this backend: it
 *     hands the agent the inbound text as the `-p` prompt, and turns the returned
 *     reply into an outbound `#agent-message/outbound` note itself (the wiring
 *     follow-up). The agent's `.mcp.json` carries the VAULT MCP only — so the agent
 *     has memory + tools, but inbound/outbound is the daemon's job, not the agent's.
 *   - NO `--dangerously-load-development-channels`, NO consent-gate auto-confirm.
 *
 * ── What's REUSED (not reinvented) ──────────────────────────────────────────────
 *   - `buildAgentChildEnv` — env scrub + `CLAUDE_CODE_OAUTH_TOKEN` inject + the #68
 *     per-channel env injection + the ANTHROPIC_API_KEY/CLAUDE_API_KEY denylist.
 *   - `resolveClaudeCredential` + `resolveChannelEnv` (credentials.ts) — the
 *     per-channel secret/env stores.
 *   - `seedAgentHome` — the per-session writable HOME/config/tmp (stability keystone).
 *   - `wrapArgvInSandbox` (spawn-agent.ts) — the SHARED sandbox seam: same egress
 *     floor + scoped-read confinement the interactive spawn gets.
 *   - `mintScopedToken` + `buildAgentMcpConfigJson` — the vault token mint + the
 *     inline MCP config writer.
 *
 * ── Single turn, serial per channel ─────────────────────────────────────────────
 * {@link ProgrammaticBackend.deliver} runs ONE turn. The DAEMON (wiring follow-up)
 * owns per-channel SERIAL processing — never two concurrent `claude -p` for the
 * same channel/session, which would FORK the conversation. This backend does not
 * itself enforce that ordering; it records the latest session id and runs the turn
 * it is handed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec } from "../sandbox/types.ts";
import { normalizeChannel } from "../sandbox/types.ts";
import type { SandboxEngine } from "../sandbox/index.ts";
import {
  buildAgentChildEnv,
  resolveAgentCwd,
  seedAgentHome,
  sessionWorkspace,
  shellJoin,
  wrapArgvInSandbox,
} from "../spawn-agent.ts";
import {
  mintScopedToken,
  vaultScope,
  type MintTokenDeps,
} from "../mint-token.ts";
import { buildAgentMcpConfigJson, vaultEntryKey } from "../agent-mcp-config.ts";
import { resolveClaudeCredential, resolveChannelEnv } from "../credentials.ts";
import { AgentSessionState } from "../agent-session-state.ts";
import { parseStreamJsonStream } from "./stream-json.ts";
import type {
  AgentBackend,
  AgentHandle,
  AgentStatus,
  DeliverResult,
  DeliverUsage,
  InterimSink,
} from "./types.ts";

/** Same slug shape `spawnAgent` enforces — a name lands in a path segment. */
const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

export const PROGRAMMATIC_BACKEND_KIND = "programmatic" as const;

/**
 * The minimal subprocess shape the runner awaits — a slice of `Bun.spawn`'s return
 * (stdout/stderr streams + `exited`). Tests inject a fake that emits canned
 * stream-json so no real `claude` is ever spawned.
 */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
}
export type ProgrammaticSpawnFn = (
  argv: string[],
  opts: { env: Record<string, string | undefined>; cwd: string },
) => SpawnedProc;

/** Wiring the programmatic backend resolves its launch side-effects from. */
export interface ProgrammaticBackendDeps {
  /** Hub origin + manager bearer for minting the vault token (§4.3). */
  hubOrigin: string;
  managerBearer: string;
  /** Vault base URL (if the spec binds a vault). Defaults to hubOrigin. */
  vaultUrl?: string;
  /** Base for session workspaces (e.g. `~/.parachute/agent/sessions`). */
  sessionsDir: string;
  /** Read-only runtime/config binds the sandbox always grants (the claude config dir, …). */
  runtimeReadOnly: string[];
  /**
   * The per-channel session-id store (resume continuity). Injected so tests point
   * it at a throwaway dir; the daemon constructs one at boot.
   */
  sessionState: AgentSessionState;
  /** Resolve the Claude OAuth token (channel override ?? default ?? throw). Stub in tests. */
  resolveClaudeToken?: (channel: string) => string;
  /** Resolve the per-channel env injection (GH_TOKEN, CLOUDFLARE_API_TOKEN, …). Stub in tests. */
  resolveChannelEnv?: (channel: string) => Record<string, string>;
  /** Sandbox engine override (tests inject a fake). */
  sandboxEngine?: SandboxEngine;
  /** fetch override for the mint client (tests). */
  fetchFn?: typeof fetch;
  /**
   * The subprocess spawner — runs the sandbox-wrapped `claude -p`. Tests inject a
   * fake that emits canned stream-json; the daemon uses the real Bun.spawn adapter.
   */
  spawnFn: ProgrammaticSpawnFn;
  /** Parent env to scrub from. Defaults to process.env. */
  parentEnv?: Record<string, string | undefined>;
  /** claude binary. Defaults to "claude". */
  claudeBin?: string;
  /** Optional ripgrep override threaded to the sandbox (macOS deny-path scan). */
  ripgrep?: { command: string; args?: string[] };
}

/**
 * Build the `claude -p` invocation argv (PRE-sandbox-wrap) for one turn.
 *
 * The verified shape (claude 2.1.179): headless `-p` with the message as the
 * prompt, stream-json output, the strict multi-entry MCP config, and
 * skip-permissions (the turn is autonomous; the sandbox is the containment). When a
 * `resumeSessionId` is present, `--resume <id>` continues the prior conversation;
 * the FIRST turn omits it.
 *
 * DELIBERATELY ABSENT: `--dangerously-load-development-channels` (no channel MCP in
 * this backend — the daemon mediates messaging), and any TUI flag (`-p` has none).
 *
 * SYSTEM PROMPT (design 2026-06-16-channel-system-prompt.md): when the spec carries
 * a `systemPrompt`, the per-session prompt FILE path is passed via the `-file`
 * variant — `--append-system-prompt-file <path>` (append mode, keeps CC's default)
 * or `--system-prompt-file <path>` (replace mode). The flags are PER-INVOCATION, so
 * this is added on EVERY turn (including `--resume` turns) — the argv is rebuilt per
 * `deliver`, and the file is (re)written each turn (see {@link ProgrammaticBackend.deliver}).
 * The `-file` form (over the inline string form) is robust to long/multiline prompts
 * and keeps the prompt visible-on-disk to the backend.
 */
export function buildProgrammaticClaudeArgs(opts: {
  message: string;
  mcpConfigPath: string;
  resumeSessionId?: string;
  claudeBin?: string;
  /** Path to the per-session system-prompt file (omitted = no system-prompt flag). */
  systemPromptFile?: string;
  /** How the system prompt composes — append (default) keeps CC's base; replace overrides it. */
  systemPromptMode?: "append" | "replace";
}): string[] {
  const bin = opts.claudeBin ?? "claude";
  const argv = [
    bin,
    "-p",
    opts.message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    "--dangerously-skip-permissions",
  ];
  // System prompt (file-backed). Append KEEPS CC's capable default + adds the role;
  // replace overrides it entirely. Re-passed every turn (the flag isn't persistent).
  if (opts.systemPromptFile) {
    const flag = opts.systemPromptMode === "replace" ? "--system-prompt-file" : "--append-system-prompt-file";
    argv.push(flag, opts.systemPromptFile);
  }
  if (opts.resumeSessionId) {
    argv.push("--resume", opts.resumeSessionId);
  }
  return argv;
}

/** Read the full text of a (possibly null) byte stream; null/error → "". */
async function drainStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}

/**
 * The programmatic backend — one sandboxed `claude -p` turn per message.
 *
 * `start` is lightweight (no resident process; a "session" is just the persisted
 * resume id). `deliver` runs the turn and returns a {@link DeliverResult} — a
 * failure is a VALUE (`{ ok: false, error }`), never a throw. `stop` clears the
 * resume id. `status` is always live (there is nothing to keep alive).
 */
export class ProgrammaticBackend implements AgentBackend {
  readonly kind = PROGRAMMATIC_BACKEND_KIND;
  private readonly deps: ProgrammaticBackendDeps;

  constructor(deps: ProgrammaticBackendDeps) {
    this.deps = deps;
  }

  /**
   * Bring an agent up for a channel. There is no resident process — this validates
   * the spec and returns a handle keyed on the wake channel (the first channel).
   * The actual `claude -p` invocation happens per-message in {@link deliver}.
   */
  async start(spec: AgentSpec): Promise<AgentHandle> {
    if (!AGENT_NAME_SLUG.test(spec.name)) {
      throw new Error(
        `ProgrammaticBackend.start: spec name "${spec.name}" must be a slug ` +
          `(alphanumeric, dash, underscore only)`,
      );
    }
    if (spec.channels.length === 0) {
      throw new Error(`ProgrammaticBackend.start: spec "${spec.name}" declares no channels`);
    }
    const channel = normalizeChannel(spec.channels[0]!).name;
    return { backend: this.kind, channel, name: spec.name, spec };
  }

  /**
   * Run ONE `claude -p` turn for the handle's channel and return its reply.
   *
   * Order: resolve the Claude credential (throws → the daemon surfaces it) → mint
   * the VAULT token (if the spec binds a vault) → write the vault-only `.mcp.json`
   * → build the `-p` argv (with `--resume <sid>` when a session id is stored) →
   * sandbox-wrap via the shared seam → spawn → STREAM + parse the stream-json →
   * persist the captured session id → return the DeliverResult.
   *
   * STREAMING (design build item #1): the stdout stream-json is read INCREMENTALLY
   * via {@link parseStreamJsonStream}. When `onInterim` is given, interim events
   * (assistant text chunks + tool_use) are emitted as the turn runs so the daemon
   * can render "watch it work" live; the FINAL parse (the authoritative `result`)
   * is identical whether or not a sink is wired — the durable outbound note path is
   * unchanged. `onInterim` is best-effort and must not throw.
   *
   * A failure (mint refused, non-zero exit, `is_error: true`, non-success subtype,
   * empty output) returns `{ ok: false, error }` — it does NOT throw, so the daemon
   * always learns the outcome inline.
   */
  async deliver(handle: AgentHandle, message: string, onInterim?: InterimSink): Promise<DeliverResult> {
    const spec = handle.spec;
    if (!spec) {
      return { ok: false, error: `ProgrammaticBackend.deliver: handle for "${handle.name}" carries no spec` };
    }
    const channel = handle.channel;
    const workspace = sessionWorkspace(this.deps.sessionsDir, spec.name);

    // Resolve the Claude OAuth credential keyed on the wake channel. A missing
    // credential throws (CredentialNotConfigured) BEFORE any mint/spawn side effect.
    const resolveToken = this.deps.resolveClaudeToken ?? ((ch: string) => resolveClaudeCredential(ch));
    let claudeOauthToken: string;
    try {
      claudeOauthToken = resolveToken(channel);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    // Per-channel env injection (GH_TOKEN, CLOUDFLARE_API_TOKEN, …), read at turn time.
    const resolveEnv = this.deps.resolveChannelEnv ?? ((ch: string) => resolveChannelEnv(ch));
    const channelEnv = resolveEnv(channel);

    // Mint the VAULT token only — no channel MCP in this backend (the daemon
    // mediates messaging). A spec with no vault gets an EMPTY mcpServers config
    // (the agent still runs; it just has no vault tools this turn).
    let vaultArg: { url: string; entry: { name: string; token: string } } | undefined;
    if (spec.vault) {
      const v = spec.vault;
      const mintDeps: MintTokenDeps = {
        hubOrigin: this.deps.hubOrigin,
        managerBearer: this.deps.managerBearer,
        ...(this.deps.fetchFn ? { fetchFn: this.deps.fetchFn } : {}),
      };
      try {
        const minted = await mintScopedToken(
          {
            scope: vaultScope(v.name, v.access),
            audience: `vault.${v.name}`,
            ...(v.tags && v.tags.length > 0 ? { permissions: { scoped_tags: v.tags } } : {}),
          },
          mintDeps,
        );
        vaultArg = {
          url: this.deps.vaultUrl ?? this.deps.hubOrigin,
          entry: { name: v.name, token: minted.token },
        };
      } catch (err) {
        // A refused/over-broad mint aborts the turn with a clean error — no spawn.
        return { ok: false, error: (err as Error).message };
      }
    }

    // Write the (vault-only) strict MCP config 0600 — it inlines the vault token.
    // No channels[] entry: messaging is the daemon's job, not the agent's. With an
    // empty `channels`, `channelUrl` is never read (it only builds `/mcp/<channel>`
    // entry URLs), so we pass "" rather than thread an unrelated origin into a slot
    // that goes nowhere.
    const mcpConfigJson = buildAgentMcpConfigJson({
      channelUrl: "",
      channels: [],
      ...(vaultArg ? { vault: vaultArg } : {}),
    });
    mkdirSync(workspace, { recursive: true });
    const mcpConfigPath = join(workspace, ".mcp.json");
    writeFileSync(mcpConfigPath, mcpConfigJson, { mode: 0o600 });

    // System prompt (design 2026-06-16-channel-system-prompt.md). When the spec
    // carries one, write it to a per-session file (0600) and pass the `-file` flag.
    // The flag is PER-INVOCATION (not persistent), so we (re)write the file + pass
    // it EVERY turn — including a `--resume` turn — so the role is always applied.
    // Unset → no flag, no file (today's behavior unchanged). The `-file` form is
    // robust to long/multiline prompts and keeps the prompt visible-on-disk. Its
    // lifecycle is tied to the workspace (like .mcp.json) — it disappears with it.
    let systemPromptFile: string | undefined;
    if (typeof spec.systemPrompt === "string" && spec.systemPrompt.length > 0) {
      systemPromptFile = join(workspace, "system-prompt.txt");
      writeFileSync(systemPromptFile, spec.systemPrompt, { mode: 0o600 });
    }

    // Build the -p argv with --resume when a session id is stored for this channel.
    const resumeSessionId = this.deps.sessionState.get(channel);
    const argv = buildProgrammaticClaudeArgs({
      message,
      mcpConfigPath,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(this.deps.claudeBin ? { claudeBin: this.deps.claudeBin } : {}),
      ...(systemPromptFile
        ? { systemPromptFile, systemPromptMode: spec.systemPromptMode ?? "append" }
        : {}),
    });

    // Sandbox-wrap via the SHARED seam — same egress floor + scoped-read
    // confinement the interactive spawn gets. The wrapped argv carries the policy.
    const wrapped = await wrapArgvInSandbox({
      spec,
      workspace,
      runtimeReadOnly: this.deps.runtimeReadOnly,
      hubOrigin: this.deps.hubOrigin,
      ...(this.deps.vaultUrl ? { vaultUrl: this.deps.vaultUrl } : {}),
      argv,
      ...(this.deps.sandboxEngine ? { sandboxEngine: this.deps.sandboxEngine } : {}),
      ...(this.deps.ripgrep ? { ripgrep: this.deps.ripgrep } : {}),
    });

    // The agent's WORKING dir (design 2026-06-16-agent-filesystem-and-sharing.md):
    // the spec's `workspace` (a shared real dir) when set, else the private session
    // dir (today's behavior). The cwd is decoupled from the private dir —
    // `.mcp.json`/`system-prompt.txt`/seeded home stay PRIVATE under the session
    // dir (passed by absolute path), so a shared workspace never receives the
    // agent's secrets even when two agents point at the same dir.
    const cwd = resolveAgentCwd(spec, workspace);

    // The agent's private, writable, pre-seeded HOME + temp dirs (stability
    // keystone) — always UNDER the private workspace, regardless of the cwd. The
    // vault MCP server name is pre-approved so claude doesn't prompt; the pre-trusted
    // project is the agent's actual cwd (the shared working dir when set).
    const mcpServerNames = Object.keys(
      (JSON.parse(mcpConfigJson) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {},
    );
    const homeEnv = seedAgentHome(workspace, { mcpServers: mcpServerNames, projectRoot: cwd });

    // Layer the scrubbed agent env UNDER the sandbox wrapper's env; the HOME/config/
    // temp vars layer LAST so they win. CLAUDE_CODE_OAUTH_TOKEN injected;
    // ANTHROPIC_API_KEY/CLAUDE_API_KEY absent (the subscription-billing guarantee).
    const childEnv = buildAgentChildEnv(
      this.deps.parentEnv ?? process.env,
      claudeOauthToken,
      channelEnv,
    );
    const launchEnv: Record<string, string | undefined> = {
      ...childEnv,
      ...wrapped.env,
      ...homeEnv,
    };

    // Run the turn. A spawn/IO fault is a value (not a throw) — the daemon learns it.
    // STREAM stdout incrementally (interim events for the live view) while draining
    // stderr in parallel. The interim sink is best-effort + must not throw: wrap the
    // caller's `onInterim` so a dead-stream error from the daemon's push can't abort
    // the drain (which would strand the durable final-result parse). A no-sink turn
    // passes a no-op, so the stream is still parsed incrementally with zero overhead
    // beyond the (cheap) per-line dispatch.
    let parsed;
    let stderr: string;
    let code: number;
    const safeInterim: InterimSink = (e) => {
      if (!onInterim) return;
      try {
        onInterim(e);
      } catch {
        // A push to a closed SSE stream / a sink fault must never break the turn.
      }
    };
    try {
      const proc = this.deps.spawnFn(wrapped.argv, { env: launchEnv, cwd });
      [parsed, stderr] = await Promise.all([
        parseStreamJsonStream(proc.stdout, safeInterim),
        drainStream(proc.stderr),
      ]);
      code = await proc.exited;
    } catch (err) {
      return { ok: false, error: `claude -p spawn failed: ${(err as Error).message}` };
    }

    // Persist the captured session id so the NEXT turn resumes it — even on a
    // failed turn (a turn can fail AFTER establishing a session; the id is still
    // the continuation handle). A blank id is a no-op in the store.
    if (parsed.sessionId) this.deps.sessionState.set(channel, parsed.sessionId);

    const usage: DeliverUsage | undefined = parsed.usage
      ? {
          ...(typeof parsed.usage.input_tokens === "number" ? { inputTokens: parsed.usage.input_tokens } : {}),
          ...(typeof parsed.usage.output_tokens === "number" ? { outputTokens: parsed.usage.output_tokens } : {}),
          ...(typeof parsed.totalCostUsd === "number" ? { totalCostUsd: parsed.totalCostUsd } : {}),
        }
      : typeof parsed.totalCostUsd === "number"
        ? { totalCostUsd: parsed.totalCostUsd }
        : undefined;

    // FAILURE paths — all return a value, never throw:
    //   - non-zero exit with no parseable success result;
    //   - a result event with is_error / a non-success subtype;
    //   - no result event at all (crashed/truncated turn).
    if (parsed.success !== true) {
      const reason =
        parsed.errorMessage ??
        (parsed.subtype ? `claude -p turn failed (subtype: ${parsed.subtype})` : undefined) ??
        (code !== 0
          ? `claude -p exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`
          : "claude -p produced no success result (no result event in output)");
      return {
        ok: false,
        error: reason,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
    }

    return {
      ok: true,
      reply: parsed.reply ?? "",
      ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      ...(usage ? { usage } : {}),
    };
  }

  /**
   * Tear the agent down — clear the persisted resume id so the channel's next
   * message starts a FRESH conversation. There is no process to kill.
   */
  async stop(handle: AgentHandle): Promise<void> {
    this.deps.sessionState.clear(handle.channel);
  }

  /**
   * The programmatic backend has no resident process to keep alive — it is always
   * available to run the next turn, so `live` is true.
   */
  async status(_handle: AgentHandle): Promise<AgentStatus> {
    return { live: true };
  }
}

/**
 * The real `Bun.spawn` adapter for the programmatic backend — pipes stdout/stderr
 * so the runner can drain the stream-json, applies the launch env + cwd. Used by
 * the daemon; tests inject a fake `spawnFn` instead.
 */
export function realProgrammaticSpawn(spawnFn: typeof Bun.spawn = Bun.spawn): ProgrammaticSpawnFn {
  return (argv, opts) => {
    const proc = spawnFn(argv, {
      env: opts.env,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: proc.stdout as ReadableStream<Uint8Array> | null,
      stderr: proc.stderr as ReadableStream<Uint8Array> | null,
      exited: proc.exited,
    };
  };
}
