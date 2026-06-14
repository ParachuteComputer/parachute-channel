/**
 * Resolve the REAL {@link SpawnAgentDeps} from the environment — the hub origin,
 * the manager bearer (`~/.parachute/operator.token`), the channel/vault URLs, the
 * sessions dir, the read-only runtime binds, the per-channel Claude-credential
 * resolver, and the real tmux launcher.
 *
 * This is the one place the spawn side-effects get their concrete wiring, shared
 * by BOTH callers that launch a real session:
 *   - the operator CLI (`scripts/spawn-agent.ts`), and
 *   - the daemon's web spawn endpoint (`POST /api/agents`, daemon.ts).
 *
 * Keeping it in `src/` (not the CLI script) lets the daemon import it without
 * reaching across into `scripts/`, and means the CLI and the web flow resolve
 * EXACTLY the same deps — a session launched from the page is byte-for-byte the
 * same least-privilege launch as one from the terminal.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import {
  realTmuxLauncher,
  type SpawnAgentDeps,
} from "./spawn-agent.ts";
import { resolveClaudeCredential } from "./credentials.ts";
import { defaultStateDir } from "./registry.ts";
import { getHubOrigin } from "./hub-jwt.ts";

const DEFAULT_CHANNEL_PORT = 1941;
const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";

/**
 * No operator token on disk — the manager bearer the hub attenuates child mints
 * against is missing, so no session can be launched. Carries an actionable
 * message; callers map it to a clean CLI error or a 503 JSON body.
 */
export class SpawnDepsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnDepsError";
  }
}

/** Base for `operator.token` — `$PARACHUTE_HOME` else `~/.parachute`. */
function parachuteHome(): string {
  return process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
}

/**
 * The spawn-manager's OWN bearer — `~/.parachute/operator.token`, the local
 * operator credential the hub attenuates child mints against (the same file
 * vault's `readOperatorToken` reads). Returns null when absent/empty.
 */
