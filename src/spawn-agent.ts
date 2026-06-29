/**
 * SHARED spawn helpers — the sandbox/filesystem/env/spec-persistence primitives
 * that BOTH live agent backends build on:
 *
 *   - the PROGRAMMATIC backend (`src/backends/programmatic.ts`) — `claude -p` turns;
 *   - the PARKED interactive spawner (`src/_parked/interactive-spawn.ts`) — the
 *     retired tmux backend, kept for future terminal/process-mgmt (design
 *     2026-06-19-retire-interactive-backend.md).
 *
 * What lives here:
 *   - {@link wrapArgvInSandbox} — the ONE place the sandbox/egress/filesystem policy
 *     is applied to a launch argv (every launch gets the same egress floor + scoped-
 *     read confinement);
 *   - {@link seedAgentHome} — the per-session writable HOME (the stability keystone);
 *   - {@link buildAgentChildEnv} — the scrubbed child env (NEVER `ANTHROPIC_API_KEY`;
 *     the session runs on the subscription via `CLAUDE_CODE_OAUTH_TOKEN`, §6);
 *   - {@link resolveAgentCwd} / {@link sessionWorkspace} / {@link persistSpec} /
 *     {@link readPersistedSpec} / {@link shellJoin} — the spec/path/quoting helpers.
 *
 * The interactive tmux SPAWNER itself (the `claude` argv, the launch script, the
 * dev-channels-consent auto-answer, `spawnAgent`, the `TmuxLauncher`) was PARKED to
 * `src/_parked/interactive-spawn.ts` when the interactive backend retired — it
 * imports these helpers, it didn't fork them.
 */

import { writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec, BaseBinds } from "./sandbox/types.ts";
import { Sandbox, type SandboxEngine, type WrappedCommand } from "./sandbox/index.ts";
import type { EgressBaseInput } from "./sandbox/egress.ts";
import { DENYLISTED_ENV } from "./credentials.ts";

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

/**
 * Inputs to {@link wrapArgvInSandbox} — the spec (carries network/filesystem/
 * mounts/egress), the workspace + runtime read binds, the egress base origins, the
 * argv to run, and the engine + ripgrep overrides.
 */
export interface WrapArgvInSandboxInput {
  /** The agent spec — its network/filesystem/egress/mounts drive the sandbox config. */
  spec: AgentSpec;
  /** Private per-session workspace (rw). */
  workspace: string;
  /** Read-only runtime/claude-config binds the session needs to run `claude`. */
  runtimeReadOnly: string[];
  /** Hub origin for the non-removable egress base. */
  hubOrigin: string;
  /** Vault origin for the egress base (if the spec binds a vault). */
  vaultUrl?: string;
  /** The argv to sandbox-wrap (e.g. the `claude …` invocation). */
  argv: string[];
  /** Sandbox engine override (tests inject a fake). */
  sandboxEngine?: SandboxEngine;
  /**
   * Optional ripgrep override threaded to the sandbox (macOS deny-path scan needs a
   * real `rg`; pass one when the host has none on PATH).
   */
  ripgrep?: { command: string; args?: string[] };
}

/**
 * Sandbox-wrap an argv for one launch — the SHARED sandbox seam both the
 * programmatic backend (`claude -p`) and the parked interactive spawner (tmux
 * `claude`, `src/_parked/interactive-spawn.ts`) call. Extracted so the sandbox/
 * egress/filesystem policy lives in
 * exactly ONE place: every launch, regardless of backend, gets the same egress
 * floor (§4.4) + scoped-read confinement (§4.5) baked into its argv.
 *
 * It owns the process-wide serialization of the sandbox-runtime singleton's
 * initialize→wrap window (`withSpawnLock`): the engine is global (one set of host
 * proxies), so two concurrent wraps would race the initialize→wrap window. Only
 * that brief window holds the lock — the policy is baked into the returned argv at
 * `wrap`, after which the spawned process runs independently.
 */
