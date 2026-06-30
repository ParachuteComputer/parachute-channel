/**
 * Resolve the REAL {@link SpawnAgentBaseDeps} from the environment — the hub origin,
 * the manager bearer (`~/.parachute/operator.token`), the channel/vault URLs, the
 * sessions dir, the read-only runtime binds, and the per-channel Claude-credential +
 * env resolvers.
 *
 * This is the one place the spawn side-effects get their concrete wiring. The
 * PROGRAMMATIC backend reads its slice of these for each `claude -p` turn
 * (`createDefaultProgrammaticRegistry`, daemon.ts). The deps deliberately carry NO
 * tmux launcher — the interactive (tmux) backend was retired 2026-06-19 (design
 * 2026-06-19-retire-interactive-backend.md); its parked spawner
 * (`src/_parked/interactive-spawn.ts`) wires its own `realTmuxLauncher` if ever
 * revived.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { type SpawnAgentBaseDeps } from "./spawn-agent.ts";
import { resolveClaudeCredential, resolveChannelEnv } from "./credentials.ts";
import { defaultStateDir } from "./registry.ts";
import { agentEnv } from "./env-compat.ts";
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

/** Default channel daemon base URL: PARACHUTE_AGENT_URL, else loopback:<port>. */
function resolveChannelUrl(): string {
  const explicit = agentEnv("URL")?.replace(/\/$/, "");
  if (explicit) return explicit;
  const port = parseInt(agentEnv("PORT") ?? "", 10) || DEFAULT_CHANNEL_PORT;
  return `http://127.0.0.1:${port}`;
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

/**
 * Map `process.arch` → the sandbox-runtime vendor dir name, or null if unsupported.
 * Mirrors the runtime's own `getVendorArchitecture` (incl. its defensive `x86_64`/
 * `aarch64` aliases) so we resolve the SAME vendor path it does. `arch` is widened to
 * `string` because Node/Bun's `process.arch` literal type omits those aliases.
 */
function seccompVendorArch(): "x64" | "arm64" | null {
  const arch: string = process.arch;
  if (arch === "x64" || arch === "x86_64") return "x64";
  if (arch === "arm64" || arch === "aarch64") return "arm64";
  // Other arches have no vendored apply-seccomp binary — nothing to bind.
  return null;
}

/**
 * Resolve the read binds the sandbox needs to exec `@anthropic-ai/sandbox-runtime`'s
 * own vendored `apply-seccomp` helper — the LINUX analogue of {@link resolveClaudeBin}.
 *
 * Why this matters (the Linux seccomp ENOENT): on Linux the engine enforces its
 * unix-socket block by exec'ing its vendored `apply-seccomp` binary INSIDE the bwrap
 * mount namespace (`<pkgRoot>/vendor/seccomp/<arch>/apply-seccomp`, an absolute host
 * path). The scoped-read policy DENIES the whole home tree (`/home`) by mounting a
 * tmpfs over it and re-allows ONLY the declared binds (mounts.ts §4.5). bun/npm install
 * the package UNDER the home tree (`~/.bun/...`, `~/.npm-global/...`), so the deny tmpfs
 * MASKS the engine's own helper inside the namespace — the turn dies with
 * `apply-seccomp: No such file or directory` (an ENOENT for a file that exists on the
 * host but is hidden in the sandbox). The runtime resolves the helper to an absolute
 * path but never binds it back when the caller's denyRead covers it, and unlike `claude`
 * (handled by {@link resolveClaudeBin}) nothing else re-exposes it.
 *
 * So we resolve the helper exactly as the runtime does and add it + its dir + the vendor
 * tree to the read binds, which flow to `allowRead` and get re-bound over the deny
 * tmpfs. This is a READ-ONLY bind of the engine's OWN static, library-linked helper —
 * zero weakening of the boundary (it IS the boundary). Outside the home tree the binds
 * are harmless no-ops (`--ro-bind / /` already exposes them); on macOS apply-seccomp is
 * unused so the path resolution / bind never matters. Returns `[]` when the helper can't
 * be located, in which case the engine degrades to its own resolution + the existing
 * "unix socket access not restricted" warning, exactly as before.
 */
export function resolveSeccompReadBinds(): string[] {
  const arch = seccompVendorArch();
  if (!arch) return [];
  try {
    // Resolve the package ROOT via the module graph (library-resolved, never PATH) so we
    // bind the same physical install the engine was imported from. `require.resolve` of
    // the main entry → `<pkgRoot>/dist/index.js`; the root is two dirs up. This mirrors
    // how the runtime locates the vendor dir (relative to its own dist/).
    const req = createRequire(import.meta.url);
    const pkgRoot = dirname(dirname(req.resolve("@anthropic-ai/sandbox-runtime")));
    const bin = join(pkgRoot, "vendor", "seccomp", arch, "apply-seccomp");
    if (!existsSync(bin)) return [];
    const reads = new Set<string>([bin]);
    try {
      const real = realpathSync(bin);
      reads.add(real);
      reads.add(dirname(real)); // .../vendor/seccomp/<arch>
      reads.add(dirname(dirname(dirname(real)))); // .../vendor
    } catch {
      // Broken symlink — bind the path we built; the dir bind below still applies.
    }
    reads.add(dirname(bin));
    return [...reads];
  } catch {
    // Package not resolvable (shouldn't happen — it's a pinned dep) → bind nothing.
    return [];
  }
}

/** Absolute path to the operator token file (for error messages). */
export function operatorTokenPath(): string {
  return resolve(parachuteHome(), "operator.token");
}

/**
 * Build the real {@link SpawnAgentBaseDeps} from the environment. Throws
 * {@link SpawnDepsError} when the operator token is missing (no manager bearer →
 * no mint → no launch). Pure aside from reading the env + the token file.
 */
export function resolveSpawnDeps(): SpawnAgentBaseDeps {
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

  // Read binds the sandboxed `claude` needs in CONFINED (scoped-read) mode: the
  // claude BINARY + its install dir (commonly under the home tree, which confined
  // mode denies). The agent's config/onboarding now lives in its own per-session
  // HOME (seedAgentHome) under the workspace — re-allowed there — so we no longer
  // bind (or expose) the operator's real ~/.claude. In TRUSTED mode reads are
  // broad and these binds are harmless no-ops. System paths (/usr,/lib,/opt) stay
  // readable; the per-session workspace (rw) is added by spawnAgent.
  //
  // PLUS the engine's vendored `apply-seccomp` helper (Linux): the engine execs it
  // INSIDE the bwrap namespace, but it installs under the home tree (~/.bun, ~/.npm-…)
  // which confined mode denies via a tmpfs — so it must be re-allowed too, or every
  // Linux turn dies with `apply-seccomp: No such file or directory`. See
  // resolveSeccompReadBinds. No-op on macOS / outside the home tree.
  const runtimeReadOnly = [...(claude?.reads ?? []), ...resolveSeccompReadBinds()];

  return {
    hubOrigin: getHubOrigin(),
    managerBearer,
    channelUrl: resolveChannelUrl(),
    vaultUrl,
    sessionsDir,
    runtimeReadOnly,
    // The real per-channel Claude OAuth resolver (channel override ?? default ?? throw).
    resolveClaudeToken: (channel: string) => resolveClaudeCredential(channel, stateDir),
    // The real per-channel env resolver (GH_TOKEN/CLOUDFLARE_*/… — { default, channel } merged).
    resolveChannelEnv: (channel: string) => resolveChannelEnv(channel, stateDir),
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
