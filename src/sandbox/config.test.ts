import { describe, test, expect } from "bun:test";
import { buildSandboxConfig } from "./config.ts";
import type { AgentSpec, BaseBinds } from "./types.ts";
import type { EgressBaseInput } from "./egress.ts";

const BASE_BINDS: BaseBinds = {
  workspace: "/state/sessions/arm",
  runtimeReadOnly: ["/home/op/.claude"],
};
const EGRESS_BASE: EgressBaseInput = { hubOrigin: "https://hub.example.com" };

// Most cases exercise the egress floor, which needs network "restricted". Scoped
// reads are the DEFAULT (filesystem "workspace"), so the helper only sets the
// network and leaves filesystem at its default. A spread `p` overrides (e.g.
// `filesystem: "full"` to test broad reads).
function specOf(p: Partial<AgentSpec> = {}): AgentSpec {
  return { name: "arm", channels: ["ch"], network: "restricted", ...p };
}

describe("buildSandboxConfig — defaults (scoped reads + open network)", () => {
  test("DEFAULT: scoped reads (home tree denied) + open network (no allowedDomains), writes confined", () => {
    const cfg = buildSandboxConfig({
      spec: { name: "arm", channels: ["ch"] }, // no filesystem/network → both defaults
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    // Scoped reads by default: the home tree is DENIED — this is what keeps the
    // operator's secrets (~/.parachute/operator.token, SSH keys) unreadable.
    expect(cfg.filesystem.denyRead).toContain("/Users");
    // Open network by default: allowedDomains omitted entirely (runtime = no restriction).
    expect((cfg.network as { allowedDomains?: string[] }).allowedDomains).toBeUndefined();
    // Writes confined to the workspace.
    expect(cfg.filesystem.allowWrite).toContain("/state/sessions/arm");
  });

  test("filesystem 'full': broad reads (no home-tree deny), writes still confined", () => {
    const cfg = buildSandboxConfig({
      spec: { name: "arm", channels: ["ch"], filesystem: "full" },
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.filesystem.denyRead).toEqual([]);
    expect(cfg.filesystem.allowWrite).toContain("/state/sessions/arm");
  });
});

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