export async function wrapArgvInSandbox(input: WrapArgvInSandboxInput): Promise<WrappedCommand> {
  const baseBinds: BaseBinds = {
    workspace: input.workspace,
    runtimeReadOnly: input.runtimeReadOnly,
  };
  const egressBase: EgressBaseInput = {
    hubOrigin: input.hubOrigin,
    ...(input.vaultUrl ? { vaultOrigin: input.vaultUrl } : {}),
  };
  const sandbox = new Sandbox(input.sandboxEngine);
  return withSpawnLock(() =>
    sandbox.wrap({
      spec: input.spec,
      baseBinds,
      egressBase,
      command: shellJoin(input.argv),
      ...(input.ripgrep ? { ripgrep: input.ripgrep } : {}),
    }),
  );
}

/**
 * The SHARED, NON-tmux deps a real session launch needs (hub origin + manager
 * bearer for minting, channel/vault URLs, the sessions dir, the runtime read binds,
 * the per-channel credential/env resolvers, sandbox/ripgrep overrides). The
 * programmatic backend reads its slice of these; `resolveSpawnDeps` builds them.
 *
 * The PARKED interactive spawner extends this with a `tmux` launcher
 * (`SpawnAgentDeps` in `src/_parked/interactive-spawn.ts`); the live tree never
 * carries a tmux launcher in its deps.
 */
