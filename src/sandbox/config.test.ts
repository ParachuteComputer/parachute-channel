import { describe, test, expect } from "bun:test";
import { buildSandboxConfig } from "./config.ts";
import type { AgentSpec, BaseBinds } from "./types.ts";
import type { EgressBaseInput } from "./egress.ts";

const BASE_BINDS: BaseBinds = {
  workspace: "/state/sessions/arm",
  runtimeReadOnly: ["/home/op/.claude"],
};
const EGRESS_BASE: EgressBaseInput = { hubOrigin: "https://hub.example.com" };

function specOf(p: Partial<AgentSpec> = {}): AgentSpec {
  return { name: "arm", channels: ["ch"], ...p };
}

describe("buildSandboxConfig — spec → SandboxRuntimeConfig", () => {
  test("network: deny-by-default + base floor present, deniedDomains empty", () => {
    const cfg = buildSandboxConfig({
      spec: specOf({ egress: [] }),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.network.allowedDomains).toContain("api.anthropic.com");
    expect(cfg.network.allowedDomains).toContain("hub.example.com");
    expect(cfg.network.deniedDomains).toEqual([]);
  });

  test("SECURITY: a spec with foreign egress still carries the base floor", () => {
    const cfg = buildSandboxConfig({
      spec: specOf({ egress: ["registry.npmjs.org"] }),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.network.allowedDomains).toContain("api.anthropic.com");
    expect(cfg.network.allowedDomains).toContain("hub.example.com");
    expect(cfg.network.allowedDomains).toContain("registry.npmjs.org");
  });

  test("filesystem: scoped reads (deny home tree, re-allow binds) + write confinement", () => {
    const cfg = buildSandboxConfig({
      spec: specOf({ mounts: [{ hostPath: "/proj", mountPath: "/work", mode: "rw" }] }),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.filesystem.denyRead).toContain("/Users");
    expect(cfg.filesystem.allowRead).toContain("/state/sessions/arm");
    expect(cfg.filesystem.allowRead).toContain("/home/op/.claude");
    expect(cfg.filesystem.allowRead).toContain("/proj");
    expect(cfg.filesystem.allowWrite).toContain("/state/sessions/arm");
    expect(cfg.filesystem.allowWrite).toContain("/proj");
  });

  test("Linux platform denies /home instead of /Users", () => {
    const cfg = buildSandboxConfig({
      spec: specOf(),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "linux",
    });
    expect(cfg.filesystem.denyRead).toContain("/home");
    expect(cfg.filesystem.denyRead).not.toContain("/Users");
  });

  test("allowPty defaults true (interactive claude needs a pty)", () => {
    const cfg = buildSandboxConfig({
      spec: specOf(),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.allowPty).toBe(true);
  });

  test("ripgrep override threads through when provided", () => {
    const cfg = buildSandboxConfig({
      spec: specOf(),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
      ripgrep: { command: "/abs/rg" },
    });
    expect(cfg.ripgrep).toEqual({ command: "/abs/rg" });
  });

  test("the produced config matches the runtime's required shape (keys present)", () => {
    const cfg = buildSandboxConfig({
      spec: specOf(),
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.network).toHaveProperty("allowedDomains");
    expect(cfg.network).toHaveProperty("deniedDomains");
    expect(cfg.filesystem).toHaveProperty("denyRead");
    expect(cfg.filesystem).toHaveProperty("allowRead");
    expect(cfg.filesystem).toHaveProperty("allowWrite");
    expect(cfg.filesystem).toHaveProperty("denyWrite");
  });
});
