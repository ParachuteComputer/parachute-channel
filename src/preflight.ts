/**
 * Boot-time dependency PREFLIGHT (agent#156).
 *
 * A freshly-provisioned box can't run a programmatic `claude -p` turn until the
 * sandbox deps (`bwrap`, `rg`, `socat`) AND the `claude` CLI are installed — but
 * pre-#156 each missing piece surfaced ONLY as a failed *turn*, one at a time, so
 * an operator discovered them serially (install bwrap → next turn fails on rg →
 * install rg → next turn fails on claude → …).
 *
 * This lifts the check to DAEMON BOOT: resolve each required binary on PATH ONCE
 * and log a single clear warning naming exactly what's missing + the one-liner to
 * fix it. It is a WARNING, never a crash — the daemon may run only `attached`-backend
 * agents (which don't spawn `claude -p` and need no sandbox/claude), so a missing
 * dep means "programmatic turns will fail until …", not "the daemon can't start."
 *
 * Deliberately NOT a full doctor framework — a focused boot preflight + clear log is
 * the whole of #156. (`spawn-deps.ts`'s turn-time check still stands as the last line
 * of defence for a dep removed AFTER boot.)
 */

/**
 * One required external binary the programmatic backend needs on PATH, with the
 * one-liner that installs it on a fresh Debian/Ubuntu box (the #156 reproduction).
 */
interface RequiredDep {
  /** The binary name resolved on PATH (`Bun.which`). */
  bin: string;
  /** Human label for the warning. */
  label: string;
  /** The install hint shown when it's missing. */
  hint: string;
  /**
   * True when this dep is only required on LINUX. On macOS the sandbox uses Seatbelt
   * (built in, no helper binaries), so the bubblewrap egress-proxy deps (`bwrap`,
   * `socat`) aren't needed — flagging them on a Mac deploy (the documented preferred
   * self-host path) would be a false-positive that trains operators to ignore the
   * preflight. So they're checked on Linux only. (`rg` is NOT linux-only: the runtime's
   * deny-path scan needs a real ripgrep on macOS too. `claude` is needed everywhere.)
   */
  linuxOnly?: boolean;
}

/**
 * The deps a programmatic `claude -p` turn needs. `bwrap`/`socat` are the LINUX
 * bubblewrap sandbox deps the runtime shells out to (bubblewrap is the containment,
 * socat bridges the egress proxy) — not needed under macOS Seatbelt, so `linuxOnly`.
 * `rg` (ripgrep) does the deny-path scan on EVERY platform (the macOS sandbox needs a
 * real `rg` too). `claude` is the CLI the turn runs, required everywhere. The platform
 * filter is applied in {@link checkProgrammaticDeps}.
 */
export const REQUIRED_DEPS: readonly RequiredDep[] = [
  { bin: "bwrap", label: "bubblewrap (bwrap)", hint: "apt install bubblewrap", linuxOnly: true },
  { bin: "rg", label: "ripgrep (rg)", hint: "apt install ripgrep" },
  { bin: "socat", label: "socat", hint: "apt install socat", linuxOnly: true },
  {
    bin: "claude",
    label: "Claude Code CLI (claude)",
    hint: "curl -fsSL https://claude.ai/install.sh | bash  (native build — no node/npm needed)",
  },
] as const;

/** A resolver from binary name → absolute path (or null when not on PATH). Injectable for tests. */
export type WhichFn = (bin: string) => string | null;

/** The default resolver — Bun.which against the daemon's PATH. */
export const realWhich: WhichFn = (bin) => Bun.which(bin);

/** Which {@link REQUIRED_DEPS} apply on the given platform (drops `linuxOnly` deps off Linux). */
export function depsForPlatform(platform: NodeJS.Platform = process.platform): RequiredDep[] {
  return REQUIRED_DEPS.filter((d) => !d.linuxOnly || platform === "linux");
}

/** The outcome of {@link checkProgrammaticDeps}: which required deps are missing + a ready-to-log warning. */
export interface PreflightResult {
  /** The deps NOT resolvable on PATH (empty = all present). */
  missing: RequiredDep[];
  /** True when every required dep resolved (nothing to warn about). */
  ok: boolean;
  /**
   * The formatted multi-line warning to log, or null when nothing is missing. Lists
   * each missing dep + its install one-liner, framed as "programmatic turns will fail
   * until …" (attached-backend agents are unaffected).
   */
  warning: string | null;
}

/**
 * PURE check: resolve each platform-applicable {@link REQUIRED_DEPS} binary via `which`
 * and build the missing-deps result + warning text. No I/O beyond the injected `which`;
 * no logging (the caller logs). Cheap + idempotent — safe to call at boot. `platform` is
 * injectable so a test can assert the macOS filter without running on a Mac.
 */
export function checkProgrammaticDeps(
  which: WhichFn = realWhich,
  platform: NodeJS.Platform = process.platform,
): PreflightResult {
  const missing = depsForPlatform(platform).filter((d) => {
    try {
      return !which(d.bin);
    } catch {
      // A which() fault is treated as "can't confirm it's present" → report it missing
      // (better a spurious advisory than silently swallowing a real gap).
      return true;
    }
  });
  if (missing.length === 0) return { missing: [], ok: true, warning: null };
  const lines = missing.map((d) => `    - ${d.label}: ${d.hint}`);
  const warning =
    `parachute-agent: PREFLIGHT — ${missing.length} dependency/dependencies for programmatic ` +
    `(claude -p) turns is/are NOT on PATH. Programmatic-backend turns will FAIL until installed ` +
    `(attached-backend agents are unaffected):\n${lines.join("\n")}`;
  return { missing, ok: false, warning };
}

/**
 * Run the boot preflight: check the deps and LOG the warning once (via `console.warn`)
 * when anything is missing. Returns the {@link PreflightResult} so the caller can also
 * surface the missing-deps state elsewhere (e.g. `/health`). Never throws — the daemon
 * keeps booting regardless.
 */
export function runBootPreflight(
  which: WhichFn = realWhich,
  platform: NodeJS.Platform = process.platform,
): PreflightResult {
  let result: PreflightResult;
  try {
    result = checkProgrammaticDeps(which, platform);
  } catch (err) {
    // Defensive: the preflight must never break boot. An unexpected fault is reported
    // HONESTLY (ok:false + the error in the warning) rather than a false "all clear" —
    // but it's still non-fatal; the daemon boots and the turn-time check in
    // spawn-deps.ts remains the real guard.
    const msg = `parachute-agent: boot preflight errored (continuing, dependency state UNKNOWN): ${(err as Error).message}`;
    console.error(msg);
    return { missing: [], ok: false, warning: msg };
  }
  if (result.warning) console.warn(result.warning);
  return result;
}
