/**
 * The `Sandbox` adapter — the constant contract, the per-platform mechanism
 * behind it (design §3.1).
 *
 * v1 mechanism: Anthropic's `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS,
 * bubblewrap on Linux). We reach it by **library link** — never PATH resolution
 * (design Q4 decision: a poisoned PATH entry would execute *before* the sandbox
 * is established). The `SandboxManager` singleton is imported at module load, so
 * the trust boundary is anchored to the pinned, library-resolved artifact.
 *
 * The adapter wraps the singleton so callers depend on this small surface — not
 * on the runtime's full API — and so the escalation rung (§3.4) can become a
 * second backend behind the same contract later. `SandboxManager` being a
 * process-global singleton (one set of host proxies) means launches serialize
 * through `initialize` → wrap → reset; the adapter makes that explicit.
 */

// `@anthropic-ai/sandbox-runtime` is pinned EXACT (not `^`) in package.json — it's
// an anthropic-experimental research preview whose config/API may evolve between
// patch releases, and it is the load-bearing isolation engine. Treat a version
// bump as an upgrade-gate: only raise the pin behind a green run of the sandbox
// test suite (esp. the LIVE Seatbelt assertions in `live-seatbelt.test.ts`, which
// prove the real boundary still holds against the new version). On a bump, also
// re-check `SANDBOX_ENV_ALLOWLIST` (spawn-agent.ts) against the runtime's
// `generateProxyEnvVars` — a new proxy/launch var the engine emits must be added
// there or egress silently breaks on Windows (where those vars ride in the env dict).
import { SandboxManager as RealSandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec, BaseBinds, SandboxPlatform } from "./types.ts";
import { buildSandboxConfig, currentSandboxPlatform } from "./config.ts";
import type { EgressBaseInput } from "./egress.ts";

export type {
  AgentSpec,
  AgentMount,
  AgentVaultSpec,
  AgentChannel,
  AgentChannelSpec,
  OtherMcpSpec,
  BaseBinds,
  MountMode,
  SandboxPlatform,
} from "./types.ts";
export { normalizeChannel } from "./types.ts";
export {
  composeEgressAllowlist,
  baseEgressAllowlist,
  hostFromOrigin,
  ANTHROPIC_EGRESS_HOSTS,
  type EgressBaseInput,
} from "./egress.ts";
export {
  composeFilesystemView,
  homeTreeDenyRoot,
  sharedMounts,
  type FilesystemView,
} from "./mounts.ts";
export { buildSandboxConfig, currentSandboxPlatform, type BuildSandboxConfigInput } from "./config.ts";

/**
 * The minimal slice of the sandbox-runtime singleton the adapter uses. Pinned
 * here so a test can inject a fake without depending on the full runtime API,
 * and so a drift in the runtime's surface fails the typecheck loudly.
 */
export interface SandboxEngine {
  isSupportedPlatform(): boolean;
  isSandboxingEnabled(): boolean;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  /** Wrap a shell command string; returns the argv + env to spawn. */
  wrapWithSandboxArgv(
    command: string,
  ): Promise<{ argv: string[]; env: Record<string, string | undefined> }>;
  reset(): Promise<void>;
}

/** The real engine, library-linked (never via PATH). */
export const defaultEngine: SandboxEngine = RealSandboxManager as unknown as SandboxEngine;

export interface WrapInput {
  spec: AgentSpec;
  baseBinds: BaseBinds;
  egressBase: EgressBaseInput;
  /** The shell command to run sandboxed (e.g. the `claude …` invocation). */
  command: string;
  platform?: SandboxPlatform;
  allowPty?: boolean;
  ripgrep?: { command: string; args?: string[] };
}

export interface WrappedCommand {
  /** argv to spawn (Seatbelt/bubblewrap wrapper + the command). */
  argv: string[];
  /** env the wrapper needs (proxy vars, sandbox markers). */
  env: Record<string, string | undefined>;
  /** The config the engine was initialized with (for assertion/audit/logging). */
  config: SandboxRuntimeConfig;
}

/**
 * The `Sandbox` — initialize the engine with the spec's config, then wrap the
 * command. The returned `{argv, env}` is what the spawn step launches in tmux.
 *
 * Serialization caveat: the engine is a process-global singleton (it starts host
 * egress proxies on `initialize` and tears them down on `reset`). v1 launches one
 * sandboxed session at a time through this path; concurrent launches must
 * serialize. The injectable `engine` keeps this unit-testable + lets a future
 * per-session backend (§3.4) slot in.
 */
export class Sandbox {
  private readonly engine: SandboxEngine;

  constructor(engine: SandboxEngine = defaultEngine) {
    this.engine = engine;
  }

  /** Whether this host can sandbox at all (Seatbelt present / bubblewrap deps). */
  isSupportedPlatform(): boolean {
    return this.engine.isSupportedPlatform();
  }

  /**
   * Build the config from the spec, initialize the engine, and wrap the command.
   * The config is returned so callers can assert/log the exact allowlist + binds.
   */
  async wrap(input: WrapInput): Promise<WrappedCommand> {
    const config = buildSandboxConfig({
      spec: input.spec,
      baseBinds: input.baseBinds,
      egressBase: input.egressBase,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.allowPty !== undefined ? { allowPty: input.allowPty } : {}),
      ...(input.ripgrep ? { ripgrep: input.ripgrep } : {}),
    });
    // Reset the process-global singleton BEFORE re-initializing. Without this, a
    // prior spawn's network config leaks into this wrap: most visibly, an OPEN
    // (no-proxy) session inherits a prior RESTRICTED session's `HTTP(S)_PROXY` env
    // (baked into the wrapped argv), so claude routes to a now-wrong/absent proxy
    // and dies with "An unknown error occurred (Unexpected)". Reset → initialize →
    // wrap runs inside the caller's spawn lock, so each spawn produces a wrap that
    // reflects ONLY its own config. (Caveat: because the singleton's host proxies
    // are global, resetting here tears down a concurrently-running RESTRICTED
    // session's proxy on the next spawn — a known v1 limitation of the singleton
    // backend; OPEN sessions use no proxy and are unaffected. The escalation rung
    // §3.4 is a per-session backend that removes this.)
    try {
      await this.engine.reset();
    } catch {
      // Any reset error is ignored: on the first-ever wrap there's nothing to tear
      // down, and a later teardown fault must not block the (re-)initialize that
      // follows. The fresh initialize() below re-establishes a clean state regardless.
    }
    await this.engine.initialize(config);
    const { argv, env } = await this.engine.wrapWithSandboxArgv(input.command);
    return { argv, env, config };
  }

  /** Tear down the engine's host proxies. Call on session death. */
  async reset(): Promise<void> {
    await this.engine.reset();
  }
}

/** Convenience: just build the config (no engine init) — used in tests + audits. */
export function configForSpec(input: {
  spec: AgentSpec;
  baseBinds: BaseBinds;
  egressBase: EgressBaseInput;
  platform?: SandboxPlatform;
  allowPty?: boolean;
}): SandboxRuntimeConfig {
  return buildSandboxConfig({
    spec: input.spec,
    baseBinds: input.baseBinds,
    egressBase: input.egressBase,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.allowPty !== undefined ? { allowPty: input.allowPty } : {}),
  });
}

export { currentSandboxPlatform as platform };