export interface SpawnAgentBaseDeps {
  /** Hub origin + manager bearer for minting (§4.3). */
  hubOrigin: string;
  managerBearer: string;
  /** Daemon base URL the channel MCP endpoints live under. */
  channelUrl: string;
  /** Vault base URL (if the spec binds a vault). Defaults to hubOrigin. */
  vaultUrl?: string;
  /** Base for session workspaces (e.g. `~/.parachute/agent/sessions`). */
  sessionsDir: string;
  /**
   * Read-only runtime/config binds the sandbox always grants (the claude config
   * dir, etc.). Workspace is derived per-session under `sessionsDir`.
   */
  runtimeReadOnly: string[];
  /**
   * Resolve the Claude OAuth token to inject as `CLAUDE_CODE_OAUTH_TOKEN`, given
   * the spec's wake channel. Defaults to the real per-channel secret store
   * (`credentials.ts` — channel override ?? default/operator ?? throw). The store
   * throws `CredentialNotConfiguredError` when neither is set, which aborts the
   * launch BEFORE any side effect (no session ever runs without auth).
   */
  resolveClaudeToken?: (channel: string) => string;
  /**
   * Resolve the per-channel ENV vars (the GH_TOKEN/CLOUDFLARE_* slice) to inject
   * into the sandboxed child. Read at spawn time so a var set via the config API
   * applies on the next spawn without a daemon restart. A missing/empty store
   * resolves to `{}` (env injection is optional).
   */
  resolveChannelEnv?: (channel: string) => Record<string, string>;
  /** Sandbox engine override (tests inject a fake). */
  sandboxEngine?: SandboxEngine;
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

/** Per-session workspace dir under the sessions base. */
export function sessionWorkspace(sessionsDir: string, specName: string): string {
  return join(sessionsDir, specName);
}

/**
 * Resolve an agent's CWD (the working-directory axis, design
 * 2026-06-16-agent-filesystem-and-sharing.md). When the spec sets `workspace`
 * (the shared real dir the agent works from) the cwd is that dir; otherwise it's
 * the agent's PRIVATE per-session dir (today's behavior, exactly).
 *
 * This is ONLY the cwd. The private dir always remains the home for `.mcp.json`,
 * `spec.json`, `system-prompt.txt`, the seeded `CLAUDE_CONFIG_DIR`, and `tmp` —
 * those are passed to `claude` by ABSOLUTE path (`--mcp-config`,
 * `--system-prompt-file`, `CLAUDE_CONFIG_DIR`/`TMPDIR` env) so they're unaffected
 * by the cwd change. The decoupling keeps the working dir shareable while the
 * credential-bearing private home stays per-agent.
 */
export function resolveAgentCwd(spec: AgentSpec, privateWorkspace: string): string {
  return typeof spec.workspace === "string" && spec.workspace.length > 0
    ? spec.workspace
    : privateWorkspace;
}

/** Path to the persisted spawn-spec for a session (recovered by restart). */
export function specFilePath(workspace: string): string {
  return join(workspace, "spec.json");
}

/**
 * Persist the spawn {@link AgentSpec} alongside the session workspace so a
 * per-session restart can faithfully reproduce the original launch (same channels,
 * vault, network, mounts) WITHOUT re-asking the operator. The live tmux session
 * carries none of this — `GET /api/agents` only knows name + attached — and the
 * workspace's `.mcp.json` inlines minted tokens (not a clean spec), so the spec
 * itself is the recoverable source of truth.
 *
 * The spec is NON-SECRET (channel names, access verbs, vault name, host paths) —
 * the actual credentials live in credentials.json (Claude) / the env store and are
 * re-resolved at each (re)spawn. We still write it 0600 (matching the workspace's
 * secret-bearing `.mcp.json`): the per-session workspace dir is umask-inherited (no
 * tighter than 0755), so 0600 on the file is the real guard — defense-in-depth that
 * also keeps the perms honest if a future field ever does carry something sensitive.
 * `chmod`-ed unconditionally since writeFileSync's `mode` only applies on create.
 * Returns the path written.
 */
export function persistSpec(workspace: string, spec: AgentSpec): string {
  mkdirSync(workspace, { recursive: true });
  const path = specFilePath(workspace);
  writeFileSync(path, JSON.stringify(spec, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** Read a persisted spawn-spec, or null if absent/unreadable. */
export function readPersistedSpec(workspace: string): AgentSpec | null {
  const path = specFilePath(workspace);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AgentSpec;
  } catch {
    return null;
  }
}

/**
 * The ONLY env keys we accept FROM the sandbox engine's returned `wrapped.env`.
 *
 * CRITICAL ISOLATION CONTRACT. `@anthropic-ai/sandbox-runtime`'s
 * `wrapWithSandboxArgv` returns `env: process.env` on macOS/Linux (the proxy/sandbox
 * vars are baked into the wrapped COMMAND STRING via an `env VAR=… sandbox-exec …`
 * prefix / bwrap `--setenv`, NOT into the returned env) and `{...process.env, ...proxy}`
 * on Windows (where the proxy vars DO ride in the returned env). So `wrapped.env` is
 * essentially the WHOLE daemon env. If we spread it over the scrubbed `childEnv`, the
 * daemon's ambient `ANTHROPIC_API_KEY` / any other secret would OVERRIDE the scrub and
 * reach the sandboxed turn — defeating `buildAgentChildEnv` entirely (the
 * subscription-billing + no-secret-leak guarantee). So we ALLOWLIST: from `wrapped.env`
 * we keep ONLY these known sandbox/proxy keys (the exact set the runtime's
 * `generateProxyEnvVars` + the Linux bwrap `--setenv` markers emit — needed so the
 * egress proxy works, esp. on Windows where they ride in the returned env), and drop
 * everything else. {@link DENYLISTED_ENV} is re-applied to whatever we keep as belt-
 * and-suspenders so the Claude-auth trio can NEVER enter via this seam.
 *
 * Source of truth: `@anthropic-ai/sandbox-runtime` `sandbox-utils.generateProxyEnvVars`
 * (`SANDBOX_RUNTIME`, `TMPDIR`, `CA_TRUST_VARS`, `NO_PROXY`/proxy/socks/git-ssh/docker/
 * cloudsdk/grpc vars) + `linux-sandbox-utils` (`CLAUDE_CODE_HOST_*_PROXY_PORT`). Raise
 * this set alongside the pinned-engine upgrade gate if the runtime adds a launch var.
 */
export const SANDBOX_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  // Sandbox markers + the per-session temp dir. NB: TMPDIR is allowlisted for the
  // WINDOWS path (where it rides in the returned env dict); on macOS/Linux it's baked
  // into the command string. Either way `homeEnv` (seedAgentHome's per-workspace tmp)
  // is layered LAST in mergeSandboxLaunchEnv, so the session's own TMPDIR wins by design.
  "SANDBOX_RUNTIME",
  "TMPDIR",
  // CA trust stores (CA_TRUST_VARS) — when the proxy terminates TLS the child must
  // trust the proxy-minted certs.
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  // Proxy routing (upper + lower case) — the egress floor. Without these the
  // sandboxed turn loses network on platforms that carry them in the returned env.
  "NO_PROXY",
  "no_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "FTP_PROXY",
  "ftp_proxy",
  "RSYNC_PROXY",
  "GRPC_PROXY",
  "grpc_proxy",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  // Git-over-SSH through the SOCKS/HTTP proxy.
  "GIT_SSH_COMMAND",
  // Linux bwrap host-proxy-port markers (debug/transparency).
  "CLAUDE_CODE_HOST_HTTP_PROXY_PORT",
  "CLAUDE_CODE_HOST_SOCKS_PROXY_PORT",
]);

/**
 * Compose the FINAL launch env for a sandboxed turn so the SCRUB WINS.
 *
 * Layering (lowest → highest precedence):
 *   1. `childEnv` — the scrubbed allowlist from {@link buildAgentChildEnv} (authoritative).
 *   2. the sandbox/proxy ALLOWLIST drawn from `wrappedEnv` ({@link SANDBOX_ENV_ALLOWLIST}),
 *      with {@link DENYLISTED_ENV} re-applied defensively — only known egress/sandbox
 *      vars layer on, never the daemon's ambient `process.env` (the old `...wrappedEnv`
 *      spread leaked it).
 *   3. `homeEnv` — `seedAgentHome`'s CLAUDE_CONFIG_DIR/XDG/TMP overrides win last.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` (set last by `buildAgentChildEnv`) survives: it is not in the
 * allowlist AND is denylisted, so step 2 can never overwrite it; step 3 doesn't set it.
 */
export function mergeSandboxLaunchEnv(
  childEnv: Record<string, string>,
  wrappedEnv: Record<string, string | undefined>,
  homeEnv: Record<string, string>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...childEnv };
  for (const [k, v] of Object.entries(wrappedEnv)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (!SANDBOX_ENV_ALLOWLIST.has(k)) continue; // drop the daemon's ambient env
    if (DENYLISTED_ENV.has(k)) continue; // never re-admit the Claude-auth trio here
    out[k] = v;
  }
  return { ...out, ...homeEnv };
}

