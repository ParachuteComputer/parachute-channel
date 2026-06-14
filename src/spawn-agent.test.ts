import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnAgent,
  buildAgentChildEnv,
  buildAgentClaudeArgs,
  sessionName,
  shellJoin,
  type SpawnAgentDeps,
  type TmuxLauncher,
} from "./spawn-agent.ts";
import type { SandboxEngine } from "./sandbox/index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec } from "./sandbox/types.ts";
import { channelEntryKey, vaultEntryKey } from "./agent-mcp-config.ts";

let sessionsDir: string;
afterEach(() => {
  if (sessionsDir) rmSync(sessionsDir, { recursive: true, force: true });
});

// ---- fakes -----------------------------------------------------------------

/** A recording tmux launcher. */
function recordingTmux(existing = new Set<string>()): TmuxLauncher & {
  launched: Array<{ name: string; argv: string[]; env: Record<string, string | undefined>; cwd: string }>;
} {
  const launched: Array<{
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
  }> = [];
  return {
    launched,
    async hasSession(name) {
      return existing.has(name);
    },
    async newSession(opts) {
      launched.push(opts);
    },
  };
}

/** A fake sandbox engine — records config, returns a deterministic wrap. */
function fakeEngine(): SandboxEngine & { initializedWith: SandboxRuntimeConfig | null } {
  const rec = {
    initializedWith: null as SandboxRuntimeConfig | null,
    isSupportedPlatform: () => true,
    isSandboxingEnabled: () => true,
    async initialize(cfg: SandboxRuntimeConfig) {
      rec.initializedWith = cfg;
    },
    async wrapWithSandboxArgv(command: string) {
      // Emulate the real shape: a bash -c wrapper carrying the command + proxy env.
      return {
        argv: ["/bin/bash", "-c", `SBX ${command}`],
        env: { SANDBOX_RUNTIME: "1", HTTPS_PROXY: "http://localhost:5555" },
      };
    },
    async reset() {},
  };
  return rec;
}

