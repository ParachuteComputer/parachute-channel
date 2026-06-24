/**
 * PARKED — the interactive (tmux) agent SPAWNER + tmux session admin.
 *
 * This is NOT a live agent backend. The `interactive` backend was retired
 * 2026-06-19 (design `design/2026-06-19-retire-interactive-backend.md`): the
 * `channel` backend supersedes the human-driven-Claude-Code need it hedged,
 * without the tmux/send-keys/idle-wake fragility. The daemon no longer imports
 * or routes to any of this code.
 *
 * Per Aaron's note in the channel-backend design ("Retiring interactive"), the
 * PTY/terminal-spawning machinery is PARKED, not deleted: it gets repurposed
 * later (lower priority) into proper TERMINAL / PROCESS MANAGEMENT in the
 * Parachute interface — a general capability (spin up a Claude Code session, or
 * anything), decoupled from the agent backend.
 *
 * What's here:
 *   - the tmux SPAWNER: `spawnAgent` + its argv/launch-script/dev-channels-prompt
 *     helpers + the `TmuxLauncher`/`realTmuxLauncher` seam + the deps/result types;
 *   - the tmux SESSION ADMIN: `AgentOps`/`TmuxAdmin`/`createRealAgentOps` +
 *     `parseTmuxSessions`/`agentInfoFromSessions`/`realTmuxAdmin` + `AgentInfo`.
 *
 * What it still SHARES from the live tree (imported, not copied) — the sandbox/
 * filesystem/env helpers that the PROGRAMMATIC backend also uses, which stayed in
 * `src/spawn-agent.ts`: `wrapArgvInSandbox`, `seedAgentHome`, `buildAgentChildEnv`,
 * `resolveAgentCwd`, `sessionWorkspace`, `persistSpec`, `readPersistedSpec`,
 * `shellJoin`. Parking the spawner did NOT fork those.
 *
 * If/when this is revived as terminal-mgmt, it should be lifted out of the agent
 * module entirely (a `process`/`terminal` capability), not re-wired as a backend.
 */

import { existsSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSpec,
  AgentChannel,
  AgentVaultSpec,
  AgentMount,
} from "../sandbox/types.ts";
import { normalizeChannel } from "../sandbox/types.ts";
import type { SandboxEngine, WrappedCommand } from "../sandbox/index.ts";
import {
  buildAgentChildEnv,
  mergeSandboxLaunchEnv,
  resolveAgentCwd,
  seedAgentHome,
  sessionWorkspace,
  persistSpec,
  readPersistedSpec,
  shellJoin,
  wrapArgvInSandbox,
  type SpawnAgentBaseDeps,
} from "../spawn-agent.ts";
import {
  buildAgentMcpConfigJson,
  channelEntryKey,
  type ChannelMcpEntry,
  type VaultMcpEntry,
  type OtherMcpEntry,
} from "../agent-mcp-config.ts";
import {
  mintScopedToken,
  agentScope,
  vaultScope,
  type MintTokenDeps,
  type MintResult,
} from "../mint-token.ts";
import {
  resolveClaudeCredential,
  resolveChannelEnv,
} from "../credentials.ts";

/** Same slug shape spawnAgent enforces. */
const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

/** The `-agent` suffix tmux sessions launched by `spawnAgent` carry. */
const AGENT_SESSION_SUFFIX = "-agent";

/** A malformed spawn request body — the caller maps `.message` to a 400. */
export class SpawnRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnRequestError";
  }
}

// ===========================================================================
// The tmux SPAWNER (was spawn-agent.ts).
// ===========================================================================

/** A tmux launcher seam — real impl spawns tmux; tests inject a recorder. */
export interface TmuxLauncher {
  newSession(opts: {
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
    scriptDir?: string;
  }): Promise<void>;
  hasSession(name: string): Promise<boolean>;
  confirmDevChannelsPrompt(session: string): Promise<"confirmed" | "already-running" | "timeout">;
}

