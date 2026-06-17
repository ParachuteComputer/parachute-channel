/**
 * Agent management operations — the daemon-facing layer behind the web spawn UI
 * (`POST/GET/DELETE /api/agents`) and the management page (`src/agents-ui.ts`).
 *
 * This is the SAME launch path the operator CLI (`scripts/spawn-agent.ts`) uses —
 * it builds an {@link AgentSpec} and calls {@link spawnAgent} with the real deps
 * ({@link resolveSpawnDeps}). The web is just another caller; every least-
 * privilege decision still lives in `spawnAgent`/`sandbox/*`. The web flow adds
 * three things the CLI didn't need:
 *
 *   1. {@link buildSpecFromBody} — turn an untrusted JSON request body into a
 *      validated {@link AgentSpec} (or a {@link SpawnRequestError} mapped to 400).
 *   2. {@link redactSpawnResult} — surface scopes/audiences per resource but
 *      NEVER the minted token values (the result carries them; the wire must not).
 *   3. list + kill over the live tmux sessions ({@link AgentOps}).
 *
 * The tmux side is behind a small injectable seam ({@link TmuxAdmin}) so the
 * list/kill logic is unit-testable without a real tmux server.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSpec,
  AgentChannel,
  AgentVaultSpec,
  AgentMount,
} from "./sandbox/types.ts";
import {
  spawnAgent,
  sessionName,
  sessionWorkspace,
  persistSpec,
  readPersistedSpec,
  type SpawnAgentResult,
  type SpawnAgentDeps,
} from "./spawn-agent.ts";
import { resolveSpawnDeps, sessionsDir as defaultSessionsDir } from "./spawn-deps.ts";
import { normalizeChannel } from "./sandbox/types.ts";
import { resolveClaudeCredential } from "./credentials.ts";

/** The `-agent` suffix tmux sessions launched by `spawnAgent` carry. */
const AGENT_SESSION_SUFFIX = "-agent";

/** Same slug shape `spawnAgent` enforces — validated early so a bad name 400s. */
export const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

/** A malformed spawn request body — the caller maps `.message` to a 400. */
export class SpawnRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRequestError";
  }
}

/** One running (or recently-launched) agent session, as the page lists them. */
export interface AgentInfo {
  /** Agent slug (the tmux session name minus the `-agent` suffix). */
  name: string;
  /** tmux session name (`<name>-agent`). */
  session: string;
  /** Whether a client is currently attached to the tmux session. */
  attached: boolean;
  /** Per-session workspace dir (may not exist if the session predates this build). */
  workspace: string;
  /** Whether the session's workspace (with its .mcp.json) is present on disk. */
  hasWorkspace: boolean;
  /**
   * Which backend drives this agent. `"interactive"` (the default — a tmux session)
   * or `"programmatic"` (no tmux; on-demand `claude -p` turns). The list merges
   * interactive tmux sessions + registered programmatic agents (design 2026-06-16).
   */
  backend: "interactive" | "programmatic";
  /**
   * Programmatic-only live status — `idle` | `working` | `queued:N` (N = pending).
   * Absent for interactive agents (their liveness is the tmux `attached` flag +
   * /health's `mcp_sessions`). Present for programmatic agents in place of those.
   */
  status?: string;
  /**
   * The agent's system-prompt COMPOSITION mode when a per-channel system prompt is
   * set (design 2026-06-16-channel-system-prompt.md) — `"append"` (kept CC's base +
   * the role) or `"replace"` (full custom persona). Absent = no system prompt (CC's
   * default, untouched). The prompt TEXT itself is deliberately NOT surfaced here
   * (it can be long / role-sensitive) — only that one is set + how it composes.
   */
  systemPromptMode?: "append" | "replace";
  /**
   * The agent's WORKING directory when the spec sets one (design
   * 2026-06-16-agent-filesystem-and-sharing.md — the working-directory axis): the
   * shared host path it operates from (its cwd + rw working-root). Absent = the
   * agent works in its private session dir (today's default). This is the WORKING
   * dir, NOT the private `workspace` field above (which is always the per-agent
   * session dir on disk).
   */
  workingDir?: string;
}