/**
 * Build the scrubbed child env for the sandboxed claude. Mirrors runner's
 * passthrough allowlist MINUS `ANTHROPIC_API_KEY` (and the `ANTHROPIC_*`/`CLAUDE_*`
 * wildcards, which would re-admit it) — the channel session runs on the
 * interactive subscription, so an API key must never leak in (§6). The injected
 * `CLAUDE_CODE_OAUTH_TOKEN` is the session's auth.
 *
 * The sandbox engine's own env (proxy vars, sandbox markers) is layered on TOP of
 * this by {@link mergeSandboxLaunchEnv} — but as an ALLOWLIST
 * ({@link SANDBOX_ENV_ALLOWLIST}), NOT the whole returned `wrapped.env` (which is the
 * daemon's `process.env` and would re-admit the scrubbed secrets). This scrubbed env
 * is authoritative; only known sandbox/proxy keys + the home overrides layer on top.
 *
 * SECURITY POSTURE — the per-channel env injection (`channelEnv`):
 *
 *   The operator scopes a channel's spawned agent extra credentials/vars
 *   (`GH_TOKEN`, `CLOUDFLARE_API_TOKEN`, …) via the env store (credentials.ts).
 *   They are resolved at SPAWN time (issuance-time scoping: the sandbox only ever
 *   sees the minimal set the operator configured for THAT channel, never the
 *   daemon's own ambient process env), then merged here. The layering is precise
 *   so the injection can only ADD capability, never subvert the two guarantees:
 *
 *     1. `channelEnv` is applied FIRST (as the base), THEN the structural
 *        passthrough (PATH/HOME/locale) and FINALLY `CLAUDE_CODE_OAUTH_TOKEN` —
 *        so a channel-set var can never clobber the Claude auth token or a
 *        structural fundamental. (seedAgentHome's CLAUDE_CONFIG_DIR/XDG/TMP layer
 *        even later, in spawnAgent, so those win too.)
 *     2. Denylisted keys (ANTHROPIC_API_KEY / CLAUDE_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)
 *        are dropped defensively with a warning — the setter already blocks them
 *        and `resolveChannelEnv` already strips them, so this is belt-and-suspenders
 *        for a hand-edited credentials.json: the subscription-billing + managed-auth
 *        guarantee holds even if the store is tampered with.
 */
