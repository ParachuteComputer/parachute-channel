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
 *     [--session-id <uuid> | --resume <uuid>]
 *
 *   - Runs on the SUBSCRIPTION (`apiKeySource: "none"` in the init event; the
 *     rate_limit_event shows the `five_hour` subscription pool) — NOT metered API,
 *     as long as no `ANTHROPIC_API_KEY`/`CLAUDE_API_KEY` is in the env. The
 *     `total_cost_usd` in the result is an equivalent-cost figure, not a charge.
 *   - The DAEMON owns the session uuid (it lives on the `#agent/thread` note's
 *     `metadata.session`), NOT a backend-private store. The caller resolves the turn's
 *     {@link TurnSession} and hands it in: `--session-id <uuid>` CREATES a session with
 *     that uuid (first turn) and `--resume <uuid>` CONTINUES it (subsequent turns) —
 *     both restore/establish full conversation continuity. The captured id still comes
 *     back on the result so the caller (the registry) can persist it onto the note.
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
import type { InboundAttachment } from "../transport.ts";
import { normalizeChannel } from "../sandbox/types.ts";
import type { SandboxEngine } from "../sandbox/index.ts";
import {
  buildAgentChildEnv,
  mergeSandboxLaunchEnv,
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
import { parseStreamJsonStream } from "./stream-json.ts";
import { composeSystemPrompt } from "./types.ts";
import type {
  AgentBackend,
  AgentHandle,
  AgentStatus,
  DeliverResult,
  DeliverUsage,
  InterimSink,
  LoadoutEntry,
  RunContext,
  TurnSession,
} from "./types.ts";

/** Same slug shape `spawnAgent` enforces — a name lands in a path segment. */
const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

export const PROGRAMMATIC_BACKEND_KIND = "programmatic" as const;

/** The staging subdir (under the PRIVATE session workspace) inbound files are written into. */
export const ATTACHMENT_STAGING_DIR = "attachments" as const;
/**
 * Per-attachment byte ceiling for staging. Matches the vault's own 100MB upload cap
 * (parachute-vault `/api/storage` POST), so we never refuse a file the vault accepted —
 * but caps a runaway/over-large blob from filling the workspace.
 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024;
/** Max number of attachments staged per turn — a sane bound on fan-out. */
export const ATTACHMENT_MAX_COUNT = 20;

/**
 * Sanitize a (possibly untrusted, possibly path-ful) attachment filename/path to a SAFE
 * BASENAME for staging — NO path traversal, NO directory components. `path`/`filename`
 * come from VAULT DATA (not the operator), so this is the security boundary: we take the
 * LAST path segment, drop any `..`/empty segments, strip NUL + leading dots, and replace
 * every character outside `[A-Za-z0-9._-]` with `_`. The result can ONLY name a file
 * DIRECTLY inside the staging dir — never escape it. Returns `"file"` for a degenerate
 * input so a write target always exists. The caller additionally verifies the joined
 * path stays under the staging dir (defense in depth).
 */
export function safeAttachmentBasename(name: string): string {
  // Take the final segment across both slash flavors; this alone defeats `../../etc/x`
  // (every `..` and the leading dirs are discarded — only the trailing segment survives).
  const segments = name.split(/[/\\]+/);
  let base = segments.length > 0 ? segments[segments.length - 1]! : "";
  // Strip NUL bytes + control chars, collapse disallowed chars to `_`.
  base = base.replace(/\0/g, "").replace(/[^A-Za-z0-9._-]/g, "_");
  // No leading dots (no `.`, `..`, or hidden-file surprises).
  base = base.replace(/^\.+/, "");
  if (base.length === 0 || base === "." || base === "..") return "file";
  // Bound the length so a pathological name can't blow up the path.
  return base.slice(0, 200);
}

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

/**
 * Does this turn-failure reason look like a `--resume` of a session that no longer
 * exists — claude's "No conversation found with session ID" class (expiry / transcript
 * cleanup / a missing session jsonl)? Governs the ONE-TIME fresh-create fallback in
 * {@link ProgrammaticBackend.deliver} that keeps an expired session from BRICKING the
 * thread on every future turn (issue #132).
 *
 * ⚠️ TEXT-BASED — this matches claude's ERROR WORDING (anthropics/claude-code#33912),
 * which is VERSION-FRAGILE: if claude changes the phrasing this detector silently stops
 * matching. It is deliberately CONSERVATIVE — it only governs a RECOVERY fallback, so a
 * MISS degrades to today's behavior (the pre-existing brick), never anything worse; it
 * can't, e.g., turn a real failure into a spurious success. A future STRUCTURED error
 * signal (an exit-code or a stream-json error subtype) would be more robust and is the
 * preferred long-term fix. Kept tight enough not to match a generic failure: it requires
 * "conversation"/"session" near the not-found phrasing (never a bare "not found").
 */
export function isSessionNotFoundError(reason: string): boolean {
  return /no conversation found|session not found|no session (?:found |with )|conversation .{0,30}not found|could not find .{0,20}session/i.test(
    reason,
  );
}

/** Default real sleep for the retry backoff (overridable via `deps.sleepFn` in tests). */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the `claude -p` invocation argv (PRE-sandbox-wrap) for one turn.
 *
 * The verified shape (claude 2.1.179): headless `-p` with the message as the
 * prompt, stream-json output, the strict multi-entry MCP config, and
 * skip-permissions (the turn is autonomous; the sandbox is the containment). The
 * caller resolves the turn's session (the daemon owns the uuid — it lives on the
 * `#agent/thread` note): when `sessionId` is present, `--resume <id>` CONTINUES the
 * prior conversation (`resumeSession: true`) or `--session-id <id>` CREATES a session
 * with that uuid (`resumeSession: false`).
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
  /** The Claude session UUID for this turn (caller-resolved). Omitted → no session flag. */
  sessionId?: string;
  /** true → `--resume <sessionId>` (continue); false (default) → `--session-id <sessionId>` (create). */
  resumeSession?: boolean;
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
  if (opts.sessionId) {
    argv.push(opts.resumeSession ? "--resume" : "--session-id", opts.sessionId);
  }
  return argv;
}

