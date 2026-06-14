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
} {
  const rec = {
    initializedWith: null as SandboxRuntimeConfig | null,
    wrappedCommands: [] as string[],
    resets: 0,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    async initialize(cfg: SandboxRuntimeConfig) {
      rec.initializedWith = cfg;
    },
    async wrapWithSandboxArgv(command: string) {
      rec.wrappedCommands.push(command);
      return {
        argv: ["/bin/bash", "-c", `SANDBOXED ${command}`],
        env: { SANDBOX_RUNTIME: "1", HTTP_PROXY: "http://localhost:9999" },
      };
    },
    async reset() {
      rec.resets += 1;
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