export function buildAgentChildEnv(
  parentEnv: Record<string, string | undefined>,
  claudeOauthToken: string,
  channelEnv: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};

  // 1. The operator-scoped per-channel env goes in FIRST (lowest precedence) so the
  //    structural passthrough + the Claude auth token below always win. Drop any
  //    denylisted key defensively (the store already blocks them; this guards a
  //    hand-edited file from smuggling an API key / a swapped OAuth token in).
  for (const [k, v] of Object.entries(channelEnv)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (DENYLISTED_ENV.has(k)) {
      console.warn(
        `parachute-agent: refusing to inject denylisted env var "${k}" from the channel env store ` +
          `(it controls Claude auth/billing) — skipping. Remove it from credentials.json.`,
      );
      continue;
    }
    out[k] = v;
  }

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
    "XDG_STATE_HOME",
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

  // IS_SANDBOX=1 — signal to claude that it is running INSIDE a sandbox (agent#155).
  // The programmatic turn always launches inside a bwrap/Seatbelt sandbox (that IS the
  // containment), so `--dangerously-skip-permissions` is safe — but Claude Code REFUSES
  // that flag under root/sudo ("cannot be used with root/sudo privileges for security
  // reasons") UNLESS `IS_SANDBOX` is set, which makes EVERY turn error on a daemon that
  // runs as root (e.g. the friends/team box). Setting it here makes the fix permanent +
  // automatic (it was being worked around per-deploy via the env store, which is lost on
  // reset). It defaults to "1" for every sandboxed turn but honors an explicit operator
  // value from `channelEnv` (already laid down above) — so an operator who deliberately
  // sets it can still override. NB: IS_SANDBOX is NOT in SANDBOX_ENV_ALLOWLIST and is not
  // set by `seedAgentHome`, so it survives `mergeSandboxLaunchEnv` un-clobbered — it can
  // never be reset to empty by the env-merge layering.
  if (typeof out.IS_SANDBOX !== "string" || out.IS_SANDBOX.length === 0) {
    out.IS_SANDBOX = "1";
  }

  // The interactive subscription credential (design §6). Explicitly the ONLY
  // Claude auth var set; ANTHROPIC_API_KEY is intentionally absent. Set LAST so no
  // channel-injected var can ever override the session's managed auth.
  out.CLAUDE_CODE_OAUTH_TOKEN = claudeOauthToken;
  return out;
}

/**
 * Create the agent's PRIVATE, WRITABLE HOME inside its workspace and seed it so
 * claude starts straight into a usable session — no onboarding flow, no per-folder
 * trust prompt — and so ALL of claude's config/cache/log/lock/temp writes land
 * here instead of EPERM-ing against the operator's (read-only, shared) real home.
 *
 * This is the keystone of a STABLE sandbox: claude always has a home it can fully
 * read AND write, decoupled from the operator's ~/.claude (so concurrent agents
 * never race/corrupt it).
 *
 * The seed is based on the operator's REAL `~/.claude.json` so the agent inherits
 * a fully-COMPLETED first run — onboarding, theme, and every version-migration
 * flag — which is robust to claude's evolving first-run sub-steps (chasing them
 * one-by-one is exactly the fragility this avoids). We then strip the heavy /
 * private bits: `projects` is REPLACED with just this workspace (pre-trusted), and
 * `oauthAccount` is dropped (the agent authenticates via CLAUDE_CODE_OAUTH_TOKEN).
 * If the operator has no config, fall back to the two flags that gate the prompts.
 *
 * Returns the env overrides (CLAUDE_CONFIG_DIR + XDG_* + the temp vars — NOT HOME,
 * which is deliberately left as the operator's so claude finds its real install) to
 * layer LAST over the launch env so they win over the inherited + engine env.
 * Idempotent: an existing seed is left as-is (claude owns it after first boot).
 * `operatorConfigPath` is injectable for tests.
 */
