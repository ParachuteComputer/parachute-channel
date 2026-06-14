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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
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

/** Claude config dir bound read-only so the sandboxed session can read its config. */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
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

  return {
    hubOrigin: getHubOrigin(),
    managerBearer,
    channelUrl: resolveChannelUrl(),
    vaultUrl,
    sessionsDir,
    // The claude config dir is the one runtime path the sandboxed `claude` must
    // read (system paths /usr,/lib stay readable; the home tree is denied). The
    // per-session workspace (rw) is added by spawnAgent under sessionsDir.
    runtimeReadOnly: [claudeConfigDir()],
    // The real per-channel Claude OAuth resolver (channel override ?? default ?? throw).
    resolveClaudeToken: (channel: string) => resolveClaudeCredential(channel, stateDir),
    // The real tmux launcher (writes the per-session launch script, runs tmux).
    tmux: realTmuxLauncher(),
    // sandboxEngine omitted → spawnAgent's `new Sandbox()` uses the real, pinned,
    // library-linked engine.
  };
}

/** The sessions dir the agent ops enumerate workspaces under. */
export function sessionsDir(): string {
  return join(defaultStateDir(), "sessions");
}
