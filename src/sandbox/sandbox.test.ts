import { describe, test, expect } from "bun:test";
import { Sandbox, configForSpec, type SandboxEngine } from "./index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec, BaseBinds } from "./types.ts";
import type { EgressBaseInput } from "./egress.ts";

const BASE_BINDS: BaseBinds = { workspace: "/state/sessions/arm", runtimeReadOnly: ["/cfg"] };
const EGRESS_BASE: EgressBaseInput = { hubOrigin: "https://hub.example.com" };

/** A fake engine that records what it was initialized with + what it wrapped. */
function fakeEngine(): SandboxEngine & {
  initializedWith: SandboxRuntimeConfig | null;
  wrappedCommands: string[];
  resets: number;
  calls: string[];
} {
  const rec = {
    initializedWith: null as SandboxRuntimeConfig | null,
    wrappedCommands: [] as string[],
    resets: 0,
    calls: [] as string[],
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    async initialize(cfg: SandboxRuntimeConfig) {
      rec.initializedWith = cfg;
      rec.calls.push("initialize");
    },
    async wrapWithSandboxArgv(command: string) {
      rec.wrappedCommands.push(command);
      rec.calls.push("wrap");
      return {
        argv: ["/bin/bash", "-c", `SANDBOXED ${command}`],
        env: { SANDBOX_RUNTIME: "1", HTTP_PROXY: "http://localhost:9999" },
      };
    },
    async reset() {
      rec.resets += 1;
      rec.calls.push("reset");
    },
  };
  return rec;
}

const SPEC: AgentSpec = {
  name: "arm",
  channels: ["ch"],
  egress: ["registry.npmjs.org"],
  mounts: [{ hostPath: "/proj", mountPath: "/work", mode: "rw" }],
};

describe("Sandbox adapter", () => {
  test("initializes the engine with the spec-derived config, then wraps the command", async () => {
    const engine = fakeEngine();
    const sandbox = new Sandbox(engine);
    const wrapped = await sandbox.wrap({
      spec: SPEC,
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      command: "claude --strict-mcp-config",
      platform: "darwin",
    });

    // It initialized with the right config (egress floor + scoped reads).
    expect(engine.initializedWith).not.toBeNull();
    expect(engine.initializedWith!.network.allowedDomains).toContain("api.anthropic.com");
    expect(engine.initializedWith!.network.allowedDomains).toContain("registry.npmjs.org");
    expect(engine.initializedWith!.filesystem.denyRead).toContain("/Users");
    expect(engine.initializedWith!.filesystem.allowWrite).toContain("/proj");

    // It wrapped exactly the command we passed.
    expect(engine.wrappedCommands).toEqual(["claude --strict-mcp-config"]);

    // It returns argv + env + the config used.
    expect(wrapped.argv[0]).toBe("/bin/bash");
    expect(wrapped.argv[2]).toContain("SANDBOXED claude");
    expect(wrapped.env.SANDBOX_RUNTIME).toBe("1");
    expect(wrapped.config).toBe(engine.initializedWith!);
  });

  test("wrap() RESETS the singleton before initializing (no stale proxy/config leak across spawns)", async () => {
    const engine = fakeEngine();
    const sandbox = new Sandbox(engine);
    await sandbox.wrap({
      spec: SPEC,
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      command: "claude",
    });
    // The order matters: reset → initialize → wrap. Without the leading reset, a
    // prior spawn's network config (e.g. HTTP_PROXY from a restricted session)
    // leaks into this wrap and an open session routes to a dead proxy → dies.
    expect(engine.calls).toEqual(["reset", "initialize", "wrap"]);
  });

  test("a RESTRICTED spawn's proxy env does NOT leak into a later OPEN spawn (the real-bug scenario)", async () => {
    // A leak-MODELING engine, mirroring the real singleton: `initialize` turns the
    // proxy on iff the config has an allowlist (restricted); `wrap` emits HTTP_PROXY
    // iff the proxy is on; `reset` turns it off. Without the reset-before-init in
    // Sandbox.wrap, the proxy would still be on from the restricted spawn and leak
    // into the open spawn's env — exactly the live failure.
    let proxyOn = false;
    const engine: SandboxEngine = {
      isSupportedPlatform: () => true,
      isSandboxingEnabled: () => true,
      async initialize(cfg: SandboxRuntimeConfig) {
        if ((cfg.network as { allowedDomains?: string[] }).allowedDomains) proxyOn = true;
      },
      async wrapWithSandboxArgv(command: string) {
        return { argv: ["/bin/bash", "-c", command], env: proxyOn ? { HTTP_PROXY: "http://localhost:1" } : {} };
      },
      async reset() {
        proxyOn = false;
      },
    };
    const sandbox = new Sandbox(engine);
    // 1) restricted spawn → proxy on, HTTP_PROXY present.
    const restricted = await sandbox.wrap({ spec: { name: "r", channels: ["c"] }, baseBinds: BASE_BINDS, egressBase: EGRESS_BASE, command: "claude" });
    expect(restricted.env.HTTP_PROXY).toBeDefined();
    // 2) open spawn right after → the per-wrap reset clears the proxy, so NO stale
    //    HTTP_PROXY leaks in (the bug: claude would route to the dead proxy + die).
    const open = await sandbox.wrap({ spec: { name: "o", channels: ["c"], egressUnrestricted: true }, baseBinds: BASE_BINDS, egressBase: EGRESS_BASE, command: "claude" });
    expect(open.env.HTTP_PROXY).toBeUndefined();
  });

  test("reset() tears the engine down", async () => {
    const engine = fakeEngine();
    const sandbox = new Sandbox(engine);
    await sandbox.reset();
    expect(engine.resets).toBe(1);
  });

  test("isSupportedPlatform delegates to the engine", () => {
    const engine = fakeEngine();
    expect(new Sandbox(engine).isSupportedPlatform()).toBe(true);
  });

  test("SECURITY: a spec omitting egress still gets the base floor in the engine config", async () => {
    const engine = fakeEngine();
    const sandbox = new Sandbox(engine);
    await sandbox.wrap({
      spec: { name: "x", channels: ["c"] }, // no egress declared
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      command: "claude",
      platform: "darwin",
    });
    expect(engine.initializedWith!.network.allowedDomains).toContain("api.anthropic.com");
    expect(engine.initializedWith!.network.allowedDomains).toContain("hub.example.com");
  });
});

describe("configForSpec helper", () => {
  test("builds the config without touching an engine", () => {
    const cfg = configForSpec({
      spec: SPEC,
      baseBinds: BASE_BINDS,
      egressBase: EGRESS_BASE,
      platform: "darwin",
    });
    expect(cfg.network.allowedDomains).toContain("registry.npmjs.org");
    expect(cfg.filesystem.allowWrite).toContain("/proj");
  });
});
