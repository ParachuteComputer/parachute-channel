/**
 * Tests for `resolveSpawnDeps` (`src/spawn-deps.ts`) — the real-dep resolver
 * shared by the CLI and the web spawn endpoint.
 *
 * The load-bearing regression guard here is the claude config binding: the
 * sandboxed `claude` MUST get `~/.claude.json` bound read-only, or it runs
 * first-run onboarding whose connectivity check is FATAL under the restricted
 * egress proxy and the tmux session dies instantly ("An unknown error occurred").
 * That bug shipped once; this test ensures the binding stays.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveSpawnDeps, SpawnDepsError } from "./spawn-deps.ts";

const savedHome = process.env.PARACHUTE_HOME;
let tmp: string | undefined;

afterEach(() => {
  if (savedHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = savedHome;
  if (tmp) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    tmp = undefined;
  }
});

describe("resolveSpawnDeps", () => {
  test("throws SpawnDepsError when there's no operator token", () => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-deps-empty-"));
    process.env.PARACHUTE_HOME = tmp; // no operator.token inside
    expect(() => resolveSpawnDeps()).toThrow(SpawnDepsError);
  });

  test("binds ~/.claude.json read-only (skip-onboarding regression guard)", () => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-deps-"));
    process.env.PARACHUTE_HOME = tmp;
    writeFileSync(join(tmp, "operator.token"), "fake-operator-bearer");
    const deps = resolveSpawnDeps();
    // The config FILE at the home root must be bound — this is the fix for the
    // onboarding-connectivity death under restricted egress.
    expect(deps.runtimeReadOnly).toContain(resolve(homedir(), ".claude.json"));
    // And the config DIR.
    const dir = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
    expect(deps.runtimeReadOnly).toContain(dir);
  });
});