/** Deps for the interactive {@link spawnAgent} — the shared base + the tmux launcher. */
export interface SpawnAgentDeps extends SpawnAgentBaseDeps {
  /** tmux launcher (tests inject a recorder). */
  tmux: TmuxLauncher;
}

export interface SpawnAgentResult {
  session: string;
  workspace: string;
  tokens: Record<string, MintResult>;
  mcpConfigJson: string;
  wrapped: WrappedCommand;
  alreadyRunning: boolean;
  devChannelsPrompt?: "confirmed" | "already-running" | "timeout";
}

/** tmux session name for a spec — matches launch-session.sh's `<name>-agent`. */
export function sessionName(specName: string): string {
  return `${specName}-agent`;
}

/**
 * Build the `claude` invocation argv (pre-sandbox-wrap). Interactive `claude`
 * (NOT `claude -p`) with the strict, multi-entry MCP config + the dev-channels
 * flag for the first channel. `--strict-mcp-config` closes the MCP surface.
 */
export function buildAgentClaudeArgs(opts: {
  mcpConfigPath: string;
  firstChannelEntryKey: string;
  claudeBin?: string;
  systemPromptFile?: string;
  systemPromptMode?: "append" | "replace";
}): string[] {
  const bin = opts.claudeBin ?? "claude";
  const argv = [
    bin,
    "--dangerously-skip-permissions",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    `--dangerously-load-development-channels=server:${opts.firstChannelEntryKey}`,
  ];
  if (opts.systemPromptFile) {
    const flag = opts.systemPromptMode === "replace" ? "--system-prompt-file" : "--append-system-prompt-file";
    argv.push(flag, opts.systemPromptFile);
  }
  return argv;
}

/**
 * Spawn a sandboxed interactive agent session from a spec. Idempotent: an
 * existing tmux session is a no-op (returns `alreadyRunning: true`).
 */