function readManagerBearer(): string | null {
  try {
    const path = resolve(parachuteHome(), "operator.token");
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Default channel daemon base URL: PARACHUTE_CHANNEL_URL, else loopback:<port>. */
function resolveChannelUrl(): string {
  const explicit = process.env.PARACHUTE_CHANNEL_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const port = parseInt(process.env.PARACHUTE_CHANNEL_PORT ?? "", 10) || DEFAULT_CHANNEL_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Claude runtime/config paths bound read-only so the sandboxed `claude` runs:
 *   - the config DIR (`~/.claude` or $CLAUDE_CONFIG_DIR) — skills, plugins, settings;
 *   - the config FILE `~/.claude.json` (at the home ROOT, a sibling of the dir).
 *
 * Binding `~/.claude.json` is load-bearing: without it claude can't see that it's
 * already onboarded, so it runs FIRST-RUN SETUP, whose connectivity check is FATAL
 * under the restricted egress proxy → the tmux session dies instantly with
 * "An unknown error occurred (Unexpected)". With it bound, claude skips onboarding
 * and starts cleanly under both restricted and open network. Bound READ-ONLY: a
 * session can read the operator's claude config (it runs on the operator's claude
 * credential anyway) but never mutate it for future sessions.
 */
function claudeConfigReads(): string[] {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
  const reads = [dir, resolve(homedir(), ".claude.json")];
  // If CLAUDE_CONFIG_DIR is set, newer claude keeps its config json under it too.
  if (process.env.CLAUDE_CONFIG_DIR) reads.push(join(process.env.CLAUDE_CONFIG_DIR, ".claude.json"));
  return reads;
}

/**
 * Resolve the `claude` binary to an ABSOLUTE path and the read binds the sandbox
 * needs to actually exec it.
 *
 * Why this matters: the scoped-read policy DENIES the whole home tree (`/Users`)
 * and re-allows only declared binds (mounts.ts §4.5). The claude CLI commonly
 * installs UNDER the home tree (`~/.local/bin/claude` → `~/.local/share/claude/
 * versions/<v>`), so without binding it the sandboxed launch fails with
 * `claude: command not found` and the tmux session dies instantly. Relying on
 * PATH alone is also fragile — the supervised daemon's PATH may differ from a
 * login shell. So we resolve the absolute path (via the daemon's PATH) and bind
 * the symlink + its realpath + the install dir read-only.
 *
 * Returns `null` when `claude` isn't found on the daemon's PATH — the caller
 * falls back to the bare `"claude"` (PATH lookup at run) and binds nothing, which
 * is correct when claude lives OUTSIDE the home tree (e.g. `/opt/homebrew/bin`,
 * already readable) and the only honest option when it can't be located at all.
 */
function resolveClaudeBin(): { bin: string; reads: string[] } | null {
  const sym = Bun.which("claude");
  if (!sym) return null;
  const reads = new Set<string>([sym]);
  try {
    const real = realpathSync(sym);
    reads.add(real);
    // The install dir + its parent — a versioned install keeps sibling files at
    // `…/versions/<v>` under `…/share/claude`; binding both covers what the
    // binary loads at runtime. Outside the home tree these are no-ops (already
    // readable), so this is safe regardless of install layout.
    reads.add(dirname(real));
    reads.add(dirname(dirname(real)));
  } catch {
    // realpath failed (broken symlink?) — bind just the symlink we found.
  }
  return { bin: sym, reads: [...reads] };
}

/** Absolute path to the operator token file (for error messages). */
export function operatorTokenPath(): string {
  return resolve(parachuteHome(), "operator.token");
}

/**
 * Build the real {@link SpawnAgentDeps} from the environment. Throws
 * {@link SpawnDepsError} when the operator token is missing (no manager bearer →
 * no mint → no launch). Pure aside from reading the env + the token file; the
 * returned deps carry the real mint client, sandbox engine, and tmux launcher.
 */
export function resolveSpawnDeps(): SpawnAgentDeps {
  const managerBearer = readManagerBearer();
  if (!managerBearer) {
    throw new SpawnDepsError(
      `no operator token at ${operatorTokenPath()} — the manager bearer the hub attenuates ` +
        `child mints against. Log in / provision the hub so the operator token exists ` +
        `(it's what \`parachute auth mint-token\` uses), then retry.`,
    );
  }

  const stateDir = defaultStateDir();
  const sessionsDir = join(stateDir, "sessions");
  const vaultUrl = process.env.PARACHUTE_VAULT_URL?.replace(/\/$/, "") || DEFAULT_VAULT_URL;

  // Resolve the claude binary + the read binds it needs inside the sandbox (the
  // home tree is denied, and claude commonly lives under it). null → fall back to
  // bare "claude" on PATH (correct when claude is outside the home tree).
  const claude = resolveClaudeBin();

  // The runtime/config paths the sandboxed `claude` must read: its config dir +
  // config file (skip-onboarding, see claudeConfigReads) + (when resolved) the
  // binary itself and its install dir. System paths (/usr,/lib,/opt) stay
  // readable; the per-session workspace (rw) is added by spawnAgent under sessionsDir.
  const runtimeReadOnly = [...claudeConfigReads(), ...(claude?.reads ?? [])];

  return {
    hubOrigin: getHubOrigin(),
    managerBearer,
    channelUrl: resolveChannelUrl(),
    vaultUrl,
    sessionsDir,
    runtimeReadOnly,
    // The real per-channel Claude OAuth resolver (channel override ?? default ?? throw).
    resolveClaudeToken: (channel: string) => resolveClaudeCredential(channel, stateDir),
    // The real tmux launcher (writes the per-session launch script, runs tmux).
    tmux: realTmuxLauncher(),
    // Absolute claude path so the sandbox doesn't depend on PATH resolution at run
    // (and matches the bound binary). Omitted → spawnAgent defaults to "claude".
    ...(claude ? { claudeBin: claude.bin } : {}),
    // sandboxEngine omitted → spawnAgent's `new Sandbox()` uses the real, pinned,
    // library-linked engine.
  };
}

/** The sessions dir the agent ops enumerate workspaces under. */
export function sessionsDir(): string {
  return join(defaultStateDir(), "sessions");
}
