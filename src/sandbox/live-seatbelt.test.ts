/**
 * LIVE sandbox-runtime assertions on this host (Seatbelt on macOS).
 *
 * These run a REAL sandboxed process and assert it is genuinely confined:
 *   - egress to a non-allowlisted host is DENIED;
 *   - egress to an allowlisted host is permitted to ATTEMPT (proxy admits it);
 *   - a read OUTSIDE the declared binds is DENIED;
 *   - a read INSIDE a bind is permitted.
 *
 * The sandbox-runtime singleton starts host proxies on `initialize` and tears
 * them down on `reset`; it is process-global, so these cases serialize (one
 * describe block, sequential `initialize`→wrap→reset per case). Sandboxed in a
 * fresh temp workspace — NEVER the operator's live ~/.parachute.
 *
 * Skipped automatically when the platform can't sandbox (`isSupportedPlatform()`
 * false) or its deps aren't satisfied — so CI on an unsupported runner stays
 * green while a capable host (this Mac) exercises the real boundary. The
 * config-shape tests (egress/mounts/config.test.ts) ALWAYS run regardless.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { buildSandboxConfig } from "./config.ts";
import type { AgentSpec, BaseBinds } from "./types.ts";

const CAN_SANDBOX =
  SandboxManager.isSupportedPlatform() && SandboxManager.checkDependencies().errors.length === 0;

// A positive control: prove the harness can actually run a sandboxed process at
// all before asserting on denials (negative-scans-need-positive-controls).
const d = CAN_SANDBOX ? describe : describe.skip;

async function runSandboxed(
  cfg: ReturnType<typeof buildSandboxConfig>,
  command: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  await SandboxManager.initialize(cfg);
  try {
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv(command);
    const proc = Bun.spawn(argv, {
      env: env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    await SandboxManager.reset();
  }
}

let workspace: string;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

d("LIVE Seatbelt — network egress", () => {
  test("positive control: the harness can run a trivial sandboxed command", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-pos-"));
    const spec: AgentSpec = { name: "pos", channels: ["c"], network: "restricted", egress: [] };
    const cfg = buildSandboxConfig({
      spec,
      baseBinds: { workspace, runtimeReadOnly: [] },
      egressBase: { hubOrigin: "http://127.0.0.1:1939" },
      platform: "darwin",
    });
    const r = await runSandboxed(cfg, "echo sandbox-alive");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sandbox-alive");
  }, 60_000);

  test("DENIED: curl to a host NOT in the allowlist is blocked", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-deny-"));
    // Allowlist the base only (anthropic + the loopback hub). example.com is NOT on it.
    const spec: AgentSpec = { name: "deny", channels: ["c"], network: "restricted", egress: [] };
    const cfg = buildSandboxConfig({
      spec,
      baseBinds: { workspace, runtimeReadOnly: [] },
      egressBase: { hubOrigin: "http://127.0.0.1:1939" },
      platform: "darwin",
    });
    const r = await runSandboxed(
      cfg,
      "curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com",
    );
    // The egress proxy refuses a non-allowlisted host: curl exits non-zero
    // (commonly 56 "CONNECT tunnel failed, response 403"). The key assertion is
    // that the request did NOT succeed with a 2xx.
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toMatch(/^2\d\d$/);
  }, 60_000);

  test("a spec that adds an egress host gets that host on the allowlist (additive)", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-add-"));
    const spec: AgentSpec = { name: "add", channels: ["c"], network: "restricted", egress: ["example.com"] };
    const cfg = buildSandboxConfig({
      spec,
      baseBinds: { workspace, runtimeReadOnly: [] },
      egressBase: { hubOrigin: "http://127.0.0.1:1939" },
      platform: "darwin",
    });
    // We assert the CONFIG carries the host (a live fetch to example.com would be
    // a network-flaky external dependency; the denial test above is the live
    // boundary proof). The base floor is also present.
    expect(cfg.network.allowedDomains).toContain("example.com");
    expect(cfg.network.allowedDomains).toContain("api.anthropic.com");
  }, 60_000);
});

d("LIVE Seatbelt — filesystem read confinement", () => {
  test("DENIED: reading a file OUTSIDE the declared binds fails", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-read-"));
    // A secret OUTSIDE the workspace, under a sibling temp dir we do NOT bind.
    const secretDir = mkdtempSync(join(tmpdir(), "sbx-live-secret-"));
    const secretFile = join(secretDir, "secret.txt");
    writeFileSync(secretFile, "TOPSECRET-do-not-read");
    try {
      const spec: AgentSpec = { name: "read", channels: ["c"], network: "restricted", egress: [] };
      const cfg = buildSandboxConfig({
        spec,
        baseBinds: { workspace, runtimeReadOnly: [] },
        egressBase: { hubOrigin: "http://127.0.0.1:1939" },
        platform: "darwin",
      });
      // Deny the temp root so the unbound secret dir is unreadable; re-allow only
      // the workspace. (buildSandboxConfig denies /Users; the macOS temp dir lives
      // under /var/folders, so we additionally deny the secret's parent to make the
      // confinement assertion robust regardless of where the OS placed the tmp dir.)
      cfg.filesystem.denyRead = [...cfg.filesystem.denyRead, secretDir];
      const r = await runSandboxed(cfg, `cat ${secretFile}`);
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain("TOPSECRET");
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("PRODUCTION PATH: the spec-derived /Users deny blocks a read of a real home-dir file (no manual patch)", async () => {
    // The §4.5 scoped-read property is "an arm cannot read the operator's home."
    // Prove it through the PRODUCTION config — secret under the REAL home dir,
    // workspace also under home (so the re-allow path is exercised against the
    // real `/Users` deny), and NO manual `denyRead` patch. This is the test that
    // proves the deployed `denyRead:["/Users"]` actually confines reads.
    const home = homedir();
    workspace = mkdtempSync(join(home, ".sbx-live-ws-"));
    const secretDir = mkdtempSync(join(home, ".sbx-live-secret-"));
    const secretFile = join(secretDir, "home-secret.txt");
    writeFileSync(secretFile, "HOME-TOPSECRET-do-not-read");
    try {
      const spec: AgentSpec = { name: "homeread", channels: ["c"], network: "restricted", egress: [] };
      // buildSandboxConfig with platform "darwin" → denyRead:["/Users"],
      // allowRead:[workspace]. We pass the config THROUGH unmodified.
      const cfg = buildSandboxConfig({
        spec,
        baseBinds: { workspace, runtimeReadOnly: [] },
        egressBase: { hubOrigin: "http://127.0.0.1:1939" },
        platform: "darwin",
      });
      expect(cfg.filesystem.denyRead).toEqual(["/Users"]);
      expect(cfg.filesystem.allowRead).toContain(workspace);
      // The secret sits under /Users/<me>/… and is NOT in any bind → blocked.
      const r = await runSandboxed(cfg, `cat ${secretFile}`);
      expect(r.code).not.toBe(0);
      expect(r.stdout).not.toContain("HOME-TOPSECRET");

      // Positive control on the SAME production config: a file inside the
      // workspace (also under /Users, but re-allowed by allowRead) IS readable —
      // proving the deny didn't just break all reads.
      const insideFile = join(workspace, "inside.txt");
      writeFileSync(insideFile, "HOME-WORKSPACE-readable");
      const ok = await runSandboxed(cfg, `cat ${insideFile}`);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("HOME-WORKSPACE-readable");
    } finally {
      rmSync(secretDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("DEFAULT POSTURE: ~/.parachute (operator.token's dir) is UNREADABLE, the workspace IS readable, network is OPEN", async () => {
    // The security guarantee Aaron asked for: the DEFAULT spawn (no filesystem/no
    // network knob) must (a) be unable to read the operator's secrets — modelled by
    // a decoy planted in the REAL ~/.parachute, exactly where operator.token lives —
    // while (b) still having the workspace readable and (c) the network fully OPEN.
    // Reads scoped by default; internet open by default.
    const home = homedir();
    workspace = mkdtempSync(join(home, ".sbx-live-default-ws-"));
    const decoy = join(home, ".parachute", `.sbx-live-decoy-${process.pid}.txt`);
    writeFileSync(decoy, "OPERATOR-TOKEN-DECOY-do-not-read");
    try {
      // DEFAULT spec: neither filesystem nor network set → workspace-scoped reads + open net.
      const spec: AgentSpec = { name: "deflt", channels: ["c"] };
      const cfg = buildSandboxConfig({
        spec,
        baseBinds: { workspace, runtimeReadOnly: [] },
        egressBase: { hubOrigin: "http://127.0.0.1:1939" },
        platform: "darwin",
      });
      // Defaults: scoped reads (/Users denied) + OPEN network (no allowedDomains).
      expect(cfg.filesystem.denyRead).toEqual(["/Users"]);
      expect((cfg.network as { allowedDomains?: string[] }).allowedDomains).toBeUndefined();

      // (a) the decoy in ~/.parachute is DENIED — operator.token is equally unreadable.
      const blocked = await runSandboxed(cfg, `cat ${decoy}`);
      expect(blocked.code).not.toBe(0);
      expect(blocked.stdout).not.toContain("OPERATOR-TOKEN-DECOY");

      // (b) positive control: a workspace file IS readable under the SAME config.
      const inside = join(workspace, "inside.txt");
      writeFileSync(inside, "WORKSPACE-readable-by-default");
      const ok = await runSandboxed(cfg, `cat ${inside}`);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain("WORKSPACE-readable-by-default");
    } finally {
      rmSync(decoy, { force: true });
    }
  }, 60_000);

  test("ALLOWED: reading a file INSIDE the workspace bind succeeds", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-read-ok-"));
    const f = join(workspace, "inside.txt");
    writeFileSync(f, "READABLE-inside-workspace");
    const spec: AgentSpec = { name: "readok", channels: ["c"], network: "restricted", egress: [] };
    const cfg = buildSandboxConfig({
      spec,
      baseBinds: { workspace, runtimeReadOnly: [] },
      egressBase: { hubOrigin: "http://127.0.0.1:1939" },
      platform: "darwin",
    });
    const r = await runSandboxed(cfg, `cat ${f}`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("READABLE-inside-workspace");
  }, 60_000);

  test("DENIED: writing OUTSIDE the workspace fails (write confinement)", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-write-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "sbx-live-outside-"));
    const target = join(outsideDir, "should-not-exist.txt");
    try {
      const spec: AgentSpec = { name: "write", channels: ["c"], network: "restricted", egress: [] };
      const cfg = buildSandboxConfig({
        spec,
        baseBinds: { workspace, runtimeReadOnly: [] },
        egressBase: { hubOrigin: "http://127.0.0.1:1939" },
        platform: "darwin",
      });
      const r = await runSandboxed(cfg, `echo pwned > ${target}`);
      expect(r.code).not.toBe(0);
      // The file must not have been created (write was blocked at the OS level).
      expect(await Bun.file(target).exists()).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("ALLOWED: writing INSIDE the workspace succeeds", async () => {
    workspace = mkdtempSync(join(tmpdir(), "sbx-live-write-ok-"));
    const target = join(workspace, "out.txt");
    const spec: AgentSpec = { name: "writeok", channels: ["c"], network: "restricted", egress: [] };
    const cfg = buildSandboxConfig({
      spec,
      baseBinds: { workspace, runtimeReadOnly: [] },
      egressBase: { hubOrigin: "http://127.0.0.1:1939" },
      platform: "darwin",
    });
    const r = await runSandboxed(cfg, `echo written-inside > ${target}`);
    expect(r.code).toBe(0);
    const written = await Bun.file(target).text();
    expect(written).toContain("written-inside");
  }, 60_000);
});