export async function spawnAgent(
  spec: AgentSpec,
  deps: SpawnAgentDeps,
): Promise<SpawnAgentResult> {
  if (!AGENT_NAME_SLUG.test(spec.name)) {
    throw new Error(
      `spawnAgent: spec name "${spec.name}" must be a slug (alphanumeric, dash, underscore only)`,
    );
  }

  const session = sessionName(spec.name);
  const workspace = sessionWorkspace(deps.sessionsDir, spec.name);

  if (await deps.tmux.hasSession(session)) {
    return {
      session,
      workspace,
      tokens: {},
      mcpConfigJson: "",
      wrapped: { argv: [], env: {}, config: { network: { allowedDomains: [], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } } },
      alreadyRunning: true,
    };
  }

  if (spec.channels.length === 0) {
    throw new Error(`spawnAgent: spec "${spec.name}" declares no channels`);
  }

  const wakeChannel = normalizeChannel(spec.channels[0]!).name;
  const resolveToken = deps.resolveClaudeToken ?? ((ch: string) => resolveClaudeCredential(ch));
  const claudeOauthToken = resolveToken(wakeChannel);

  const resolveEnv = deps.resolveChannelEnv ?? ((ch: string) => resolveChannelEnv(ch));
  const channelEnv = resolveEnv(wakeChannel);

  const mintDeps: MintTokenDeps = {
    hubOrigin: deps.hubOrigin,
    managerBearer: deps.managerBearer,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  };

  const tokens: Record<string, MintResult> = {};
  const channelEntries: ChannelMcpEntry[] = [];
  for (const rawChannel of spec.channels) {
    const { name: channel, access } = normalizeChannel(rawChannel);
    const minted = await mintScopedToken(
      { scope: agentScope({ write: access === "write" }), audience: "agent" },
      mintDeps,
    );
    tokens[channel] = minted;
    channelEntries.push({ channel, token: minted.token });
  }

  let vaultArg: { url: string; entry: VaultMcpEntry } | undefined;
  if (spec.vault) {
    const v = spec.vault;
    const minted = await mintScopedToken(
      {
        scope: vaultScope(v.name, v.access),
        audience: `vault.${v.name}`,
        ...(v.tags && v.tags.length > 0 ? { permissions: { scoped_tags: v.tags } } : {}),
      },
      mintDeps,
    );
    tokens[`vault:${v.name}`] = minted;
    vaultArg = {
      url: deps.vaultUrl ?? deps.hubOrigin,
      entry: { name: v.name, token: minted.token },
    };
  }

  const otherEntries: OtherMcpEntry[] = [];
  for (const o of spec.otherMcps ?? []) {
    let token: string | undefined;
    if (o.scope) {
      const minted = await mintScopedToken(
        { scope: o.scope, ...(o.audience ? { audience: o.audience } : {}) },
        mintDeps,
      );
      tokens[o.name] = minted;
      token = minted.token;
    }
    otherEntries.push({ name: o.name, url: o.url, ...(token ? { token } : {}) });
  }

  const mcpConfigJson = buildAgentMcpConfigJson({
    channelUrl: deps.channelUrl,
    channels: channelEntries,
    ...(vaultArg ? { vault: vaultArg } : {}),
    ...(otherEntries.length > 0 ? { otherMcps: otherEntries } : {}),
  });
  persistSpec(workspace, spec);
  const mcpConfigPath = join(workspace, ".mcp.json");
  writeFileSync(mcpConfigPath, mcpConfigJson, { mode: 0o600 });

  let systemPromptFile: string | undefined;
  if (typeof spec.systemPrompt === "string" && spec.systemPrompt.length > 0) {
    systemPromptFile = join(workspace, "system-prompt.txt");
    writeFileSync(systemPromptFile, spec.systemPrompt, { mode: 0o600 });
  }

  const claudeArgs = buildAgentClaudeArgs({
    mcpConfigPath,
    firstChannelEntryKey: channelEntryKey(wakeChannel),
    ...(deps.claudeBin ? { claudeBin: deps.claudeBin } : {}),
    ...(systemPromptFile
      ? { systemPromptFile, systemPromptMode: spec.systemPromptMode ?? "append" }
      : {}),
  });

  const wrapped = await wrapArgvInSandbox({
    spec,
    workspace,
    runtimeReadOnly: deps.runtimeReadOnly,
    hubOrigin: deps.hubOrigin,
    ...(deps.vaultUrl ? { vaultUrl: deps.vaultUrl } : {}),
    argv: claudeArgs,
    ...(deps.sandboxEngine ? { sandboxEngine: deps.sandboxEngine } : {}),
    ...(deps.ripgrep ? { ripgrep: deps.ripgrep } : {}),
  });

  const cwd = resolveAgentCwd(spec, workspace);

  const mcpServerNames = Object.keys(
    (JSON.parse(mcpConfigJson) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {},
  );
  const homeEnv = seedAgentHome(workspace, { mcpServers: mcpServerNames, projectRoot: cwd });

  const childEnv = buildAgentChildEnv(deps.parentEnv ?? process.env, claudeOauthToken, channelEnv);
  // Scrub WINS: only allowlisted sandbox/proxy keys from `wrapped.env` (not the whole
  // daemon `process.env` the engine returns) layer on top. See mergeSandboxLaunchEnv.
  // (This file is the PARKED/retired interactive backend — kept in sync with the live
  // programmatic backend's shared seam, not a live spawn path.)
  const launchEnv = mergeSandboxLaunchEnv(childEnv, wrapped.env, homeEnv);

  await deps.tmux.newSession({
    name: session,
    argv: wrapped.argv,
    env: launchEnv,
    cwd,
    scriptDir: workspace,
  });

  const devChannelsPrompt = await deps.tmux.confirmDevChannelsPrompt(session);

  return {
    session,
    workspace,
    tokens,
    mcpConfigJson,
    wrapped,
    alreadyRunning: false,
    devChannelsPrompt,
  };
}

/** Per-session launch-script path under the session workspace (`cwd`). */
function launchScriptPath(cwd: string): string {
  return join(cwd, ".launch.sh");
}

/**
 * Build the per-session **launch script** body for an already-sandbox-wrapped argv.
 * On macOS `wrapWithSandboxArgv` returns `["/bin/bash","-c","<~84KB profile inline>"]`
 * — too large for a tmux argument, so we write it to a file tmux runs via a short argv.
 */
export function buildLaunchScript(argv: string[]): string {
  const header = "#!/bin/bash\nset -euo pipefail\n";
  if (argv.length === 3 && argv[0] === "/bin/bash" && argv[1] === "-c") {
    return `${header}${argv[2]}\n`;
  }
  return `${header}exec ${shellJoin(argv)}\n`;
}

/** The prompt marker for the dev-channels consent gate (agent#70). */
export const DEV_CHANNELS_PROMPT_MARKER = "I am using this for local development";
/** The ready marker shown once claude is running interactively. */
export const DEV_CHANNELS_READY_MARKER = "bypass permissions on";

/**
 * Auto-confirm claude's `--dangerously-load-development-channels` consent gate in a
 * detached tmux session (agent#70). NEVER throws.
 */
export async function confirmDevChannelsPrompt(
  session: string,
  opts: {
    spawnFn?: typeof Bun.spawn;
    timeoutMs?: number;
    intervalMs?: number;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<"confirmed" | "already-running" | "timeout"> {
  const spawnFn = opts.spawnFn ?? Bun.spawn;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const intervalMs = opts.intervalMs ?? 400;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function capture(): Promise<string> {
    try {
      const proc = spawnFn(["tmux", "capture-pane", "-t", session, "-p"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      await proc.exited;
      return text;
    } catch {
      return "";
    }
  }

  const deadline = Date.now() + timeoutMs;
  do {
    const pane = await capture();
    if (pane.includes(DEV_CHANNELS_PROMPT_MARKER)) {
      try {
        const proc = spawnFn(["tmux", "send-keys", "-t", session, "Enter"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        await proc.exited;
        return "confirmed";
      } catch {
        break;
      }
    }
    if (pane.includes(DEV_CHANNELS_READY_MARKER)) {
      return "already-running";
    }
    if (Date.now() >= deadline) break;
    await sleep(intervalMs);
  } while (Date.now() < deadline);

  console.warn(
    `parachute-agent: dev-channels consent prompt for tmux session "${session}" did not ` +
      `appear within ${timeoutMs}ms (agent#70). If \`mcp_sessions\` stays 0, attach to the ` +
      `session and press Enter in its terminal to clear the gate.`,
  );
  return "timeout";
}

/** The real tmux launcher — `tmux new-session -d` running the sandboxed argv via a launch script. */
export function realTmuxLauncher(spawnFn: typeof Bun.spawn = Bun.spawn): TmuxLauncher {
  return {
    async hasSession(name: string): Promise<boolean> {
      const proc = spawnFn(["tmux", "has-session", "-t", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
    async newSession(opts): Promise<void> {
      const scriptPath = launchScriptPath(opts.scriptDir ?? opts.cwd);
      writeFileSync(scriptPath, buildLaunchScript(opts.argv), { mode: 0o600 });
      chmodSync(scriptPath, 0o600);

      const envArgs: string[] = [];
      for (const [k, v] of Object.entries(opts.env)) {
        if (typeof v === "string") envArgs.push("-e", `${k}=${v}`);
      }
      const argv = [
        "tmux",
        "new-session",
        "-d",
        "-s",
        opts.name,
        "-c",
        opts.cwd,
        "-x",
        "220",
        "-y",
        "50",
        ...envArgs,
        "--",
        "/bin/bash",
        scriptPath,
      ];
      const proc = spawnFn(argv, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
        throw new Error(`tmux new-session failed (exit ${code}): ${err.trim()}`);
      }
    },
    async confirmDevChannelsPrompt(session) {
      return confirmDevChannelsPrompt(session, { spawnFn });
    },
  };
}

// ===========================================================================
// The tmux SESSION ADMIN (was agents.ts).
// ===========================================================================

/** One running (or recently-launched) interactive agent session, as the page listed them. */
export interface AgentInfo {
  name: string;
  session: string;
  attached: boolean;
  workspace: string;
  hasWorkspace: boolean;
  backend: "interactive";
  status?: string;
  channel?: string;
  vault?: string;
  systemPromptMode?: "append" | "replace";
  workingDir?: string;
}

/** A redacted mint summary — scope + audience + expiry, NEVER the token value. */
export interface RedactedToken {
  resource: string;
  scope: string;
  expiresAt: string;
}

/** The redacted spawn result the web endpoint returned (no token values). */
export interface RedactedSpawnResult {
  session: string;
  workspace: string;
  alreadyRunning: boolean;
  tokens: RedactedToken[];
  mcpServers: string[];
  filesystem: "workspace" | "full";
  network: "open" | "restricted";
  egress: string[];
}

export interface RedactedRestartResult extends RedactedSpawnResult {
  killed: boolean;
}

/** The spawn/list/kill/restart operations the daemon routes called. Injectable for tests. */
export interface AgentOps {
  spawn(spec: AgentSpec): Promise<SpawnAgentResult>;
  list(): Promise<AgentInfo[]>;
  kill(name: string): Promise<{ killed: boolean }>;
  restart(name: string): Promise<RedactedRestartResult>;
}

/** A tmux admin seam — real impl shells out to tmux; tests inject a recorder. */
export interface TmuxAdmin {
  listSessions(): Promise<{ name: string; attached: boolean }[]>;
  killSession(name: string): Promise<boolean>;
}

/** Parse `tmux list-sessions -F '#{session_name} #{session_attached}'` stdout. */
export function parseTmuxSessions(stdout: string): { name: string; attached: boolean }[] {
  const out: { name: string; attached: boolean }[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
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

/** Map raw tmux sessions to {@link AgentInfo}, keeping only `*-agent` sessions. */
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
    const persisted = readPersistedSpec(workspace);
    const hasPrompt = typeof persisted?.systemPrompt === "string" && persisted.systemPrompt.length > 0;
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

/** Redact a {@link SpawnAgentResult} for the wire — never the token values. */
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
  const allowed = result.wrapped.config.network.allowedDomains as string[] | undefined;
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
 * The PARKED interactive {@link AgentOps} — spawn/list/kill/restart over tmux
 * sessions. The live daemon no longer constructs or routes to this (the
 * interactive backend retired); kept buildable for the future revival + its tests.
 * `depsFactory` resolves the shared base deps; the caller supplies the tmux launcher.
 */
export function createRealAgentOps(opts?: {
  depsFactory?: () => SpawnAgentDeps;
  tmux?: TmuxAdmin;
  sessionsDirPath?: string;
}): AgentOps {
  const depsFactory =
    opts?.depsFactory ?? (() => {
      throw new SpawnRequestError(
        "createRealAgentOps: no depsFactory — the interactive backend is parked; wire " +
          "resolveSpawnDeps + realTmuxLauncher explicitly if reviving it.",
      );
    });
  const tmux = opts?.tmux ?? realTmuxAdmin();
  const dir = opts?.sessionsDirPath ?? "";
  return {
    async spawn(spec) {
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
      const workspace = sessionWorkspace(dir, name);
      const spec = readPersistedSpec(workspace);
      if (!spec) {
        throw new SpawnRequestError(
          `cannot restart agent "${name}": no persisted spec at ${workspace}/spec.json ` +
            `(it predates spawn-spec persistence, or was never spawned through this daemon). ` +
            `Kill it and spawn a fresh session from the Agents page.`,
        );
      }
      const killed = await tmux.killSession(sessionName(name));
      const result = await spawnAgent(spec, depsFactory());
      return { ...redactSpawnResult(result), killed };
    },
  };
}

/** Parse a mount entry from an untrusted body (parked). */
export function parseMountEntry(raw: unknown, i: number): AgentMount {
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

// Re-exported so the parked unit references resolve without reaching into the live tree.
export type { AgentSpec, AgentChannel, AgentVaultSpec, AgentMount };
export { statSync };
