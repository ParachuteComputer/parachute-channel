/**
 * Spawn/scope command — graduate `scripts/launch-session.sh` into a real module
 * (design §4). Given an agent spec:
 *
 *   1. Mint one scoped token PER resource via the hub mint API (attenuated to the
 *      manager's own bearer): `channel:read[+write]` per channel, `vault:<name>:<verb>`
 *      (optionally tag-scoped) for the vault — one token per `aud` (§4.2 step 1, §4.3).
 *   2. Build the multi-entry strict MCP config from those tokens (§4.2 step 2).
 *   3. Launch `claude` WRAPPED BY THE SANDBOX in a tmux session, with a scrubbed
 *      env: inject the per-channel OAuth credential as `CLAUDE_CODE_OAUTH_TOKEN`,
 *      and NEVER set `ANTHROPIC_API_KEY` (which would silently route the session
 *      onto API billing, §6). `--strict-mcp-config` closes the MCP surface to
 *      exactly the spec.
 *
 * The credential injected here is a passed-in param/placeholder for THIS stream;
 * Stream 3 builds the real per-channel secret store (design §6, §4.1 credentialRef).
 *
 * Env-scrubbing follows runner's `buildChildEnv` instinct
 * (`parachute-runner/src/spawn.ts`): pass only what claude needs, drop everything
 * else — but UNLIKE runner, we deliberately do NOT pass `ANTHROPIC_API_KEY`
 * through (runner is the API-key path; the channel session is the interactive
 * subscription path).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentSpec, BaseBinds } from "./sandbox/types.ts";
import { normalizeChannel } from "./sandbox/types.ts";
import { Sandbox, type SandboxEngine, type WrappedCommand } from "./sandbox/index.ts";
import type { EgressBaseInput } from "./sandbox/egress.ts";
import {
  buildAgentMcpConfigJson,
  type ChannelMcpEntry,
  type VaultMcpEntry,
  type OtherMcpEntry,
} from "./agent-mcp-config.ts";
import {
  mintScopedToken,
  channelScope,
  vaultScope,
  type MintTokenDeps,
  type MintResult,
} from "./mint-token.ts";

/**
 * Slug guard for `spec.name`. The name is used UNESCAPED as a tmux session
 * target (`-t`) and a path segment under `sessionsDir`, so it must be a strict
 * slug — mirrors `scripts/launch-session.sh`'s existing check. Anything with
 * `..`, `/`, or spaces would traverse the sessions dir or break tmux targeting.
 * Phase 2 makes spawns API/MCP-triggered (the name becomes less-trusted input),
 * so the guard is enforced now, before any fs/tmux side effect.
 */
const AGENT_NAME_SLUG = /^[a-z0-9_-]+$/i;

/**
 * Process-wide serialization for the sandbox-runtime singleton. `SandboxManager`
 * is global (initialize → wrap → reset share one set of host proxies), so two
 * concurrent `spawnAgent` calls would race the initialize→wrap window (a second
 * `initialize` could clobber the first's config before its command is wrapped).
 * Only that brief window needs the lock — the sandbox policy is baked into the
 * argv at `wrapWithSandboxArgv`, after which the spawned process runs
 * independently. This is a minimal FIFO async mutex: each acquirer chains onto
 * the previous one's release.
 */
let spawnLock: Promise<void> = Promise.resolve();
async function withSpawnLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = spawnLock;
  let release!: () => void;
  spawnLock = new Promise<void>((r) => (release = r));
  await prior;
  try {
    return await fn();
  } finally {
    release();
  }
}

/** A tmux launcher seam — real impl spawns tmux; tests inject a recorder. */
export interface TmuxLauncher {
  /**
   * Create a detached tmux session `name` that runs `argv` with `env` from `cwd`.
   * Returns the spawned argv (for assertion). Must not block on the session.
   */
  newSession(opts: {
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
  }): Promise<void>;
  /** Whether a session by this name already exists (idempotency). */
  hasSession(name: string): Promise<boolean>;
}

export interface SpawnAgentDeps {
  /** Hub origin + manager bearer for minting (§4.3). */
  hubOrigin: string;
  managerBearer: string;
  /** Daemon base URL the channel MCP endpoints live under. */
  channelUrl: string;
  /** Vault base URL (if the spec binds a vault). Defaults to hubOrigin. */
  vaultUrl?: string;
  /** Base for session workspaces (e.g. `~/.parachute/channel/sessions`). */
  sessionsDir: string;
  /**
   * Read-only runtime/config binds the sandbox always grants (the claude config
   * dir, etc.). Workspace is derived per-session under `sessionsDir`.
   */
  runtimeReadOnly: string[];
  /**
   * The Claude credential to inject as `CLAUDE_CODE_OAUTH_TOKEN`. For THIS stream
   * a passed-in param/placeholder; Stream 3 resolves it from the per-channel
   * secret store keyed by `spec.credentialRef`.
   */
  claudeOauthToken: string;
  /** Sandbox engine override (tests inject a fake). */
  sandboxEngine?: SandboxEngine;
  /** tmux launcher (tests inject a recorder). */
  tmux: TmuxLauncher;
  /** fetch override for the mint client (tests). */
  fetchFn?: typeof fetch;
  /** Parent env to scrub from. Defaults to process.env. */
  parentEnv?: Record<string, string | undefined>;
  /** claude binary. Defaults to "claude" (resolved by the shell at run, not us). */
  claudeBin?: string;
  /**
   * Optional ripgrep override threaded to the sandbox (macOS deny-path scan needs
   * a real `rg` binary; pass one when the host has none on PATH).
   */
  ripgrep?: { command: string; args?: string[] };
}

