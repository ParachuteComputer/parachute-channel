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

import { SandboxManager as RealSandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec, BaseBinds, SandboxPlatform } from "./types.ts";
import { buildSandboxConfig, currentSandboxPlatform } from "./config.ts";
import type { EgressBaseInput } from "./egress.ts";

export type { AgentSpec, AgentMount, AgentVaultSpec, OtherMcpSpec, BaseBinds, MountMode, SandboxPlatform } from "./types.ts";
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
