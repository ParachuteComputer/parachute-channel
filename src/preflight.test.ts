/**
 * Boot-time dependency PREFLIGHT tests (agent#156).
 *
 * A fresh box can't run a programmatic `claude -p` turn until bwrap/rg/socat + the
 * claude CLI are on PATH. `checkProgrammaticDeps` resolves each required binary via
 * an injectable `which` and reports exactly what's missing + a ready-to-log warning,
 * so the daemon can surface it ONCE at boot (and on /health) instead of letting each
 * gap surface as a separate failed turn.
 */

import { describe, test, expect } from "bun:test";
import {
  checkProgrammaticDeps,
  runBootPreflight,
  depsForPlatform,
  REQUIRED_DEPS,
  type WhichFn,
} from "./preflight.ts";

/** A `which` that resolves only the named bins (returns a fake abs path), null otherwise. */
function whichWith(present: string[]): WhichFn {
  const set = new Set(present);
  return (bin) => (set.has(bin) ? `/usr/bin/${bin}` : null);
}
/** A `which` that resolves NOTHING (fully-fresh box). */
const whichNone: WhichFn = () => null;

describe("checkProgrammaticDeps (linux)", () => {
  test("ALL present → ok, no missing, no warning", () => {
    const result = checkProgrammaticDeps(whichWith(REQUIRED_DEPS.map((d) => d.bin)), "linux");
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warning).toBeNull();
  });

  test("checks exactly bwrap, rg, socat, and claude on linux", () => {
    expect(depsForPlatform("linux").map((d) => d.bin)).toEqual(["bwrap", "rg", "socat", "claude"]);
  });

  test("a missing sandbox dep is reported with its install hint", () => {
    // bwrap absent, the rest present (the fresh-Ubuntu step-1 reproduction).
    const result = checkProgrammaticDeps(whichWith(["rg", "socat", "claude"]), "linux");
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.bin)).toEqual(["bwrap"]);
    expect(result.warning).toContain("bubblewrap");
    expect(result.warning).toContain("apt install bubblewrap");
  });

  test("a missing claude CLI is reported with the native-install one-liner", () => {
    const result = checkProgrammaticDeps(whichWith(["bwrap", "rg", "socat"]), "linux");
    expect(result.missing.map((d) => d.bin)).toEqual(["claude"]);
    expect(result.warning).toContain("claude.ai/install.sh");
  });

  test("a completely fresh box (nothing installed) lists ALL deps", () => {
    const result = checkProgrammaticDeps(whichNone, "linux");
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.bin)).toEqual(["bwrap", "rg", "socat", "claude"]);
    // The warning frames it as "programmatic turns will fail" — NOT a fatal error.
    expect(result.warning).toContain("Programmatic-backend turns will FAIL");
    expect(result.warning).toContain("attached-backend agents are unaffected");
  });

  test("a which() that throws treats the dep as missing (never swallows a gap)", () => {
    const throwingWhich: WhichFn = (bin) => {
      if (bin === "claude") throw new Error("which blew up");
      return `/usr/bin/${bin}`;
    };
    const result = checkProgrammaticDeps(throwingWhich, "linux");
    expect(result.missing.map((d) => d.bin)).toEqual(["claude"]);
  });
});

describe("checkProgrammaticDeps (macOS) — Seatbelt covers the sandbox, so bwrap/socat are NOT flagged", () => {
  test("macOS checks only rg + claude (bwrap/socat are linuxOnly)", () => {
    expect(depsForPlatform("darwin").map((d) => d.bin)).toEqual(["rg", "claude"]);
  });

  test("a Mac with rg + claude (but NO bwrap/socat) is OK — no false-positive warning", () => {
    // The documented preferred self-host path includes a Mac mini; bwrap/socat will
    // never exist there. Flagging them would train operators to ignore the preflight.
    const result = checkProgrammaticDeps(whichWith(["rg", "claude"]), "darwin");
    expect(result.ok).toBe(true);
    expect(result.warning).toBeNull();
  });

  test("a Mac still flags a missing claude (required on every platform)", () => {
    const result = checkProgrammaticDeps(whichWith(["rg"]), "darwin");
    expect(result.ok).toBe(false);
    expect(result.missing.map((d) => d.bin)).toEqual(["claude"]);
  });
});

describe("runBootPreflight", () => {
  test("logs the warning when deps are missing + returns the result", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const result = runBootPreflight(whichWith(["bwrap", "rg", "socat"]), "linux"); // claude missing
      expect(result.ok).toBe(false);
      expect(warnings.some((w) => w.includes("PREFLIGHT") && w.includes("claude"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("logs NOTHING when all deps are present", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const result = runBootPreflight(whichWith(REQUIRED_DEPS.map((d) => d.bin)), "linux");
      expect(result.ok).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      console.warn = orig;
    }
  });

  test("an unexpected fault is reported HONESTLY (ok:false), never a false all-clear", () => {
    // A which() that throws on EVERY bin makes the per-dep try/catch report all missing
    // (not a checkProgrammaticDeps throw) — so to exercise runBootPreflight's own catch we
    // pass a `which` whose very invocation can't be wrapped: simulate by throwing from the
    // platform filter is not reachable, so assert the per-dep path instead stays non-fatal.
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    try {
      const alwaysThrows: WhichFn = () => {
        throw new Error("boom");
      };
      // Every dep faults → all reported missing (per-dep catch), ok:false, warning present.
      const result = runBootPreflight(alwaysThrows, "linux");
      expect(result.ok).toBe(false);
      expect(result.warning).not.toBeNull();
    } finally {
      console.error = origErr;
    }
  });
});