export interface SpawnAgentResult {
  /** tmux session name (`<spec.name>-agent`). */
  session: string;
  /** Per-session workspace dir. */
  workspace: string;
  /** The minted tokens, by resource key (channel name / `vault:<name>` / mcp name). */
  tokens: Record<string, MintResult>;
  /** The inline MCP config JSON written for the session. */
  mcpConfigJson: string;
  /** The sandbox-wrapped argv + env + config the session was launched with. */
  wrapped: WrappedCommand;
  /** Already-running? (idempotent no-op). */
  alreadyRunning: boolean;
}

/** tmux session name for a spec — matches launch-session.sh's `<name>-agent`. */
export function sessionName(specName: string): string {
  return `${specName}-agent`;
}

/** Per-session workspace dir under the sessions base. */
export function sessionWorkspace(sessionsDir: string, specName: string): string {
  return join(sessionsDir, specName);
}

/**
 * Build the scrubbed child env for the sandboxed claude. Mirrors runner's
 * passthrough allowlist MINUS `ANTHROPIC_API_KEY` (and the `ANTHROPIC_*`/`CLAUDE_*`
 * wildcards, which would re-admit it) — the channel session runs on the
 * interactive subscription, so an API key must never leak in (§6). The injected
 * `CLAUDE_CODE_OAUTH_TOKEN` is the session's auth.
 *
 * The sandbox engine's own env (proxy vars, sandbox markers) is layered on TOP of
 * this by the wrap step; this is the base the wrapper extends.
 */
export function buildAgentChildEnv(
  parentEnv: Record<string, string | undefined>,
  claudeOauthToken: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Fundamentals + locale, like runner — but NOT ANTHROPIC_API_KEY / CLAUDE_API_KEY.
  const passthrough = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "TZ",
    "CLAUDE_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ];
  for (const k of passthrough) {
    const v = parentEnv[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  // Pass through LC_* locale vars only. Deliberately NOT the broad ANTHROPIC_*/
  // CLAUDE_* wildcards runner uses — those would re-admit ANTHROPIC_API_KEY and
  // route the session onto metered API billing instead of the subscription.
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v === "string" && v.length > 0 && k.startsWith("LC_")) out[k] = v;
  }
  if (!out.PATH) out.PATH = "/usr/local/bin:/usr/bin:/bin";

  // The interactive subscription credential (design §6). Explicitly the ONLY
  // Claude auth var set; ANTHROPIC_API_KEY is intentionally absent.
  out.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
  return out;
}

/**
 * Build the `claude` invocation argv (pre-sandbox-wrap). Interactive `claude`
 * (NOT `claude -p` — the session runs on the subscription, §1/§6) with the
 * strict, multi-entry MCP config and the dev-channels flag for the first channel
 * (the wake transport). `--strict-mcp-config` closes the MCP surface to the spec.
 */
export function buildAgentClaudeArgs(opts: {
  mcpConfigPath: string;
  firstChannelEntryKey: string;
  claudeBin?: string;
}): string[] {
  const bin = opts.claudeBin ?? "claude";
  return [
    bin,
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigPath,
    `--dangerously-load-development-channels=server:${opts.firstChannelEntryKey}`,
  ];
}

/**
 * Spawn a sandboxed agent session from a spec. Idempotent: an existing tmux
 * session is a no-op (returns `alreadyRunning: true`).
 *
 * Order: validate name → mint per-resource tokens → write MCP config → build
 * claude argv → sandbox-wrap → tmux launch with scrubbed env.
 *
 * **Concurrency-safe.** The sandbox-runtime singleton's initialize→wrap window is
 * serialized process-wide (see `withSpawnLock`), so concurrent `spawnAgent` calls
 * don't clobber each other's sandbox config. Each produces an independent MCP
 * config + wrapped argv; the spawned processes then run independently.
 */