/** A fake mint hub: returns a distinct token per scope so we can tell them apart. */
function fakeMintFetch(): typeof fetch {
  let n = 0;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
    n += 1;
    const token = `TOK-${n}-${body.scope.replace(/[^a-z]/gi, "").slice(0, 6)}`;
    return new Response(
      JSON.stringify({ jti: `j${n}`, token, expires_at: "2026-09-01T00:00:00Z", scope: body.scope }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

function baseDeps(over: Partial<SpawnAgentDeps> = {}): SpawnAgentDeps {
  return {
    hubOrigin: "https://hub.example.com",
    managerBearer: "MANAGER",
    channelUrl: "http://127.0.0.1:1941",
    vaultUrl: "http://127.0.0.1:1940",
    sessionsDir,
    runtimeReadOnly: ["/cfg/.claude"],
    claudeOauthToken: "OAUTH-CRED-PLACEHOLDER",
    sandboxEngine: fakeEngine(),
    tmux: recordingTmux(),
    fetchFn: fakeMintFetch(),
    parentEnv: {
      PATH: "/usr/bin",
      HOME: "/home/op",
      ANTHROPIC_API_KEY: "sk-ant-SHOULD-NOT-LEAK",
      CLAUDE_API_KEY: "also-should-not-leak",
      SECRET_THING: "do-not-pass",
    },
    claudeBin: "claude",
    ...over,
  };
}

// ---- pure-helper tests -----------------------------------------------------

describe("buildAgentChildEnv — scrub, inject OAuth, NEVER ANTHROPIC_API_KEY", () => {
  test("injects CLAUDE_CODE_OAUTH_TOKEN as the session auth", () => {
    const env = buildAgentChildEnv({ PATH: "/usr/bin", HOME: "/h" }, "THE-OAUTH-TOKEN");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("THE-OAUTH-TOKEN");
  });

  test("SECURITY: ANTHROPIC_API_KEY is NOT passed through (would route to API billing)", () => {
    const env = buildAgentChildEnv(
      { PATH: "/usr/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-x", CLAUDE_API_KEY: "y" },
      "tok",
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
  });

  test("scrubs unrelated parent env (only the allowlist + locale pass)", () => {
    const env = buildAgentChildEnv(
      { PATH: "/usr/bin", HOME: "/h", SECRET_THING: "nope", LC_ALL: "en_US.UTF-8" },
      "tok",
    );
    expect(env.SECRET_THING).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/h");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
  });

  test("provides a default PATH if the parent had none", () => {
    const env = buildAgentChildEnv({}, "tok");
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
  });
});

describe("buildAgentClaudeArgs", () => {
  test("interactive claude (no -p) with strict MCP config + dev-channels for the first channel", () => {
    const argv = buildAgentClaudeArgs({
      mcpConfigPath: "/ws/.mcp.json",
      firstChannelEntryKey: "channel-aaron-dev",
    });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/ws/.mcp.json");
    expect(argv).toContain("--dangerously-load-development-channels=server:channel-aaron-dev");
    // NOT headless: no `-p`.
    expect(argv).not.toContain("-p");
  });
});

describe("shellJoin", () => {
  test("leaves safe args bare, quotes args with spaces", () => {
    expect(shellJoin(["claude", "--mcp-config", "/a/b.json"])).toBe("claude --mcp-config /a/b.json");
    expect(shellJoin(["echo", "a b"])).toBe("echo 'a b'");
  });
});

// ---- full wiring tests -----------------------------------------------------

describe("spawnAgent — full wiring with stubs (no real token)", () => {
  test("creates the tmux session, writes a strict MCP config, injects OAuth, omits ANTHROPIC_API_KEY", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-"));
    const tmux = recordingTmux();
    const engine = fakeEngine();
    const spec: AgentSpec = {
      name: "aaron-dev",
      channels: ["aaron-dev"],
      vault: { name: "default", access: "read", tags: ["#channel-message"] },
    };
    const res = await spawnAgent(spec, baseDeps({ tmux, sandboxEngine: engine }));

    // 1. tmux session created with the spec's name.
    expect(res.alreadyRunning).toBe(false);
    expect(res.session).toBe(sessionName("aaron-dev"));
    expect(tmux.launched).toHaveLength(1);
    const launch = tmux.launched[0]!;
    expect(launch.name).toBe("aaron-dev-agent");

    // 2. The launched argv is the sandbox wrapper carrying the claude command.
    expect(launch.argv[0]).toBe("/bin/bash");
    expect(launch.argv[2]).toContain("SBX claude");
    expect(launch.argv[2]).toContain("--strict-mcp-config");

    // 3. The injected env has CLAUDE_CODE_OAUTH_TOKEN and NO ANTHROPIC_API_KEY.
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launch.env.CLAUDE_API_KEY).toBeUndefined();
    // ...and the sandbox proxy env layered on top.
    expect(launch.env.SANDBOX_RUNTIME).toBe("1");
    expect(launch.env.HTTPS_PROXY).toBe("http://localhost:5555");

    // 4. The MCP config has the right entries with DISTINCT tokens (one per aud).
    const parsed = JSON.parse(res.mcpConfigJson) as {
      mcpServers: Record<string, { url: string; headers?: { Authorization: string } }>;
    };
    const chKey = channelEntryKey("aaron-dev");
    const vKey = vaultEntryKey("default");
    expect(parsed.mcpServers[chKey]!.url).toBe("http://127.0.0.1:1941/mcp/aaron-dev");
    expect(parsed.mcpServers[vKey]!.url).toBe("http://127.0.0.1:1940/vault/default/mcp");
    const chAuth = parsed.mcpServers[chKey]!.headers!.Authorization;
    const vAuth = parsed.mcpServers[vKey]!.headers!.Authorization;
    expect(chAuth).toMatch(/^Bearer TOK-/);
    expect(vAuth).toMatch(/^Bearer TOK-/);
    expect(chAuth).not.toBe(vAuth); // distinct tokens, distinct auds

    // 5. The on-disk config is 0600 (it inlines tokens).
    const mcpPath = join(res.workspace, ".mcp.json");
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(mcpPath, "utf8")).toBe(res.mcpConfigJson);

    // 6. The sandbox config carried the egress floor + scoped reads.
    expect(engine.initializedWith!.network.allowedDomains).toContain("api.anthropic.com");
    expect(engine.initializedWith!.network.allowedDomains).toContain("hub.example.com");
    expect(engine.initializedWith!.filesystem.allowWrite).toContain(res.workspace);
  });

  test("mints ONE token per channel for a multi-channel spec", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-multi-"));
    const spec: AgentSpec = { name: "multi", channels: ["a", "b"] };
    const res = await spawnAgent(spec, baseDeps());
    expect(Object.keys(res.tokens)).toContain("a");
    expect(Object.keys(res.tokens)).toContain("b");
    expect(res.tokens.a!.token).not.toBe(res.tokens.b!.token);
    const parsed = JSON.parse(res.mcpConfigJson) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers[channelEntryKey("a")]).toBeDefined();
    expect(parsed.mcpServers[channelEntryKey("b")]).toBeDefined();
  });

  test("tag-scoped vault: the scoped_tags permission rides the vault mint request", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-vault-"));
    const calls: Array<Record<string, unknown>> = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push(body);
      return new Response(
        JSON.stringify({ jti: "j", token: `T-${calls.length}`, expires_at: "", scope: body.scope }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const spec: AgentSpec = {
      name: "weaver",
      channels: ["c"],
      vault: { name: "default", access: "read", tags: ["#channel-message"] },
    };
    await spawnAgent(spec, baseDeps({ fetchFn }));
    const vaultCall = calls.find((c) => String(c.scope).startsWith("vault:"));
    expect(vaultCall).toBeDefined();
    expect(vaultCall!.scope).toBe("vault:default:read");
    expect(vaultCall!.permissions).toEqual({ scoped_tags: ["#channel-message"] });
  });

  test("idempotent: an already-running session is a no-op", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-idem-"));
    const tmux = recordingTmux(new Set(["arm-agent"]));
    const res = await spawnAgent({ name: "arm", channels: ["c"] }, baseDeps({ tmux }));
    expect(res.alreadyRunning).toBe(true);
    expect(tmux.launched).toHaveLength(0);
  });

  test("a spec with no channels is rejected", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-noch-"));
    await expect(spawnAgent({ name: "x", channels: [] }, baseDeps())).rejects.toThrow(/no channels/);
  });

  test("SECURITY: an over-broad mint (hub 400) aborts the launch — no tmux session created", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-deny-"));
    const tmux = recordingTmux();
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ error: "invalid_scope", error_description: "not grantable by this bearer" }),
        { status: 400, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    await expect(
      spawnAgent({ name: "x", channels: ["c"] }, baseDeps({ tmux, fetchFn })),
    ).rejects.toThrow(/mint refused/);
    // The attenuation failure happened BEFORE any tmux launch.
    expect(tmux.launched).toHaveLength(0);
  });

  test("SECURITY: an adversarial spec.name is rejected BEFORE any fs/tmux/mint side effect", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-name-"));
    for (const bad of ["..", "a/b", "a b", "../escape", ".", "a..b", "x;rm", ""]) {
      const tmux = recordingTmux();
      let minted = false;
      const fetchFn = (async () => {
        minted = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      await expect(
        spawnAgent({ name: bad, channels: ["c"] }, baseDeps({ tmux, fetchFn })),
      ).rejects.toThrow(/slug/);
      // No side effects: no tmux launch, no mint attempt.
      expect(tmux.launched).toHaveLength(0);
      expect(minted).toBe(false);
    }
  });

  test("a valid slug name is accepted (dashes + underscores ok)", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-okname-"));
    const res = await spawnAgent({ name: "aaron_dev-2", channels: ["c"] }, baseDeps());
    expect(res.alreadyRunning).toBe(false);
    expect(res.session).toBe("aaron_dev-2-agent");
  });

  test("read-only channel mints channel:read ONLY (not read+write)", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-roch-"));
    const scopes: string[] = [];
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
      scopes.push(body.scope);
      return new Response(
        JSON.stringify({ jti: "j", token: `T-${scopes.length}`, expires_at: "", scope: body.scope }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const spec: AgentSpec = {
      name: "watcher",
      channels: [
        { name: "readonly-ch", access: "read" },
        { name: "rw-ch", access: "write" },
        "bare-ch", // bare string = write (back-compat)
      ],
    };
    await spawnAgent(spec, baseDeps({ fetchFn }));
    expect(scopes).toContain("channel:read"); // the read-only channel
    expect(scopes.filter((s) => s === "channel:read")).toHaveLength(1);
    expect(scopes.filter((s) => s === "channel:read channel:write")).toHaveLength(2); // rw + bare
  });

  test("CONCURRENCY: two concurrent spawnAgent calls produce correct, independent MCP configs + wrapping", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-conc-"));
    // Independent engines/tmux per call so we can assert no cross-clobber. Each
    // mint hub returns a token namespaced to the spec so configs are tellable apart.
    function depsForArm(arm: string) {
      let n = 0;
      const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
        n += 1;
        return new Response(
          JSON.stringify({ jti: `${arm}-${n}`, token: `${arm}-TOK-${n}`, expires_at: "", scope: body.scope }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;
      return baseDeps({ tmux: recordingTmux(), sandboxEngine: fakeEngine(), fetchFn });
    }

    const [a, b] = await Promise.all([
      spawnAgent({ name: "arm-a", channels: ["ca"] }, depsForArm("A")),
      spawnAgent({ name: "arm-b", channels: ["cb"] }, depsForArm("B")),
    ]);

    // Each got its OWN channel entry + token — no clobber across the race.
    const pa = JSON.parse(a.mcpConfigJson) as { mcpServers: Record<string, { url: string; headers?: { Authorization: string } }> };
    const pb = JSON.parse(b.mcpConfigJson) as { mcpServers: Record<string, { url: string; headers?: { Authorization: string } }> };
    expect(pa.mcpServers[channelEntryKey("ca")]!.url).toBe("http://127.0.0.1:1941/mcp/ca");
    expect(pb.mcpServers[channelEntryKey("cb")]!.url).toBe("http://127.0.0.1:1941/mcp/cb");
    expect(pa.mcpServers[channelEntryKey("ca")]!.headers!.Authorization).toBe("Bearer A-TOK-1");
    expect(pb.mcpServers[channelEntryKey("cb")]!.headers!.Authorization).toBe("Bearer B-TOK-1");
    // Independent sandbox configs (each carries its own workspace allowWrite).
    expect(a.wrapped.config.filesystem.allowWrite).toContain(a.workspace);
    expect(b.wrapped.config.filesystem.allowWrite).toContain(b.workspace);
    expect(a.workspace).not.toBe(b.workspace);
  });

  test("CONCURRENCY: the init→wrap window is serialized (never two engines in it at once)", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-serial-"));
    // An engine whose initialize overlaps wrap by an await; if the lock didn't
    // hold, two would be "in the window" simultaneously and maxActive would be >1.
    let active = 0;
    let maxActive = 0;
    function slowEngine(): SandboxEngine {
      return {
        isSupportedPlatform: () => true,
        isSandboxingEnabled: () => true,
        async initialize() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Bun.sleep(15);
        },
        async wrapWithSandboxArgv(command: string) {
          await Bun.sleep(15);
          active -= 1;
          return { argv: ["/bin/bash", "-c", command], env: {} };
        },
        async reset() {},
      };
    }
    await Promise.all([
      spawnAgent({ name: "s-a", channels: ["c"] }, baseDeps({ sandboxEngine: slowEngine(), tmux: recordingTmux() })),
      spawnAgent({ name: "s-b", channels: ["c"] }, baseDeps({ sandboxEngine: slowEngine(), tmux: recordingTmux() })),
      spawnAgent({ name: "s-c", channels: ["c"] }, baseDeps({ sandboxEngine: slowEngine(), tmux: recordingTmux() })),
    ]);
    expect(maxActive).toBe(1);
  });
});