/**
 * Render the {@link RunContext} as a concise, clearly-LABELED preamble to PREPEND to a turn's
 * message (agent#162). A headless `claude -p` turn has no clock + no notion of which run it is,
 * so the daemon hands it these facts (the real wall-clock, new-vs-resumed, why it fired, the
 * prior turn count) — the agent then stamps ACCURATE times instead of fabricating them.
 *
 * It is a single fenced block clearly marked as daemon-injected runtime context (NOT the
 * agent's own system prompt — that's untouched), then a blank line, then the real message. The
 * `now` is always present; the rest are appended only when known. Returns the message UNCHANGED
 * when `rc` is absent (additive — no behavior change for a caller that doesn't pass one).
 */
export function renderRunContext(message: string, rc: RunContext | undefined): string {
  if (!rc) return message;
  const parts: string[] = [`now=${rc.now}`, `session=${rc.session}`];
  if (typeof rc.priorTurnCount === "number" && rc.priorTurnCount >= 0) {
    // The NUMBER of this turn (1-based) = completed turns + 1 — what an agent stamps as "turn N".
    parts.push(`turn=${rc.priorTurnCount + 1}`);
  }
  if (rc.firedBy) parts.push(`fired-by=${rc.firedBy}`);
  const preamble =
    `[Run context — injected by the agent daemon (this is the real runtime state, NOT your ` +
    `system prompt). Use these for any timestamp/clock or "which run is this" reasoning instead ` +
    `of guessing: ${parts.join(", ")}]`;
  return `${preamble}\n\n${message}`;
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
 * `start` is lightweight (no resident process; a "session" is just the uuid the
 * caller resolves per turn, persisted on the thread note — not here). `deliver` runs
 * the turn with the caller-supplied {@link TurnSession} and returns a
 * {@link DeliverResult} — a failure is a VALUE (`{ ok: false, error }`), never a
 * throw. `stop` is a no-op (no process to kill, no store to clear — the session lives
 * on the durable thread note). `status` is always live (there is nothing to keep alive).
 */
export class ProgrammaticBackend implements AgentBackend {
  readonly kind = PROGRAMMATIC_BACKEND_KIND;
  private readonly deps: ProgrammaticBackendDeps;

  constructor(deps: ProgrammaticBackendDeps) {
    this.deps = deps;
  }

  /**
   * Bring an agent up for a channel. There is no resident process (and no session to
   * pre-establish — the session uuid is resolved per turn by the caller and lives on
   * the thread note) — this validates the spec and returns a handle keyed on the wake
   * channel (the first channel). The actual `claude -p` invocation happens per-message
   * in {@link deliver}.
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
   * → build the `-p` argv (with the caller's {@link TurnSession}: `--resume <id>` to
   * continue, `--session-id <id>` to create) → sandbox-wrap via the shared seam →
   * spawn → STREAM + parse the stream-json → return the DeliverResult (carrying the
   * captured session id so the caller can persist it onto the thread note).
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
   *
   * SESSION-EXPIRY SELF-HEAL (#132): a `--resume` turn whose Claude session no longer
   * exists ("No conversation found with session ID" — expiry / transcript cleanup) is
   * NOT a transient error (no retry helps) and, left alone, would BRICK the thread on
   * EVERY future turn (the stale id stays on the thread note). When a resume turn fails
   * with a {@link isSessionNotFoundError} reason, `deliver` falls back ONCE to a fresh
   * `--session-id <new uuid>` create, re-establishing continuity from this turn forward.
   * The new turn's echoed session id flows out on the {@link DeliverResult} exactly as
   * usual, so the registry persists the NEW id onto the thread note and later turns
   * resume it. The fallback fires AT MOST once (only on a resume turn; the create it
   * runs has `resume: false`, so it can never re-trigger).
   */
  async deliver(
    handle: AgentHandle,
    message: string,
    session: TurnSession,
    onInterim?: InterimSink,
    attachments?: InboundAttachment[],
    runContext?: RunContext,
    loadout?: LoadoutEntry[],
    subject?: string,
  ): Promise<DeliverResult> {
    const spec = handle.spec;
    if (!spec) {
      return { ok: false, error: `ProgrammaticBackend.deliver: handle for "${handle.name}" carries no spec` };
    }
    const channel = handle.channel;
    // roles×threads NEXT slice (#120, G): the PER-THREAD private workspace. A subject keys
    // a distinct `sessions/<name>--<slug(subject)>/` dir (its own `.mcp.json` /
    // `system-prompt.txt` / HOME / attachment staging — see stageAttachments below, which
    // takes THIS workspace), so concurrent subjects of one multi-threaded agent never clobber
    // each other's per-turn files. NO subject → `sessions/<name>/` (HEAD, byte-identical).
    const workspace = sessionWorkspace(this.deps.sessionsDir, spec.name, subject);

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

    // ── INBOUND FILE ATTACHMENTS (Phase 1) ─────────────────────────────────────────
    // Stage each attached file into the agent's PRIVATE session workspace (under a SAFE
    // basename — NO path traversal; the path/filename come from VAULT DATA), then append a
    // pointer line to the turn message so the `claude -p` turn can `Read` them. The private
    // workspace is already in the sandbox read scope (composeFilesystemView always allows
    // `base.workspace`), so NO sandbox-policy change is needed. Staged into the PRIVATE dir
    // (NEVER a shared `spec.workspace`) — mirroring how `.mcp.json`/`system-prompt.txt` stay
    // per-agent even when the working dir is shared. Best-effort + isolated: a single
    // attachment's fetch/stage failure logs + is SKIPPED (the turn still runs with the rest
    // + the text). Absent/empty → no staging, no prompt change (today's behavior exactly).
    // RUN CONTEXT (agent#162): prepend the daemon-injected runtime preamble (the real
    // wall-clock + new/resumed + why-it-fired) so the headless turn reads ACCURATE facts
    // instead of fabricating a clock. Done FIRST so the preamble sits at the very top of the
    // prompt; attachments append after the (already-prefixed) message. Absent runContext →
    // the message is unchanged (additive).
    let turnMessage = renderRunContext(message, runContext);
    if (attachments && attachments.length > 0) {
      const staged = await this.stageAttachments(workspace, attachments, vaultArg);
      if (staged.length > 0) {
        const lines = staged.map((s) => `- ${s.absPath} (${s.mimeType})`);
        turnMessage =
          `${turnMessage}\n\n[Attached files — read them as needed:\n${lines.join("\n")}\n]`;
      }
    }

    // System prompt (design 2026-06-16-channel-system-prompt.md). When the spec
    // carries one, write it to a per-session file (0600) and pass the `-file` flag.
    // The flag is PER-INVOCATION (not persistent), so we (re)write the file + pass
    // it EVERY turn — including a `--resume` turn — so the role is always applied.
    // Unset → no flag, no file (today's behavior unchanged). The `-file` form is
    // robust to long/multiline prompts and keeps the prompt visible-on-disk. Its
    // lifecycle is tied to the workspace (like .mcp.json) — it disappears with it.
    //
    // COMPOSED PROMPT (threads-only Phase A — DESIGN-2026-06-29-threads-only.md §1/§9):
    // the system prompt is an ORDERED LIST of loaded notes — a direct arity-N generalization
    // of the rc.13 arity-2 `roleBody [+ dossier]` seam. Entry 0 is the thread's SELF entry:
    // the spec's `systemPrompt` (the def body), labeled with the def note's PATH
    // (`spec.definition`, the `#agent/definition` note id which IS its vault path; fallback
    // `spec.name`). Entries 1..N are the resolved `loadout` notes (read CONTENT-only, never
    // metadata). composeSystemPrompt dedupes by path, skips blank entries, renders each as
    // `# <path>\n\n<content>`, joins with `\n\n---\n\n`, and enforces the byte budget
    // (truncate loadout-notes-first, NEVER the self entry).
    //
    // NO-LOADOUT INVARIANT (the live 4am steward weave path): a thread with NO loadout
    // composes to EXACTLY `# <path>\n\n<def body>` — `<def body>` byte-identical to
    // `spec.systemPrompt`. The single `# <path>` header is the ONLY change to a no-loadout
    // prompt (design decision #4, accepted). The run-context preamble stays on the MESSAGE.
    let systemPromptFile: string | undefined;
    if (typeof spec.systemPrompt === "string" && spec.systemPrompt.length > 0) {
      // Self entry: the def body, labeled by the def note's PATH (resolve from the def note
      // id when available — in a Parachute vault the note id IS the path, e.g.
      // `Agents/uni-weaver`; acceptable fallback label is the spec name).
      const selfPath =
        typeof spec.definition === "string" && spec.definition.length > 0
          ? spec.definition
          : spec.name;
      const entries: LoadoutEntry[] = [
        { path: selfPath, content: spec.systemPrompt },
        ...(loadout ?? []),
      ];
      const composed = composeSystemPrompt(entries);
      systemPromptFile = join(workspace, "system-prompt.txt");
      writeFileSync(systemPromptFile, composed, { mode: 0o600 });
    }

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
    // (Session-INDEPENDENT — computed ONCE; the per-turn `wrapped.env` layers on top
    // inside `attemptTurn` below.)
    const childEnv = buildAgentChildEnv(
      this.deps.parentEnv ?? process.env,
      claudeOauthToken,
      mergedChannelEnv,
    );

    // The interim sink is best-effort + must not throw (session-INDEPENDENT). A push
    // to a closed SSE stream / a sink fault must never break the turn.
    const safeInterim: InterimSink = (e) => {
      if (!onInterim) return;
      try {
        onInterim(e);
      } catch {
        // A push to a closed SSE stream / a sink fault must never break the turn.
      }
    };
    const sleepFn = this.deps.sleepFn ?? realSleep;

    // Run ONE turn for the given session — build the session-DEPENDENT argv
    // (`--resume <id>` vs `--session-id <id>`), sandbox-wrap it, then run the bounded
    // transient-retry loop. Relocated into a closure so a session-expiry FALLBACK can
    // run it a SECOND time with a fresh create session (#132). The session-independent
    // setup above (workspace, .mcp.json, system-prompt file, cwd, home/child env,
    // interim sink) is shared across both attempts.
    const attemptTurn = async (turnSession: TurnSession): Promise<DeliverResult> => {
      // The DAEMON owns the session uuid (the caller resolved it from the durable
      // `#agent/thread` note — single-threaded resumes its persisted session, multi-
      // threaded gets a fresh uuid every fire). The backend reads no session store: it
      // just runs the turn with the supplied {@link TurnSession} — `--resume <id>` to
      // continue, `--session-id <id>` to create.
      const argv = buildProgrammaticClaudeArgs({
        message: turnMessage,
        mcpConfigPath,
        sessionId: turnSession.id,
        resumeSession: turnSession.resume,
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

      // Compose the launch env so the SCRUB WINS: the scrubbed `childEnv` is
      // authoritative; only the ALLOWLISTED sandbox/proxy keys from `wrapped.env`
      // (NOT the whole daemon `process.env` the engine returns) + the home overrides
      // layer on top. A bare `...wrapped.env` spread would re-admit the daemon's
      // ambient ANTHROPIC_API_KEY/secrets and defeat buildAgentChildEnv's scrub —
      // an isolation/billing leak. See mergeSandboxLaunchEnv.
      const launchEnv = mergeSandboxLaunchEnv(childEnv, wrapped.env, homeEnv);

      // Run the turn, with a bounded retry on TRANSIENT upstream errors (API 529/overload,
      // 5xx, rate-limit, network). The argv is fixed (built above for THIS turn's session),
      // so each attempt re-runs the SAME turn. STREAM stdout incrementally (interim events
      // for the live view) while draining stderr in parallel; the interim sink is best-effort
      // + must not throw. A spawn/IO fault is a value (not a throw); a non-transient failure
      // or exhausted retries returns the failure for the daemon to learn.
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
          // The captured session id is RETURNED (below) for the caller to persist onto
          // the thread note — the backend no longer owns a session store. The id we
          // passed in (turnSession.id) and Claude's echoed parsed.sessionId are normally
          // the same; the registry prefers the echoed one and falls back to turnSession.id.

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
        // RETURN the session id even on a FINAL failure — a turn can fail AFTER
        // establishing a session; the id is still the continuation handle for the next
        // turn. The registry persists it onto the thread note (`result.sessionId ??
        // turnSession.id`), so the next turn resumes the conversation.
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
    };

    let result = await attemptTurn(session);
    // Session-expiry recovery (#132): a --resume turn whose session no longer exists is
    // NOT transient (no retry would help) and would otherwise brick the thread on every
    // future turn (the stale id stays on the note). Fall back ONCE to a fresh create so
    // continuity self-heals from here — the new turn's echoed id flows out for the
    // registry to persist. Only on a RESUME turn; the create itself is never retried this
    // way (the fallback session has resume:false → a not-found on it can't re-trigger).
    if (!result.ok && session.resume && isSessionNotFoundError(result.error)) {
      const fresh = crypto.randomUUID();
      console.warn(
        `parachute-agent: resume session for channel "${channel}" not found (expired?) — ` +
          `starting a fresh session ${fresh}: ${result.error}`,
      );
      result = await attemptTurn({ id: fresh, resume: false });
    }
    return result;
  }

  /**
   * Stage inbound file attachments into the agent's PRIVATE session workspace so the turn
   * can `Read` them (Phase 1). For each attachment: FETCH the blob from the vault storage
   * REST endpoint (`GET <vaultUrl>/vault/<name>/api/storage/<path>`, Bearer the per-turn
   * minted vault token), then WRITE it to `<workspace>/attachments/<safeBasename>`. Returns
   * the staged files' ABSOLUTE paths + mime types (for the prompt pointer line).
   *
   * SECURITY:
   *  - The staged filename is a SAFE BASENAME ({@link safeAttachmentBasename}) — the vault
   *    `path`/`filename` are UNTRUSTED data, so a malicious `../../etc/passwd` collapses to a
   *    plain basename inside the staging dir. As defense in depth we ALSO verify the resolved
   *    write target stays UNDER the staging dir and skip it otherwise.
   *  - Staged ONLY into the PRIVATE session dir (`workspace`), NEVER a shared `spec.workspace`
   *    — mirroring `.mcp.json`/`system-prompt.txt`.
   *  - Per-attachment size cap ({@link ATTACHMENT_MAX_BYTES}, = the vault's 100MB upload
   *    ceiling) + a total count cap ({@link ATTACHMENT_MAX_COUNT}).
   *
   * Best-effort + ISOLATED: a single attachment's fetch/write failure logs + is SKIPPED (the
   * turn still runs with the rest + the text). When the spec binds NO vault, there is no
   * per-turn vault token to authenticate the storage fetch → ALL are skipped with one log.
   */
  private async stageAttachments(
    workspace: string,
    attachments: InboundAttachment[],
    vaultArg: { url: string; entry: { name: string; token: string } } | undefined,
  ): Promise<Array<{ absPath: string; mimeType: string }>> {
    if (!vaultArg) {
      console.warn(
        `parachute-agent: ${attachments.length} inbound attachment(s) but this agent binds no ` +
          `vault — cannot fetch the bytes; running the turn with text only.`,
      );
      return [];
    }
    const fetchFn = this.deps.fetchFn ?? fetch;
    const stagingDir = join(workspace, ATTACHMENT_STAGING_DIR);
    // The canonical staging-dir prefix the write target must stay under (defense in depth).
    const stagingPrefix = stagingDir.endsWith("/") ? stagingDir : `${stagingDir}/`;
    // Create the staging dir LAZILY — only just before the first real write. So a turn where
    // every attachment fails/skips leaves NO empty `attachments/` dir behind (the "no staging
    // side effects unless a file actually staged" contract).
    let stagingDirReady = false;
    const ensureStagingDir = (): void => {
      if (!stagingDirReady) {
        mkdirSync(stagingDir, { recursive: true });
        stagingDirReady = true;
      }
    };

    const staged: Array<{ absPath: string; mimeType: string }> = [];
    const usedNames = new Set<string>();
    const capped = attachments.slice(0, ATTACHMENT_MAX_COUNT);
    if (attachments.length > ATTACHMENT_MAX_COUNT) {
      console.warn(
        `parachute-agent: ${attachments.length} inbound attachments exceeds the cap ` +
          `(${ATTACHMENT_MAX_COUNT}); staging the first ${ATTACHMENT_MAX_COUNT}.`,
      );
    }

    for (const att of capped) {
      if (typeof att.path !== "string" || att.path.length === 0) continue;
      // SAFE basename — defeats path traversal (the vault path/filename are untrusted).
      let base = safeAttachmentBasename(att.filename || att.path);
      // De-dup colliding basenames so a second `report.png` doesn't clobber the first.
      if (usedNames.has(base)) {
        let n = 2;
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const ext = dot > 0 ? base.slice(dot) : "";
        while (usedNames.has(`${stem}-${n}${ext}`)) n++;
        base = `${stem}-${n}${ext}`;
      }
      const target = join(stagingDir, base);
      // Defense in depth: the join MUST stay inside the staging dir.
      if (target !== stagingDir.replace(/\/$/, "") && !target.startsWith(stagingPrefix)) {
        console.warn(
          `parachute-agent: refusing to stage attachment "${att.path}" — resolved path ` +
            `"${target}" escapes the staging dir; skipping.`,
        );
        continue;
      }

      try {
        // The storage path is `date/filename` — `encodeURIComponent` percent-encodes the
        // slash to `%2F`; the vault storage route `decodeURIComponent`s it back before
        // matching (vault routes.ts), so a single encoded segment is the correct form.
        const url = `${vaultArg.url}/vault/${vaultArg.entry.name}/api/storage/${encodeURIComponent(att.path)}`;
        const res = await fetchFn(url, {
          headers: { authorization: `Bearer ${vaultArg.entry.token}` },
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          console.warn(
            `parachute-agent: fetch attachment blob "${att.path}" failed (${res.status}) ` +
              `${detail} — skipping this file`.trim(),
          );
          continue;
        }
        // Pre-flight on Content-Length so an over-cap blob is skipped WITHOUT buffering its
        // whole body. Best-effort: a missing/garbage header falls through to the post-read
        // check below (the real guard).
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
          console.warn(
            `parachute-agent: attachment "${att.path}" declares ${declared} bytes, over the ` +
              `${ATTACHMENT_MAX_BYTES}-byte cap — skipping this file.`,
          );
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
          console.warn(
            `parachute-agent: attachment "${att.path}" is ${buf.byteLength} bytes, over the ` +
              `${ATTACHMENT_MAX_BYTES}-byte cap — skipping this file.`,
          );
          continue;
        }
        ensureStagingDir();
        writeFileSync(target, buf, { mode: 0o600 });
        usedNames.add(base);
        staged.push({ absPath: target, mimeType: att.mimeType || "application/octet-stream" });
      } catch (err) {
        console.warn(
          `parachute-agent: staging attachment "${att.path}" errored (skipping this file): ` +
            `${(err as Error).message}`,
        );
      }
    }
    return staged;
  }

  /**
   * Tear the agent down. A NO-OP for the programmatic backend: there is no resident
   * process to kill, and no session store to clear — the session now lives on the
   * durable `#agent/thread` note (`metadata.session`). So `stop` no longer resets
   * conversation continuity; a single-threaded agent's next turn still resumes its
   * persisted session. Starting a genuinely FRESH conversation is a separate operation
   * (deleting the thread note), not a side effect of stop/deregister.
   */
  async stop(_handle: AgentHandle): Promise<void> {
    // Intentionally empty — see the doc comment.
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