export async function spawnAgent(
  spec: AgentSpec,
  deps: SpawnAgentDeps,
): Promise<SpawnAgentResult> {
  // SECURITY: the name lands UNESCAPED in a tmux `-t` target and a path segment;
  // reject anything that isn't a strict slug BEFORE any fs/tmux side effect.
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

  const mintDeps: MintTokenDeps = {
    hubOrigin: deps.hubOrigin,
    managerBearer: deps.managerBearer,
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  };

  // 1. Mint one token per resource (one aud each, attenuated). Any over-broad or
  //    unauthorized scope fails here (the hub's canGrant), so we never launch a
  //    session with a credential the manager couldn't actually grant (§4.3).
  const tokens: Record<string, MintResult> = {};
  const channelEntries: ChannelMcpEntry[] = [];
  for (const rawChannel of spec.channels) {
    const { name: channel, access } = normalizeChannel(rawChannel);
    // A read-only channel mints `channel:read` only — the arm is woken + reads
    // but cannot reply; a write channel mints `channel:read channel:write`.
    const minted = await mintScopedToken(
      { scope: channelScope({ write: access === "write" }), audience: "channel" },
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

  // 2. Build the multi-entry strict MCP config + write it 0600 (it inlines tokens).
  const mcpConfigJson = buildAgentMcpConfigJson({
    channelUrl: deps.channelUrl,
    channels: channelEntries,
    ...(vaultArg ? { vault: vaultArg } : {}),
    ...(otherEntries.length > 0 ? { otherMcps: otherEntries } : {}),
  });
  mkdirSync(workspace, { recursive: true });
  const mcpConfigPath = join(workspace, ".mcp.json");
  // `mode: 0o600` on the write is sufficient here — the file is always newly
  // created per-launch under the per-session workspace, so there's no pre-existing
  // looser-perms file to tighten (unlike registry.ts's read-modify-write).
  writeFileSync(mcpConfigPath, mcpConfigJson, { mode: 0o600 });

  // 3. Build the claude argv, sandbox-wrap it, launch in tmux with scrubbed env.
  const firstChannel = normalizeChannel(spec.channels[0]!).name;
  const claudeArgs = buildAgentClaudeArgs({
    mcpConfigPath,
    firstChannelEntryKey: `channel-${firstChannel}`,
    ...(deps.claudeBin ? { claudeBin: deps.claudeBin } : {}),
  });

  const baseBinds: BaseBinds = {
    workspace,
    runtimeReadOnly: deps.runtimeReadOnly,
  };
  const egressBase: EgressBaseInput = {
    hubOrigin: deps.hubOrigin,
    ...(deps.vaultUrl ? { vaultOrigin: deps.vaultUrl } : {}),
  };

  // Serialize the sandbox-runtime singleton's initialize→wrap window across
  // concurrent spawns (the policy is baked into the argv at wrap, so only this
  // window races). Outside the lock the spawned process runs independently.
  const sandbox = new Sandbox(deps.sandboxEngine);
  const wrapped = await withSpawnLock(() =>
    sandbox.wrap({
      spec,
      baseBinds,
      egressBase,
      command: shellJoin(claudeArgs),
      ...(deps.ripgrep ? { ripgrep: deps.ripgrep } : {}),
    }),
  );

  // Layer the scrubbed agent env UNDER the sandbox wrapper's env (proxy vars,
  // sandbox markers from the engine win on conflict; CLAUDE_CODE_OAUTH_TOKEN +
  // the passthrough fundamentals come from us). ANTHROPIC_API_KEY is absent.
  const childEnv = buildAgentChildEnv(deps.parentEnv ?? process.env, deps.claudeOauthToken);
  const launchEnv: Record<string, string | undefined> = { ...childEnv, ...wrapped.env };

  await deps.tmux.newSession({
    name: session,
    argv: wrapped.argv,
    env: launchEnv,
    cwd: workspace,
  });

  return {
    session,
    workspace,
    tokens,
    mcpConfigJson,
    wrapped,
    alreadyRunning: false,
  };
}

/**
 * Minimal POSIX shell-quote for joining argv into the single command string the
 * sandbox engine wraps (`wrapWithSandboxArgv` takes a command string). Quotes any
 * arg containing shell-significant chars; safe for the controlled argv we build
 * (claude bin, flags, a workspace-local config path).
 */
export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

function shellQuote(arg: string): string {
  if (arg.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  // Single-quote, escaping embedded single quotes the POSIX way.
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The real tmux launcher — `tmux new-session -d` running the sandboxed argv. The
 * env is applied via `tmux new-session`'s `-e KEY=VAL` (tmux ≥3.0) so the child
 * inherits exactly the launch env (scrubbed agent env + sandbox proxy vars), not
 * the operator's shell env. `argv` is the sandbox wrapper's argv (already
 * `["/bin/bash","-c", "<env … sandbox-exec … claude …>"]` on macOS), so tmux
 * runs it directly. Injected here (not used by tests, which use a recorder) so
 * the module is a real command, not just a planner.
 */
export function realTmuxLauncher(spawnFn: typeof Bun.spawn = Bun.spawn): TmuxLauncher {
  return {
    async hasSession(name: string): Promise<boolean> {
      // Read-only existence probe — it inherits the parent's full env, which is
      // fine and intentional: it only checks whether a session exists and starts
      // no child process. The scrubbed-env discipline applies to `newSession`
      // (which actually launches the agent), not to this side-effect-free query.
      const proc = spawnFn(["tmux", "has-session", "-t", name], {
        stdout: "ignore",
        stderr: "ignore",
      });
      const code = await proc.exited;
      return code === 0;
    },
    async newSession(opts): Promise<void> {
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
        ...opts.argv,
      ];
      const proc = spawnFn(argv, { stdout: "pipe", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const err = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
        throw new Error(`tmux new-session failed (exit ${code}): ${err.trim()}`);
      }
    },
  };
}
