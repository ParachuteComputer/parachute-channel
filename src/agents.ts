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

import { existsSync } from "node:fs";
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
  type SpawnAgentResult,
  type SpawnAgentDeps,
} from "./spawn-agent.ts";
import { resolveSpawnDeps, sessionsDir as defaultSessionsDir } from "./spawn-deps.ts";

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

/** The spawn/list/kill operations the daemon routes call. Injectable for tests. */
export interface AgentOps {
  /** Launch a sandboxed agent session from a validated spec. */
  spawn(spec: AgentSpec): Promise<SpawnAgentResult>;
  /** List the live agent tmux sessions. */
  list(): Promise<AgentInfo[]>;
  /** Kill an agent session by name (returns whether one existed). */
  kill(name: string): Promise<{ killed: boolean }>;
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
    agents.push({
      name,
      session: s.name,
      attached: s.attached,
      workspace,
      hasWorkspace: existsSync(join(workspace, ".mcp.json")),
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
  };
}
