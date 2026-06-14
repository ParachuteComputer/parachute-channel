/**
 * Filesystem-view composition: scoped reads + write confinement (design §3.1
 * item 2, §4.5).
 *
 * The contract:
 *
 *   - WRITES are confined to the private per-session workspace plus any `rw`
 *     mount the spec declares. The sandbox-runtime's write model is allow-only:
 *     `allowWrite: [...binds]`, empty = no writes.
 *
 *   - READS are scoped to declared binds — a DELIBERATE divergence from
 *     Anthropic's broad-read default (design §4.5). The runtime's read model is
 *     deny-then-allow: by default everything is readable. To confine reads we
 *     DENY the home tree (`/Users` on macOS, `/home` on Linux) and then RE-ALLOW
 *     exactly the binds (workspace + runtime/config + declared mounts). System
 *     paths (`/usr`, `/lib`, …) stay readable so `claude` + its toolchain run.
 *     `allowRead` overrides `denyRead` in the runtime, so the re-allow wins.
 *
 * Platform nuance (verified against the runtime README "Path Syntax"):
 *   - macOS: paths support git-style globs.
 *   - Linux: literal paths only — no glob matching.
 * We never synthesize globs; we bind the literal host paths the caller passes,
 * which is correct on both platforms. The `platform` arg only selects the
 * home-tree deny root.
 */

import type { AgentMount, BaseBinds, SandboxPlatform } from "./types.ts";

/** The home-tree root denied for scoped reads, per platform. */
export function homeTreeDenyRoot(platform: SandboxPlatform): string {
  return platform === "darwin" ? "/Users" : "/home";
}

export interface FilesystemView {
  /** Paths to deny reads under (the home tree) — scoped-read enforcement. */
  denyRead: string[];
  /** Paths to re-allow reads within the denied region (the binds). */
  allowRead: string[];
  /** Paths writes are confined to (workspace + rw mounts). */
  allowWrite: string[];
  /** Paths to deny writes within allowed regions. Empty in v1. */
  denyWrite: string[];
}

/**
 * Compose the filesystem view for an arm from the always-present base binds and
 * the spec's additive mounts.
 *
 * Read surface  = workspace (rw) + runtime/config (ro) + every declared mount
 *                 (ro and rw alike — you can read what you can write).
 * Write surface = workspace (rw) + every `rw` mount.
 *
 * The home tree is denied and the read surface re-allowed within it, giving the
 * scoped-read policy (§4.5). The base binds are always included regardless of
 * the spec, so a spec cannot strip its own workspace or the runtime/config.
 */
export function composeFilesystemView(
  base: BaseBinds,
  mounts: readonly AgentMount[] | undefined,
  platform: SandboxPlatform,
): FilesystemView {
  const declared = mounts ?? [];

  // Every bind is readable; only workspace + rw mounts are writable.
  const readPaths: string[] = [base.workspace, ...base.runtimeReadOnly];
  const writePaths: string[] = [base.workspace];

  for (const m of declared) {
    readPaths.push(m.hostPath);
    if (m.mode === "rw") writePaths.push(m.hostPath);
  }

  return {
    denyRead: [homeTreeDenyRoot(platform)],
    allowRead: dedupePreserveOrder(readPaths),
    allowWrite: dedupePreserveOrder(writePaths),
    denyWrite: [],
  };
}

/**
 * The cross-session `shared` mounts declared by a spec (design §4.5). v1 honors
 * them by binding them like any other mount (composeFilesystemView already does);
 * this helper surfaces them by name so a caller can log/audit the deliberate
 * cross-session channel. The trust caveat (prefer shared-`ro` from the producer,
 * never shared-`rw` across a trust boundary) is doc-level for v1.
 */
export function sharedMounts(mounts: readonly AgentMount[] | undefined): AgentMount[] {
  return (mounts ?? []).filter((m) => typeof m.shared === "string" && m.shared.length > 0);
}

function dedupePreserveOrder(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
