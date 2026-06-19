/**
 * Agent management — the daemon-facing layer behind the web spawn UI
 * (`POST/GET /api/agents`) for the PROGRAMMATIC backend.
 *
 * Two live backends drive an agent (design 2026-06-16-pluggable-agent-backend.md +
 * 2026-06-18-channel-backend.md): `programmatic` (the daemon runs `claude -p` turns,
 * the default) and `channel` (a Claude Code session the operator connects handles the
 * turn). The `interactive` (tmux) backend was RETIRED 2026-06-19 (design
 * 2026-06-19-retire-interactive-backend.md) — its tmux SPAWNER + SESSION ADMIN were
 * parked to `src/_parked/interactive-spawn.ts` (future terminal/process-mgmt), and
 * the daemon no longer routes to it.
 *
 * What this module owns now:
 *   1. {@link buildSpecFromBody} — turn an untrusted JSON request body into a
 *      validated {@link AgentSpec} (or a {@link SpawnRequestError} mapped to 400).
 *      `backend` defaults to `"programmatic"`; only `"programmatic"` is accepted as
 *      a literal value (a `channel` agent is vault-native — define it as an
 *      `#agent/definition` note, not via this POST).
 *   2. {@link setupProgrammaticSpawn} — the spawn-time, non-turn setup for a
 *      programmatic agent (slug-guard, require a wake channel, resolve the Claude
 *      credential early, persist spec.json).
 */

import { statSync } from "node:fs";
import type {
  AgentSpec,
  AgentChannel,
  AgentVaultSpec,
  AgentMount,
} from "./sandbox/types.ts";
import {
  sessionWorkspace,
  persistSpec,
  readPersistedSpec,
} from "./spawn-agent.ts";
import { sessionsDir as defaultSessionsDir } from "./spawn-deps.ts";
import { normalizeChannel } from "./sandbox/types.ts";
import { resolveClaudeCredential } from "./credentials.ts";

/** Same slug shape spawn enforces — validated early so a bad name 400s. */
export const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

/**
 * One agent as the `/api/agents` list returns it — a PROGRAMMATIC or CHANNEL agent
 * (the only two live backends; interactive was retired 2026-06-19). Neither has a
 * tmux session, so `session` is the conventional `<name>-agent` display label,
 * `attached` is always false, and liveness rides in `status` (`idle` | `working` |
 * `queued:N`) rather than the old tmux `attached`/`mcp_sessions` flags. Built by
 * `listProgrammaticAgents` / `listChannelAgents` (daemon.ts). NEVER carries a secret.
 */
export interface AgentInfo {
  /** Agent slug. */
  name: string;
  /** Conventional `<name>-agent` display label (no tmux session backs it). */
  session: string;
  /** Always false (no tmux session to attach to). */
  attached: boolean;
  /** Per-session workspace dir (where spec.json lives). */
  workspace: string;
  /** Whether the session's workspace (with its spec.json) is present on disk. */
  hasWorkspace: boolean;
  /** Which backend drives this agent. */
  backend: "programmatic" | "channel";
  /** Live status — `idle` | `working` | `queued:N`. */
  status?: string;
  /** The wake channel this agent serves (present for channel agents). */
  channel?: string;
  /** The vault backing this agent's conversation, when known. */
  vault?: string;
  /** The system-prompt COMPOSITION mode when a per-channel system prompt is set. */
  systemPromptMode?: "append" | "replace";
  /** The agent's WORKING directory when the spec sets one (absent = private dir). */
  workingDir?: string;
}

/** A malformed spawn request body — the caller maps `.message` to a 400. */
export class SpawnRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRequestError";
  }
}

/**
 * Build a validated {@link AgentSpec} from an untrusted JSON request body. Throws
 * {@link SpawnRequestError} on any malformed field — the daemon maps it to a 400.
 *
 * Accepts channels as either `["name"]` (write) or `[{ name, access }]`. The
 * spawn slug guard is the authority on the name, but we check it here too so a bad
 * name fails before any dep resolution / mint side effect.
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
  // an ABSOLUTE path. Trimmed. A blank/whitespace-only value is treated as unset.
  // The credential-bearing private home (`.mcp.json` etc.) is NEVER this dir.
  if (b.workspace !== undefined && b.workspace !== null) {
    if (typeof b.workspace !== "string") {
      throw new SpawnRequestError("body.workspace must be a string (an absolute host path)");
    }
    const workspace = b.workspace.trim();
    if (workspace.length > 0) {
      if (!workspace.startsWith("/")) {
        throw new SpawnRequestError('body.workspace must be an absolute path (start with "/")');
      }
      // The working dir becomes the agent's cwd — it MUST pre-exist as a directory.
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

  // Backend selector. Only `"programmatic"` is accepted via this web spawn POST
  // (the default when omitted). `"channel"` is VAULT-NATIVE — define a channel agent
  // as a #agent/definition note (the create-agent UX for channel is phase 5), not via
  // this endpoint. `"interactive"` was RETIRED (design 2026-06-19-retire-interactive-
  // backend.md) — it is no longer a selectable backend anywhere.
  if (b.backend !== undefined && b.backend !== null) {
    if (b.backend !== "programmatic") {
      throw new SpawnRequestError(
        b.backend === "channel"
          ? "channel-backend agents are vault-native — define them as an #agent/definition note, not via this endpoint"
          : b.backend === "interactive"
            ? 'the "interactive" backend is retired — use "programmatic" (the default) or define a "channel" agent as a #agent/definition note'
            : 'body.backend must be "programmatic"',
      );
    }
    spec.backend = b.backend;
  } else {
    spec.backend = "programmatic";
  }

  // Per-channel system prompt — the operator gives the channel a role (design
  // 2026-06-16-channel-system-prompt.md). `systemPromptMode` decides composition with
  // CC's default: "append" (default) or "replace". A blank prompt is treated as unset.
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
  // Require ABSOLUTE paths — make the trust boundary explicit with a clean 400 here
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
 * The redacted result a PROGRAMMATIC spawn returns to the wire — there is no tmux
 * session and no per-launch minted-token set (the programmatic backend mints the
 * vault token per-turn, not at spawn), so this is a thin "registered" acknowledgment.
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
 * Validate + set up a PROGRAMMATIC agent spawn (design 2026-06-16 step 2). It does
 * the spawn-time, NON-turn work: slug-guard the name, require a wake channel, resolve
 * the Claude credential EARLY (a missing one throws {@link CredentialNotConfiguredError}
 * BEFORE registering — so a programmatic agent never registers without auth), and
 * persist spec.json (carrying `backend: "programmatic"`) so a daemon restart
 * re-registers it on boot.
 *
 * It does NOT itself register the agent in the live registry or mint any token — the
 * daemon owns the {@link ProgrammaticAgentRegistry} instance and calls
 * `registry.register(spec)` after this returns.
 *
 * `resolveClaudeToken` + `sessionsDirPath` are injectable so tests run hermetically.
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