/** A redacted mint summary — scope + audience + expiry, NEVER the token value. */
export interface RedactedToken {
  /** Resource key (channel name / `vault:<name>` / other-mcp name). */
  resource: string;
  /** The granted scope string. */
  scope: string;
  /** ISO expiry. */
  expiresAt: string;
}

/** The redacted spawn result the web endpoint returns (no token values). */
export interface RedactedSpawnResult {
  session: string;
  workspace: string;
  alreadyRunning: boolean;
  /** One entry per minted resource — scope/expiry only, token redacted. */
  tokens: RedactedToken[];
  /** The MCP server entry keys wired into the session (names only). */
  mcpServers: string[];
  /** Filesystem read scope the session launched under. */
  filesystem: "workspace" | "full";
  /** Network posture the session launched under. */
  network: "open" | "restricted";
  /** Egress allowlist baked into the sandbox (empty when network is open). */
  egress: string[];
}

/** The redacted result a per-session restart returns. */
export interface RedactedRestartResult extends RedactedSpawnResult {
  /** Whether a previous live session was killed (false = it wasn't running). */
  killed: boolean;
}

/** The spawn/list/kill/restart operations the daemon routes call. Injectable for tests. */
export interface AgentOps {
  /** Launch a sandboxed agent session from a validated spec. */
  spawn(spec: AgentSpec): Promise<SpawnAgentResult>;
  /** List the live agent tmux sessions. */
  list(): Promise<AgentInfo[]>;
  /** Kill an agent session by name (returns whether one existed). */
  kill(name: string): Promise<{ killed: boolean }>;
  /**
   * PER-SESSION restart: kill `<name>-agent`, then re-spawn from the persisted spec
   * (re-resolving env + the Claude credential), so a newly-set credential applies.
   * Returns the redacted spawn result + whether a prior session was killed.
   */
  restart(name: string): Promise<RedactedRestartResult>;
}

/** A tmux admin seam — real impl shells out to tmux; tests inject a recorder. */
export interface TmuxAdmin {
  /** List sessions as `{ name, attached }`. Empty when no tmux server runs. */
  listSessions(): Promise<{ name: string; attached: boolean }[]>;
  /** Kill a session by exact name; returns whether it existed. */
  killSession(name: string): Promise<boolean>;
}

/**
 * Parse `tmux list-sessions -F '#{session_name} #{session_attached}'` stdout into
 * `{ name, attached }[]`. Each line is `<name> <attachedCount>`; attached>0 → true.
 * Robust to blank trailing lines. Pure — the real probe + this parser are split so
 * the parse is unit-tested without a tmux server.
 */
export function parseTmuxSessions(stdout: string): { name: string; attached: boolean }[] {
  const out: { name: string; attached: boolean }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Split on the LAST space so a (disallowed-but-defensive) spaced name still
    // parses its trailing attached count.
    const idx = trimmed.lastIndexOf(" ");
    if (idx < 0) {
      out.push({ name: trimmed, attached: false });
      continue;
    }
    const name = trimmed.slice(0, idx);
    const attachedRaw = trimmed.slice(idx + 1);
    out.push({ name, attached: parseInt(attachedRaw, 10) > 0 });
  }
  return out;
}

/**
 * Map raw tmux sessions to {@link AgentInfo}, keeping only `*-agent` sessions and
 * stripping the suffix to the agent slug. Pure over its inputs (the sessions list
 * + the sessions dir) so it's unit-testable.
 */
export function agentInfoFromSessions(
  sessions: { name: string; attached: boolean }[],
  sessionsDirPath: string,
): AgentInfo[] {
  const agents: AgentInfo[] = [];
  for (const s of sessions) {
    if (!s.name.endsWith(AGENT_SESSION_SUFFIX)) continue;
    const name = s.name.slice(0, -AGENT_SESSION_SUFFIX.length);
    if (name.length === 0) continue;
    const workspace = sessionWorkspace(sessionsDirPath, name);
    // Surface the system-prompt composition mode (not the text) from the persisted
    // spec when one is set — so the list shows the agent carries a role.
    const persisted = readPersistedSpec(workspace);
    const hasPrompt = typeof persisted?.systemPrompt === "string" && persisted.systemPrompt.length > 0;
    // Surface the working dir only when it's set AND still present on disk — an
    // operator who deleted the dir post-spawn shouldn't see a dead-path badge
    // (mirrors how `hasWorkspace` gates on existence rather than the bare path).
    const hasWorkingDir =
      typeof persisted?.workspace === "string" &&
      persisted.workspace.length > 0 &&
      existsSync(persisted.workspace);
    agents.push({
      name,
      session: s.name,
      attached: s.attached,
      workspace,
      hasWorkspace: existsSync(join(workspace, ".mcp.json")),
      backend: "interactive",
      ...(hasPrompt ? { systemPromptMode: persisted!.systemPromptMode ?? "append" } : {}),
      ...(hasWorkingDir ? { workingDir: persisted!.workspace } : {}),
    });
  }
  agents.sort((a, b) => a.name.localeCompare(b.name));
  return agents;
}