export function seedAgentHome(
  workspace: string,
  opts: { mcpServers?: string[]; operatorConfigPath?: string; projectRoot?: string } = {},
): Record<string, string> {
  const mcpServerNames = opts.mcpServers ?? [];
  const operatorConfigPath = opts.operatorConfigPath ?? join(homedir(), ".claude.json");
  // The project root claude pre-trusts in the seed. Defaults to the private
  // workspace (today's behavior), but when the agent's CWD is a shared working dir
  // (the spec's `workspace`), the CALLER passes that path here so claude's project
  // (= its cwd) is pre-trusted + its MCP servers pre-approved — otherwise the agent
  // would hit the per-folder trust / "new MCP server" prompts for the shared dir.
  // The seeded HOME/config/tmp still live UNDER the private `workspace` regardless.
  const projectRoot = opts.projectRoot ?? workspace;
  const home = join(workspace, "home");
  const claudeDir = join(home, ".claude");
  const tmp = join(workspace, "tmp");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  // claude reads its primary config from `$CLAUDE_CONFIG_DIR/.claude.json` when
  // CLAUDE_CONFIG_DIR is set (which we set below, to claudeDir) — NOT
  // `$HOME/.claude.json`. Seed THERE. Only seed if absent — after first boot
  // claude owns this file.
  const seedPath = join(claudeDir, ".claude.json");
  if (!existsSync(seedPath)) {
    let base: Record<string, unknown> = {};
    try {
      if (existsSync(operatorConfigPath)) {
        base = JSON.parse(readFileSync(operatorConfigPath, "utf-8")) as Record<string, unknown>;
      }
    } catch {
      base = {}; // unreadable/garbage operator config → minimal seed
    }
    delete base.oauthAccount; // don't copy the operator's account into the agent home
    const seed = {
      ...base,
      hasCompletedOnboarding: true,
      // Replace the operator's project history with ONLY the agent's project root
      // (its cwd — the private workspace by default, or the shared working dir when
      // the spec sets one), pre-trusted AND with our own configured MCP servers
      // pre-approved (claude otherwise prompts "New MCP server found in this
      // project" / the per-folder trust dialog — these are operator-configured, not
      // foreign, so pre-approve them).
      projects: {
        [projectRoot]: {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
          enabledMcpjsonServers: mcpServerNames,
          enableAllProjectMcpServers: true,
        },
      },
    };
    writeFileSync(seedPath, JSON.stringify(seed, null, 2) + "\n", { mode: 0o600 });
  }
  // settings.json: pre-suppress the "are you sure?" meta-prompt that
  // `--dangerously-skip-permissions` shows on first use (the operator's own config
  // sets this too). Without it, skip-permissions just trades one prompt for another.
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(
      settingsPath,
      JSON.stringify({ skipDangerousModePermissionPrompt: true }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
  // NOTE: we deliberately do NOT override HOME. claude resolves its own install
  // relative to $HOME (`$HOME/.local/...`); leaving HOME as the operator's means
  // claude finds its real install (no "setup issue", no per-spawn self-reinstall).
  // All of claude's WRITES are redirected to the per-session dirs below
  // (CLAUDE_CONFIG_DIR + XDG + temp), so it never EPERMs on the operator's
  // read-only home and concurrent agents don't share mutable config.
  return {
    CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_RUNTIME_DIR: join(home, ".run"),
    // claude's `/tmp/claude-<uid>` scratch dir follows CLAUDE_CODE_TMPDIR; TMPDIR/
    // TMP/TEMP cover everything else. All inside the writable workspace, so claude
    // never EPERMs on temp (the "could not start" death) regardless of read scope.
    TMPDIR: tmp,
    CLAUDE_CODE_TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // An ephemeral sandboxed agent shouldn't auto-update itself — it would download
    // a fresh claude into the per-session data dir on every spawn (bandwidth + disk
    // for nothing; the agent is gone when the session ends). This narrow flag
    // disables ONLY the updater — unlike CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    // which also disables the channels feature we depend on.
    DISABLE_AUTOUPDATER: "1",
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
