/**
 * Map an agent-spec → a `SandboxRuntimeConfig` for `@anthropic-ai/sandbox-runtime`
 * (design §3 — the isolation envelope).
 *
 * The runtime config shape (verified against the package's own types,
 * `@anthropic-ai/sandbox-runtime` 0.0.54 `SandboxRuntimeConfig`):
 *
 *   {
 *     network:    { allowedDomains: string[], deniedDomains: string[] },
 *     filesystem: { denyRead: string[], allowRead?: string[],
 *                   allowWrite: string[], denyWrite: string[] },
 *     …optional knobs (allowPty, bwrapPath, ripgrep, …)
 *   }
 *
 * This module is the single place spec → runtime-config happens, so the egress
 * floor (§4.4) and scoped-read policy (§4.5) are guaranteed on every launch.
 */

import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec, BaseBinds, SandboxPlatform } from "./types.ts";
import { composeEgressAllowlist, type EgressBaseInput } from "./egress.ts";
import { composeFilesystemView } from "./mounts.ts";

export interface BuildSandboxConfigInput {
  spec: AgentSpec;
  /** Workspace + runtime/config binds the contract always grants. */
  baseBinds: BaseBinds;
  /** Origins for the non-removable egress base. */
  egressBase: EgressBaseInput;
  /** Target platform. Defaults to the running platform. */
  platform?: SandboxPlatform;
  /**
   * Allow the session to allocate a pty (a tmux/interactive `claude` needs one).
   * Defaults true. Surfaced so a non-interactive arm can drop it.
   */
  allowPty?: boolean;
  /**
   * Optional ripgrep override the runtime uses for deny-path scanning. On macOS
   * the runtime needs a ripgrep binary; pass `{ command: <abs path> }` when the
   * host has no `rg` on PATH. Omitted = the runtime's own resolution.
   */
  ripgrep?: { command: string; args?: string[] };
}

/** Resolve the running platform to the two we support. */
export function currentSandboxPlatform(): SandboxPlatform {
  return process.platform === "darwin" ? "darwin" : "linux";
}

/**
 * Build the `SandboxRuntimeConfig` for an agent spec. The egress allowlist is the
 * non-removable base unioned with the spec's additions; the filesystem view is
 * scoped-read (home-tree denied, binds re-allowed) with writes confined to the
 * workspace + rw mounts.
 */
export function buildSandboxConfig(input: BuildSandboxConfigInput): SandboxRuntimeConfig {
  const platform = input.platform ?? currentSandboxPlatform();

  const fs = composeFilesystemView(input.baseBinds, input.spec.mounts, platform);

  // Network: by default the non-removable base unioned with the spec's additions.
  // When the spec opts into `egressUnrestricted`, we OMIT `allowedDomains` entirely
  // — the sandbox-runtime treats an absent allowedDomains as "no network
  // restriction" (verified: present-but-empty = block all; absent = allow all).
  // The cast is because the runtime's TS type marks allowedDomains required while
  // its runtime honors the absent case as the documented allow-all path.
  const network: SandboxRuntimeConfig["network"] = input.spec.egressUnrestricted
    ? ({ deniedDomains: [] } as unknown as SandboxRuntimeConfig["network"])
    : { allowedDomains: composeEgressAllowlist(input.egressBase, input.spec.egress), deniedDomains: [] };

  const config: SandboxRuntimeConfig = {
    network,
    filesystem: {
      denyRead: fs.denyRead,
      allowRead: fs.allowRead,
      allowWrite: fs.allowWrite,
      denyWrite: fs.denyWrite,
    },
    allowPty: input.allowPty ?? true,
  };
  if (input.ripgrep) config.ripgrep = input.ripgrep;
  return config;
}
