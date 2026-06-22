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
 *     reply into an outbound `#agent/message/outbound` note itself (the wiring
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
import { resolveInjectedGrants, type GrantsClient } from "../grants.ts";
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
   * The hub grants client (4b — design 2026-06-17-agent-connectors-4b.md). When
   * wired, each turn fetches the agent's APPROVED cross-resource grants FRESH and
   * injects their material: granted-vault material → an extra MCP server in the
   * agent's `--mcp-config`; granted-service material → an env var (e.g. GITHUB_TOKEN)
   * and/or the service's MCP server. Fetched per-turn (never cached) so a revocation
   * takes effect on the NEXT spawn. Optional: null/absent → no cross-resource grants
   * (own-vault only, today's behavior). A grants-list failure is logged + the turn
   * runs WITHOUT the extra grants (own-vault still works).
   */
  grants?: GrantsClient | null;
  /**
   * The agent NAME used to key the agent's grants on the hub (`GET
   * /admin/grants?agent=<name>`). Defaults to `spec.name` when absent. The grants are
   * keyed by the agent name (= the def's name), which equals `spec.name` for a
   * vault-native agent. Threaded explicitly so a future channel/agent-name split
   * doesn't silently fetch the wrong agent's grants.
   */
  grantsAgentName?: string;
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
  /**
   * Sleep used by the turn-level transient-retry backoff. Injected so tests don't
   * actually wait the backoff. Defaults to a real `setTimeout`-backed sleep.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Turn-level retry on TRANSIENT upstream errors (API 529/overload, 5xx, rate-limit,
 * network). A 529 with no retry is exactly the "silent no-reply" a user hits under
 * load; incremental backoff turns most of those into a delivered reply. The detector
 * ({@link isTransientTurnError}) is conservative — a 4xx (auth/validation), a missing
 * credential, or a deterministic subtype failure is NOT retried (it'd only burn time).
 */
export const TURN_MAX_ATTEMPTS = 3;
/** Incremental backoff before each retry (ms); length = TURN_MAX_ATTEMPTS - 1. */
export const TURN_RETRY_BACKOFF_MS: readonly number[] = [2_000, 5_000];

/** Does this turn-failure reason look like a transient upstream error worth retrying? */
export function isTransientTurnError(reason: string): boolean {
  const r = reason.toLowerCase();
  return (
    /\b(429|500|502|503|504|529)\b/.test(reason) ||
    r.includes("overloaded") ||
    r.includes("rate limit") ||
    r.includes("rate_limit") ||
    r.includes("service unavailable") ||
    r.includes("bad gateway") ||
    r.includes("gateway time") ||
    r.includes("internal server error") ||
    r.includes("temporarily") ||
    r.includes("timed out") ||
    r.includes("timeout") ||
    r.includes("etimedout") ||
    r.includes("econnreset")
  );
}

/** Default real sleep for the retry backoff (overridable via `deps.sleepFn` in tests). */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  /**
   * Model to run the turn on (`claude -p --model <value>`) — a CC alias
   * (`opus`/`sonnet`/`haiku`) or a full model id. Omitted/empty → no `--model`
   * flag, inheriting CC's default. Passed as a discrete argv element (no shell).
   */
  model?: string;
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
  // Model is OPTIONAL — only add the flag when the spec set one, so an unset
  // model inherits Claude Code's own default rather than pinning a value here.
  if (typeof opts.model === "string" && opts.model.trim().length > 0) {
    argv.push("--model", opts.model.trim());
  }
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
    //
    // FIX 2 (PR #3) — mid-turn token expiry, ASSESSED + DEFERRED (no re-mint added).
    // The vault write token is MINTED FRESH per turn here (no `expiresIn` override → the
    // hub default ~90d non-ephemeral TTL), so it CANNOT expire during a single `claude -p`
    // turn (which lasts minutes). And the vault WRITES are made by the OPAQUE `claude -p`
    // subprocess via the token baked into its 0600 `.mcp.json` (below) — the backend has
    // NO in-process seam to observe a 401 from those writes and re-inject a new token
    // mid-turn. A re-mint-on-401 would require the MCP-client-in-subprocess to surface
    // 401s back here, which the architecture doesn't provide. So a re-mint is INFEASIBLE
    // (and unnecessary given the fresh-per-turn ~90d mint). If a future long-running /
    // multi-day single turn or a short operator-pinned TTL ever makes mid-turn expiry
    // real, the fix is at the MCP-client layer (refresh-on-401), tracked as a follow-up
    // — NOT a forced backend re-mint that can't see the failure.
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

    // 4b: resolve the agent's APPROVED cross-resource grants FRESH this turn (design
    // 2026-06-17-agent-connectors-4b.md §3). Granted-vault material → extra MCP
    // servers (the agent reaches OTHER vaults alongside its own); granted-service
    // material → env vars (GITHUB_TOKEN, …) and/or the service's MCP server. Fetched
    // per-turn (never cached) so a revocation takes effect next spawn. Best-effort: a
    // grants-list failure logs + the turn runs WITHOUT the extra grants — own-vault is
    // unaffected. The secret material lands ONLY in the ephemeral 0600 .mcp.json + the
    // child env below; NEVER in a vault note. mcp-kind grants stay pending server-side
    // in 4b-1 (no OAuth) → getMaterial returns null for them → never injected.
    let grantMcpEntries: { name: string; url: string; token: string }[] = [];
    let grantEnv: Record<string, string> = {};
    if (this.deps.grants) {
      // The grants are keyed on the hub by the AGENT name, which for vault-native defs
      // is `spec.name`. `grantsAgentName` is an explicit override reserved for a future
      // channel-name≠agent-name split; today no caller sets it, so it falls through to
      // `spec.name` — do NOT set it unless that split lands (else you'd fetch the wrong
      // agent's grants).
      const agentName = this.deps.grantsAgentName ?? spec.name;
      try {
        const injected = await resolveInjectedGrants(this.deps.grants, agentName);
        grantMcpEntries = injected.mcpEntries;
        grantEnv = injected.env;
      } catch (err) {
        // A failed grant LIST aborts only the cross-resource injection — the turn
        // still runs with own-vault. (A revoked-mid-list / hub blip class.)
        console.warn(
          `parachute-agent: resolving grants for "${agentName}" failed (running this turn ` +
            `WITHOUT cross-resource grants — own-vault unaffected): ${(err as Error).message}`,
        );
      }
    }

    // Write the strict MCP config 0600 — it inlines the vault token + any granted-
    // resource tokens. No channels[] entry: messaging is the daemon's job, not the
    // agent's. With an empty `channels`, `channelUrl` is never read (it only builds
    // `/mcp/<channel>` entry URLs), so we pass "" rather than thread an unrelated
    // origin into a slot that goes nowhere. The granted MCP servers are added as
    // `otherMcps` (each with its own Bearer) — additive to the own-vault entry.
    const mcpConfigJson = buildAgentMcpConfigJson({
      channelUrl: "",
      channels: [],
      ...(vaultArg ? { vault: vaultArg } : {}),
      ...(grantMcpEntries.length > 0 ? { otherMcps: grantMcpEntries } : {}),
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

    // Mode-aware session handling (the architecture-synthesis chokepoint). A
    // `multi-threaded` agent is thread-keyed; TODAY (no inbound thread id yet) every
    // fire mints a FRESH thread: do NOT read a prior session id (no `--resume`) and do
    // NOT persist the returned id below — each fire is a clean, independent invocation
    // with no conversation continuity. (The per-thread persist+resume — keying the
    // session store by thread id so a specific prior thread can be resumed — is the
    // DEFERRED increment of this mode; until then multi-threaded ships in its degenerate
    // fresh-per-fire form.) `single-threaded` (the default, = today) reads + persists
    // exactly as before. Branch ONCE here on `spec.mode`.
    const multiThreaded = spec.mode === "multi-threaded";

    // Build the -p argv with --resume when a session id is stored for this channel —
    // skipped entirely for multi-threaded (no continuity to restore in its fresh-per-
    // fire form).
    const resumeSessionId = multiThreaded ? undefined : this.deps.sessionState.get(channel);
    const argv = buildProgrammaticClaudeArgs({
      message,
      mcpConfigPath,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(this.deps.claudeBin ? { claudeBin: this.deps.claudeBin } : {}),
      ...(systemPromptFile
        ? { systemPromptFile, systemPromptMode: spec.systemPromptMode ?? "append" }
        : {}),
      ...(spec.model ? { model: spec.model } : {}),
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

    // Merge the granted-service env (GITHUB_TOKEN, …) with the operator-scoped
    // per-channel env. The per-channel store wins on a key collision (it's the
    // explicit operator override); both go in at the SAME (lowest) precedence layer of
    // buildAgentChildEnv — which then applies its denylist (ANTHROPIC_API_KEY /
    // CLAUDE_API_KEY / CLAUDE_CODE_OAUTH_TOKEN can NEVER be set from either source) and
    // sets CLAUDE_CODE_OAUTH_TOKEN LAST, so a granted var can never clobber the
    // session's managed auth or the subscription-billing guarantee.
    const mergedChannelEnv: Record<string, string> = { ...grantEnv, ...channelEnv };

    // Layer the scrubbed agent env UNDER the sandbox wrapper's env; the HOME/config/
    // temp vars layer LAST so they win. CLAUDE_CODE_OAUTH_TOKEN injected;
    // ANTHROPIC_API_KEY/CLAUDE_API_KEY absent (the subscription-billing guarantee).
    const childEnv = buildAgentChildEnv(
      this.deps.parentEnv ?? process.env,
      claudeOauthToken,
      mergedChannelEnv,
    );
    const launchEnv: Record<string, string | undefined> = {
      ...childEnv,
      ...wrapped.env,
      ...homeEnv,
    };

    // Run the turn, with a bounded retry on TRANSIENT upstream errors (API 529/overload,
    // 5xx, rate-limit, network). The argv is fixed (built above with the turn-start
    // `--resume` sid), so each attempt re-runs the SAME turn. STREAM stdout incrementally
    // (interim events for the live view) while draining stderr in parallel; the interim
    // sink is best-effort + must not throw. A spawn/IO fault is a value (not a throw); a
    // non-transient failure or exhausted retries returns the failure for the daemon to learn.
    const safeInterim: InterimSink = (e) => {
      if (!onInterim) return;
      try {
        onInterim(e);
      } catch {
        // A push to a closed SSE stream / a sink fault must never break the turn.
      }
    };
    const sleepFn = this.deps.sleepFn ?? realSleep;
    for (let attempt = 1; attempt <= TURN_MAX_ATTEMPTS; attempt++) {
      let parsed;
      let stderr: string;
      let code: number;
      try {
        const proc = this.deps.spawnFn(wrapped.argv, { env: launchEnv, cwd });
        [parsed, stderr] = await Promise.all([
          parseStreamJsonStream(proc.stdout, safeInterim),
          drainStream(proc.stderr),
        ]);
        code = await proc.exited;
      } catch (err) {
        // A spawn/IO fault (ENOENT, resource) is a config/permanent class — not retried.
        return { ok: false, error: `claude -p spawn failed: ${(err as Error).message}` };
      }

      if (parsed.success === true) {
        // Persist the captured session id so the NEXT turn resumes it. SKIPPED for
        // multi-threaded (each fire starts fresh — no resume, no persist). Blank id = no-op.
        if (!multiThreaded && parsed.sessionId) this.deps.sessionState.set(channel, parsed.sessionId);

        const usage: DeliverUsage | undefined = parsed.usage
          ? {
              ...(typeof parsed.usage.input_tokens === "number" ? { inputTokens: parsed.usage.input_tokens } : {}),
              ...(typeof parsed.usage.output_tokens === "number" ? { outputTokens: parsed.usage.output_tokens } : {}),
              ...(typeof parsed.totalCostUsd === "number" ? { totalCostUsd: parsed.totalCostUsd } : {}),
            }
          : typeof parsed.totalCostUsd === "number"
            ? { totalCostUsd: parsed.totalCostUsd }
            : undefined;

        return {
          ok: true,
          reply: parsed.reply ?? "",
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(usage ? { usage } : {}),
        };
      }

      // FAILURE — compute the reason (non-zero exit / is_error / non-success subtype /
      // no result event), same precedence as before.
      const reason =
        parsed.errorMessage ??
        (parsed.subtype ? `claude -p turn failed (subtype: ${parsed.subtype})` : undefined) ??
        (code !== 0
          ? `claude -p exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}`
          : "claude -p produced no success result (no result event in output)");

      // Retry ONLY a transient error, and only while attempts remain (incremental backoff).
      if (attempt < TURN_MAX_ATTEMPTS && isTransientTurnError(reason)) {
        const backoff =
          TURN_RETRY_BACKOFF_MS[attempt - 1] ?? TURN_RETRY_BACKOFF_MS[TURN_RETRY_BACKOFF_MS.length - 1] ?? 5_000;
        console.warn(
          `parachute-agent: transient turn error for channel "${channel}" ` +
            `(attempt ${attempt}/${TURN_MAX_ATTEMPTS}, retrying in ${backoff}ms): ${reason}`,
        );
        await sleepFn(backoff);
        continue;
      }
      // Persist the session id even on a FINAL failure — a turn can fail AFTER
      // establishing a session; the id is still the continuation handle for the next
      // turn (matches the pre-retry behavior). SKIPPED for multi-threaded. NOT persisted
      // on a retried attempt (the fixed argv re-resumes the turn-start sid each time).
      if (!multiThreaded && parsed.sessionId) this.deps.sessionState.set(channel, parsed.sessionId);
      // Non-transient, or out of attempts → return the failure (the daemon records
      // status:error AND posts a user-facing failure note to the channel).
      return {
        ok: false,
        error: reason,
        ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
      };
    }
    // Unreachable — every loop path returns — but satisfies the type checker.
    return { ok: false, error: "claude -p: retries exhausted" };
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