/** The real tmux admin — shells out via Bun.spawn. */
export function realTmuxAdmin(spawnFn: typeof Bun.spawn = Bun.spawn): TmuxAdmin {
  return {
    async listSessions() {
      const proc = spawnFn(
        ["tmux", "list-sessions", "-F", "#{session_name} #{session_attached}"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const code = await proc.exited;
      // tmux exits non-zero with "no server running" when there are zero sessions
      // — that's an empty list, not an error.
      if (code !== 0) return [];
      const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      return parseTmuxSessions(stdout);
    },
    async killSession(name: string) {
      const proc = spawnFn(["tmux", "kill-session", "-t", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
  };
}

/**
 * Build a validated {@link AgentSpec} from an untrusted JSON request body. Throws
 * {@link SpawnRequestError} on any malformed field — the daemon maps it to a 400.
 * Mirrors the CLI's parse semantics (channels default to write; the first channel
 * is the wake channel) but over JSON rather than flags.
 *
 * Accepts channels as either `["name"]` (write) or `[{ name, access }]`. The
 * `spawnAgent` slug guard is the authority on the name, but we check it here too
 * so a bad name fails before any dep resolution / mint side effect.
 */
export function buildSpecFromBody(body: unknown): AgentSpec {
  if (!body || typeof body !== "object") {
    throw new SpawnRequestError("request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  const name = b.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new SpawnRequestError("body.name (non-empty string) is required");
  }
  if (!AGENT_NAME_SLUG.test(name)) {
    throw new SpawnRequestError(
      `body.name "${name}" must be a slug (alphanumeric, dash, underscore only)`,
    );
  }

  if (!Array.isArray(b.channels) || b.channels.length === 0) {
    throw new SpawnRequestError("body.channels must be a non-empty array (the first is the wake channel)");
  }
  const channels: AgentChannel[] = b.channels.map((raw, i) => parseChannelEntry(raw, i));

  const spec: AgentSpec = { name, channels };

  if (b.vault !== undefined && b.vault !== null) {
    spec.vault = parseVaultEntry(b.vault);
  }

  if (b.filesystem !== undefined && b.filesystem !== null) {
    if (b.filesystem !== "workspace" && b.filesystem !== "full") {
      throw new SpawnRequestError('body.filesystem must be "workspace" or "full"');
    }
    spec.filesystem = b.filesystem;
  }

  if (b.network !== undefined && b.network !== null) {
    if (b.network !== "open" && b.network !== "restricted") {
      throw new SpawnRequestError('body.network must be "open" or "restricted"');
    }
    spec.network = b.network;
  }

  if (b.egress !== undefined && b.egress !== null) {
    if (!Array.isArray(b.egress)) {
      throw new SpawnRequestError("body.egress must be an array of host strings");
    }
    const egress = b.egress
      .map((h) => {
        if (typeof h !== "string") throw new SpawnRequestError("body.egress entries must be strings");
        return h.trim();
      })
      .filter((h) => h.length > 0);
    // Additional allowed hosts — only take effect under `network: "restricted"`
    // (open = fully open network); harmless to carry otherwise.
    if (egress.length > 0) spec.egress = egress;
  }

  if (b.mounts !== undefined && b.mounts !== null) {
    if (!Array.isArray(b.mounts)) {
      throw new SpawnRequestError("body.mounts must be an array");
    }
    const mounts = b.mounts.map((raw, i) => parseMountEntry(raw, i));
    if (mounts.length > 0) spec.mounts = mounts;
  }

  // Working directory — the WORKING-DIRECTORY axis (design
  // 2026-06-16-agent-filesystem-and-sharing.md). When set, this absolute host path
  // is the agent's cwd + an rw working-root; it's shareable across agents. Require
  // an ABSOLUTE path (mirrors parseMountEntry's guard — a relative path would
  // resolve against the daemon's cwd in surprising ways; the trust boundary stays
  // explicit). Trimmed. A blank/whitespace-only value is treated as unset (today's
  // private-dir cwd). The credential-bearing private home (`.mcp.json` etc.) is
  // NEVER this dir — it stays per-agent under sessions/<name>/.
  if (b.workspace !== undefined && b.workspace !== null) {
    if (typeof b.workspace !== "string") {
      throw new SpawnRequestError("body.workspace must be a string (an absolute host path)");
    }
    const workspace = b.workspace.trim();
    if (workspace.length > 0) {
      if (!workspace.startsWith("/")) {
        throw new SpawnRequestError('body.workspace must be an absolute path (start with "/")');
      }
      // The working dir becomes the agent's cwd — it MUST pre-exist as a directory,
      // or the spawn would boot the agent into a missing dir (tmux `-c` / Bun.spawn
      // `cwd` fault) with a confusing downstream error. A clean 400 at parse time is
      // friendlier than that runtime failure. This endpoint is agent:admin-gated,
      // so the operator owns the path they pass; we only assert it's a real dir.
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(workspace);
      } catch {
        throw new SpawnRequestError(
          `body.workspace "${workspace}" does not exist — the working directory must be a real ` +
            `directory on disk (the agent's cwd).`,
        );
      }
      if (!st.isDirectory()) {
        throw new SpawnRequestError(`body.workspace "${workspace}" is not a directory.`);
      }
      spec.workspace = workspace;
    }
  }

  // Backend selector — the pluggable agent backend (design 2026-06-16). A NEW
  // request that OMITS `backend` now defaults to `"programmatic"` (Aaron's gating
  // decision 2026-06-16): programmatic is the reliable primary path (no
  // deaf-on-restart / reconnect class); `"interactive"` (the original tmux path) is
  // the buggier opt-in, gated behind "Advanced" in the UI but still fully selectable
  // by passing `backend: "interactive"` explicitly here. The selected backend is
  // persisted in spec.json so a restart re-registers it.
  //
  // CRITICAL — this NEW-request default is DISTINCT from the PERSISTED-spec default:
  // a stored spec.json with NO `backend` field predates the field and is an
  // INTERACTIVE agent ({@link interpretPersistedBackend}). Do NOT unify these — a
  // missing field means "programmatic" for a fresh request but "interactive" for a
  // file on disk, so existing interactive agents are never silently migrated.
  if (b.backend !== undefined && b.backend !== null) {
    if (b.backend !== "interactive" && b.backend !== "programmatic") {
      throw new SpawnRequestError('body.backend must be "interactive" or "programmatic"');
    }
    spec.backend = b.backend;
  } else {
    spec.backend = "programmatic";
  }

  // Per-channel system prompt — the operator gives the channel a role (design
  // 2026-06-16-channel-system-prompt.md). It is passed (file-backed) on every
  // `claude -p` turn. `systemPromptMode` decides composition with CC's default:
  // "append" (default — keep CC's base + add the role) or "replace" (full custom
  // persona). The mode is validated to the two allowed values; anything else 400s.
  // A blank/whitespace-only prompt is treated as unset (no flag). The mode is only
  // recorded when there's a prompt to qualify (an orphan mode with no prompt is a
  // no-op, so we drop it to keep the spec minimal).
  if (b.systemPrompt !== undefined && b.systemPrompt !== null) {
    if (typeof b.systemPrompt !== "string") {
      throw new SpawnRequestError("body.systemPrompt must be a string");
    }
  }
  if (b.systemPromptMode !== undefined && b.systemPromptMode !== null) {
    if (b.systemPromptMode !== "append" && b.systemPromptMode !== "replace") {
      throw new SpawnRequestError('body.systemPromptMode must be "append" or "replace"');
    }
  }
  const promptText = typeof b.systemPrompt === "string" ? b.systemPrompt.trim() : "";
  if (promptText.length > 0) {
    spec.systemPrompt = promptText;
    // Default mode is "append" — keep CC's capable base, add the channel's role.
    spec.systemPromptMode = b.systemPromptMode === "replace" ? "replace" : "append";
  }

  return spec;
}

function parseChannelEntry(raw: unknown, i: number): AgentChannel {
  if (typeof raw === "string") {
    if (raw.length === 0) throw new SpawnRequestError(`body.channels[${i}] is an empty string`);
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    throw new SpawnRequestError(`body.channels[${i}] must be a string or { name, access }`);
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.name !== "string" || c.name.length === 0) {
    throw new SpawnRequestError(`body.channels[${i}].name (non-empty string) is required`);
  }
  if (c.access !== undefined && c.access !== "read" && c.access !== "write") {
    throw new SpawnRequestError(`body.channels[${i}].access must be "read" or "write"`);
  }
  return c.access === undefined
    ? { name: c.name }
    : { name: c.name, access: c.access as "read" | "write" };
}

function parseVaultEntry(raw: unknown): AgentVaultSpec {
  if (!raw || typeof raw !== "object") {
    throw new SpawnRequestError("body.vault must be { name, access, tags? }");
  }
  const v = raw as Record<string, unknown>;
  if (typeof v.name !== "string" || v.name.length === 0) {
    throw new SpawnRequestError("body.vault.name (non-empty string) is required");
  }
  if (v.access !== "read" && v.access !== "write" && v.access !== "admin") {
    throw new SpawnRequestError('body.vault.access must be "read", "write", or "admin"');
  }
  const spec: AgentVaultSpec = { name: v.name, access: v.access as "read" | "write" | "admin" };
  if (v.tags !== undefined && v.tags !== null) {
    if (!Array.isArray(v.tags)) throw new SpawnRequestError("body.vault.tags must be an array of strings");
    const tags = v.tags
      .map((t) => {
        if (typeof t !== "string") throw new SpawnRequestError("body.vault.tags entries must be strings");
        return t.trim();
      })
      .filter((t) => t.length > 0);
    if (tags.length > 0) spec.tags = tags;
  }
  return spec;
}

function parseMountEntry(raw: unknown, i: number): AgentMount {
  if (!raw || typeof raw !== "object") {
    throw new SpawnRequestError(`body.mounts[${i}] must be { hostPath, mountPath, mode, shared? }`);
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.hostPath !== "string" || m.hostPath.length === 0) {
    throw new SpawnRequestError(`body.mounts[${i}].hostPath (non-empty string) is required`);
  }
  if (typeof m.mountPath !== "string" || m.mountPath.length === 0) {
    throw new SpawnRequestError(`body.mounts[${i}].mountPath (non-empty string) is required`);
  }
  // Require ABSOLUTE paths. The sandbox engine is the authoritative confinement,
  // but a relative `hostPath` would resolve against the session's cwd in
  // surprising ways — make the trust boundary explicit with a clean 400 here
  // rather than a confusing sandbox behavior downstream.
  //
  // NOTE: a mount's hostPath is added to `allowRead`, which OVERRIDES the
  // `filesystem: "workspace"` home-tree deny. So an operator who mounts a
  // home-tree path (e.g. ~/.parachute) deliberately re-opens that path to the
  // agent even under the scoped default. That's intentional (this endpoint is
  // agent:admin-gated; the operator is choosing it), not an injection bypass —
  // but weigh it before mounting sensitive home-tree paths.
  if (!m.hostPath.startsWith("/")) {
    throw new SpawnRequestError(`body.mounts[${i}].hostPath must be an absolute path (start with "/")`);
  }
  if (!m.mountPath.startsWith("/")) {
    throw new SpawnRequestError(`body.mounts[${i}].mountPath must be an absolute path (start with "/")`);
  }
  if (m.mode !== "ro" && m.mode !== "rw") {
    throw new SpawnRequestError(`body.mounts[${i}].mode must be "ro" or "rw"`);
  }
  const mount: AgentMount = {
    hostPath: m.hostPath,
    mountPath: m.mountPath,
    mode: m.mode as "ro" | "rw",
  };
  if (m.shared !== undefined && m.shared !== null) {
    if (typeof m.shared !== "string" || m.shared.length === 0) {
      throw new SpawnRequestError(`body.mounts[${i}].shared must be a non-empty string`);
    }
    mount.shared = m.shared;
  }
  return mount;
}

/**
 * Redact a {@link SpawnAgentResult} for the wire: scopes + audiences + expiries
 * per resource, the MCP server names, and the egress allowlist — but NEVER the
 * minted token values (the result inlines them; the response must not).
 */
export function redactSpawnResult(result: SpawnAgentResult): RedactedSpawnResult {
  const tokens: RedactedToken[] = Object.entries(result.tokens).map(([resource, minted]) => ({
    resource,
    scope: minted.scope,
    expiresAt: minted.expiresAt,
  }));
  let mcpServers: string[] = [];
  try {
    const parsed = JSON.parse(result.mcpConfigJson || "{}") as { mcpServers?: Record<string, unknown> };
    mcpServers = Object.keys(parsed.mcpServers ?? {});
  } catch {
    mcpServers = [];
  }
  // network: allowedDomains is present only when restricted (open omits it).
  const allowed = result.wrapped.config.network.allowedDomains as string[] | undefined;
  // filesystem: scoped reads carry a home-tree denyRead; "full" leaves it empty.
  const scopedReads = (result.wrapped.config.filesystem.denyRead ?? []).length > 0;
  return {
    session: result.session,
    workspace: result.workspace,
    alreadyRunning: result.alreadyRunning,
    tokens,
    mcpServers,
    filesystem: scopedReads ? "workspace" : "full",
    network: allowed === undefined ? "open" : "restricted",
    egress: allowed ?? [],
  };
}

/**
 * Build the real {@link AgentOps} from the environment — `spawn` calls
 * {@link spawnAgent} with {@link resolveSpawnDeps} (resolved lazily PER spawn so a
 * credential/token set via the API takes effect without a daemon restart), `list`
 * + `kill` go through the real tmux admin. `depsFactory` + `tmux` are injectable
 * so tests exercise the routes without a hub, a sandbox, or a tmux server.
 */
export function createRealAgentOps(opts?: {
  depsFactory?: () => SpawnAgentDeps;
  tmux?: TmuxAdmin;
  sessionsDirPath?: string;
}): AgentOps {
  const depsFactory = opts?.depsFactory ?? resolveSpawnDeps;
  const tmux = opts?.tmux ?? realTmuxAdmin();
  const dir = opts?.sessionsDirPath ?? defaultSessionsDir();
  return {
    async spawn(spec) {
      // Deps resolved per-spawn so a credential rotate / operator-token change is
      // picked up live (dynamic-read discipline) — and so a missing operator token
      // surfaces as a clean error at spawn time, not at daemon boot.
      return spawnAgent(spec, depsFactory());
    },
    async list() {
      return agentInfoFromSessions(await tmux.listSessions(), dir);
    },
    async kill(name) {
      if (!AGENT_NAME_SLUG.test(name)) {
        throw new SpawnRequestError(
          `agent name "${name}" must be a slug (alphanumeric, dash, underscore only)`,
        );
      }
      const killed = await tmux.killSession(sessionName(name));
      return { killed };
    },
    async restart(name) {
      if (!AGENT_NAME_SLUG.test(name)) {
        throw new SpawnRequestError(
          `agent name "${name}" must be a slug (alphanumeric, dash, underscore only)`,
        );
      }
      // Recover the original launch params from the persisted spec (the live tmux
      // session carries none of them; the workspace's .mcp.json inlines minted
      // tokens, not a clean spec). No spec → can't faithfully reproduce → a clear
      // error (the operator kills + re-spawns from the form instead).
      const workspace = sessionWorkspace(dir, name);
      const spec = readPersistedSpec(workspace);
      if (!spec) {
        throw new SpawnRequestError(
          `cannot restart agent "${name}": no persisted spec at ${workspace}/spec.json ` +
            `(it predates spawn-spec persistence, or was never spawned through this daemon). ` +
            `Kill it and spawn a fresh session from the Agents page.`,
        );
      }
      // Kill the existing session FIRST — spawnAgent is idempotent (a live session is
      // a no-op), so without the kill a restart wouldn't re-source env. killSession is
      // a no-op for a missing session (the restart still re-spawns), so a restart also
      // doubles as "bring back a crashed/stopped session from its spec."
      const killed = await tmux.killSession(sessionName(name));
      // Re-spawn with FRESHLY-resolved deps — the env store + Claude credential are
      // re-read here, so a credential set just before this restart is now applied. A
      // fresh spawn (NOT `claude -c`) is deliberate: see the daemon route's note on
      // the context-loss tradeoff. The MCP/channel reconnect is inherent — the new
      // session re-establishes its channel MCP entries from the regenerated config.
      const result = await spawnAgent(spec, depsFactory());
      return { ...redactSpawnResult(result), killed };
    },
  };
}

/**
 * The redacted result a PROGRAMMATIC spawn returns to the wire — there is no tmux
 * session and no per-launch minted-token set (the programmatic backend mints the
 * vault token per-turn, not at spawn), so this is a thin "registered" acknowledgment
 * mirroring the interactive result's non-secret fields.
 */
export interface ProgrammaticSpawnResult {
  /** The agent slug. */
  name: string;
  /** The wake channel the agent serves. */
  channel: string;
  /** Always "programmatic" — lets the page render the right status affordances. */
  backend: "programmatic";
  /** Per-session workspace dir (where .mcp.json is written per-turn + spec.json lives). */
  workspace: string;
  /** Whether an agent was already registered under this name (idempotent replace). */
  alreadyRunning: boolean;
}

/**
 * Validate + set up a PROGRAMMATIC agent spawn — the no-tmux counterpart to
 * {@link spawnAgent} (design 2026-06-16 step 2). It does the spawn-time, NON-turn
 * work: slug-guard the name, require a wake channel, resolve the Claude credential
 * EARLY (a missing one throws {@link CredentialNotConfiguredError} BEFORE registering
 * — so a programmatic agent never registers without auth, exactly like the
 * interactive spawn never launches without it), and persist spec.json (carrying
 * `backend: "programmatic"`) so a daemon restart re-registers it on boot.
 *
 * It does NOT itself register the agent in the live registry or mint any token — the
 * daemon owns the {@link ProgrammaticAgentRegistry} instance and calls
 * `registry.register(spec)` after this returns; the per-turn workspace/.mcp.json/mint
 * are the backend's per-`deliver` job. Returns the (non-secret) workspace + channel.
 *
 * `resolveClaudeToken` + `sessionsDirPath` are injectable so tests run hermetically
 * (no real credential store, a temp sessions dir).
 */
export function setupProgrammaticSpawn(
  spec: AgentSpec,
  opts?: {
    resolveClaudeToken?: (channel: string) => string;
    sessionsDirPath?: string;
  },
): ProgrammaticSpawnResult {
  if (!AGENT_NAME_SLUG.test(spec.name)) {
    throw new SpawnRequestError(
      `agent name "${spec.name}" must be a slug (alphanumeric, dash, underscore only)`,
    );
  }
  if (spec.channels.length === 0) {
    throw new SpawnRequestError(`spec "${spec.name}" declares no channels (the first is the wake channel)`);
  }
  const channel = normalizeChannel(spec.channels[0]!).name;
  const dir = opts?.sessionsDirPath ?? defaultSessionsDir();
  const workspace = sessionWorkspace(dir, spec.name);

  // Resolve the Claude credential EARLY — a missing one throws
  // CredentialNotConfiguredError, which the daemon maps to a 400 with the fix, so a
  // programmatic agent never registers (and never runs a turn) without auth.
  const resolveToken = opts?.resolveClaudeToken ?? ((ch: string) => resolveClaudeCredential(ch));
  resolveToken(channel);

  // Was a spec already persisted (an idempotent re-spawn)? Persist the (possibly
  // updated) spec carrying backend:"programmatic" so a restart re-registers it.
  const prior = readPersistedSpec(workspace);
  persistSpec(workspace, { ...spec, backend: "programmatic" });

  return {
    name: spec.name,
    channel,
    backend: "programmatic",
    workspace,
    alreadyRunning: prior !== null,
  };
}
