import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnAgent,
  buildAgentChildEnv,
  buildAgentClaudeArgs,
  buildLaunchScript,
  realTmuxLauncher,
  sessionName,
  shellJoin,
  type SpawnAgentDeps,
  type TmuxLauncher,
} from "./spawn-agent.ts";
import type { SandboxEngine } from "./sandbox/index.ts";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { AgentSpec } from "./sandbox/types.ts";
import { channelEntryKey, vaultEntryKey } from "./agent-mcp-config.ts";
import {
  setDefaultClaudeCredential,
  setChannelClaudeCredential,
} from "./credentials.ts";

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
        // Include a TMPDIR the engine would set — spawnAgent must OVERRIDE it with
        // a workspace-writable path (the override regression guard below).
        env: { SANDBOX_RUNTIME: "1", HTTPS_PROXY: "http://localhost:5555", TMPDIR: "/tmp/claude" },
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
    // Stub the credential resolver so the test never touches a real store; the
    // assertion below checks this exact token lands in CLAUDE_CODE_OAUTH_TOKEN.
    resolveClaudeToken: () => "OAUTH-CRED-PLACEHOLDER",
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

    // 3b. TMPDIR (+ claude-specific + generic) point at a WRITABLE dir inside the
    // workspace, OVERRIDING the sandbox engine's own TMPDIR — without this claude
    // can't create its scratch dir and dies "Claude Code could not start: EPERM".
    const wsTmp = join(res.workspace, "tmp");
    expect(launch.env.TMPDIR).toBe(wsTmp);
    expect(launch.env.CLAUDE_CODE_TMPDIR).toBe(wsTmp);
    expect(launch.env.TMP).toBe(wsTmp);
    expect(launch.env.TEMP).toBe(wsTmp);
    // ...and the dir is actually created on disk (writable, where the child looks).
    expect(statSync(wsTmp).isDirectory()).toBe(true);

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

// ---- credential wiring (Stream 3 — resolve from the per-channel store) -------

describe("spawnAgent — resolves the Claude credential from the per-channel store", () => {
  let storeDir: string;
  afterEach(() => {
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
  });

  // The wiring under test reads `credentials.ts` keyed on the WAKE channel (the
  // first channel). These tests use the REAL resolver (no `resolveClaudeToken`
  // stub) against a throwaway store, proving the end-to-end resolve→inject path.
  function depsWithRealResolver(): SpawnAgentDeps {
    const d = baseDeps();
    delete (d as { resolveClaudeToken?: unknown }).resolveClaudeToken;
    return d;
  }

  test("injects the PER-CHANNEL override when the wake channel has one", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-cred-ovr-"));
    storeDir = mkdtempSync(join(tmpdir(), "channel-creds-ovr-"));
    setDefaultClaudeCredential("oat_DEFAULT", storeDir);
    setChannelClaudeCredential("aaron-dev", "oat_AARON-OVERRIDE", storeDir);

    const tmux = recordingTmux();
    const deps = { ...depsWithRealResolver(), tmux, resolveClaudeToken: (ch: string) => resolveAgainst(storeDir, ch) };
    const res = await spawnAgent({ name: "aaron-dev", channels: ["aaron-dev"] }, deps);
    expect(res.alreadyRunning).toBe(false);
    // The override (not the default) lands in CLAUDE_CODE_OAUTH_TOKEN.
    expect(tmux.launched[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat_AARON-OVERRIDE");
    expect(tmux.launched[0]!.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("falls back to the DEFAULT/operator token when the wake channel has no override", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-cred-def-"));
    storeDir = mkdtempSync(join(tmpdir(), "channel-creds-def-"));
    setDefaultClaudeCredential("oat_DEFAULT", storeDir);

    const tmux = recordingTmux();
    const deps = { ...baseDeps(), tmux, resolveClaudeToken: (ch: string) => resolveAgainst(storeDir, ch) };
    const res = await spawnAgent({ name: "other", channels: ["unconfigured-ch"] }, deps);
    expect(res.alreadyRunning).toBe(false);
    expect(tmux.launched[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat_DEFAULT");
  });

  test("resolves on the WAKE channel (first), not a later one", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-cred-wake-"));
    storeDir = mkdtempSync(join(tmpdir(), "channel-creds-wake-"));
    setDefaultClaudeCredential("oat_DEFAULT", storeDir);
    setChannelClaudeCredential("first", "oat_FIRST", storeDir);
    setChannelClaudeCredential("second", "oat_SECOND", storeDir);

    const tmux = recordingTmux();
    const deps = { ...baseDeps(), tmux, resolveClaudeToken: (ch: string) => resolveAgainst(storeDir, ch) };
    await spawnAgent({ name: "multi", channels: ["first", "second"] }, deps);
    // The wake channel is the first → its override is the session's auth.
    expect(tmux.launched[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat_FIRST");
  });

  test("SECURITY: an unconfigured store ABORTS the launch BEFORE any mint/tmux side effect", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-cred-none-"));
    storeDir = mkdtempSync(join(tmpdir(), "channel-creds-none-")); // empty store
    const tmux = recordingTmux();
    let minted = false;
    const fetchFn = (async () => {
      minted = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const deps = { ...baseDeps(), tmux, fetchFn, resolveClaudeToken: (ch: string) => resolveAgainst(storeDir, ch) };
    await expect(
      spawnAgent({ name: "x", channels: ["ghost"] }, deps),
    ).rejects.toThrow(/no Claude credential/);
    // No session launched, no token minted.
    expect(tmux.launched).toHaveLength(0);
    expect(minted).toBe(false);
  });
});

// Resolve against a specific store dir (the real resolver hard-wires the default
// state dir; this test helper threads the throwaway dir through, exercising the
// SAME `resolveClaudeCredential` the production resolver calls).
function resolveAgainst(storeDir: string, channel: string): string {
  const { resolveClaudeCredential } = require("./credentials.ts") as typeof import("./credentials.ts");
  return resolveClaudeCredential(channel, storeDir);
}

// ---- buildLaunchScript (the tmux-buffer fix) -------------------------------

describe("buildLaunchScript — script body per argv shape, token-free", () => {
  test("macOS `/bin/bash -c <cmd>` shape: the body IS the command", () => {
    const script = buildLaunchScript(["/bin/bash", "-c", "sandbox-exec -p '...' claude --foo"]);
    expect(script.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
    expect(script).toContain("sandbox-exec -p '...' claude --foo");
    // No `exec <bash> -c` re-wrapping for this canonical shape.
    expect(script).not.toContain("exec /bin/bash");
  });

  test("general argv (Linux bubblewrap shape): exec's the quoted argv", () => {
    const script = buildLaunchScript(["bwrap", "--ro-bind", "/usr", "/usr", "claude", "--mcp-config", "/ws/.mcp.json"]);
    expect(script.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
    expect(script).toContain("exec bwrap --ro-bind /usr /usr claude --mcp-config /ws/.mcp.json");
  });
});

describe("realTmuxLauncher — launch-script indirection (tmux can't take the ~84KB profile inline)", () => {
  /** A recording spawnFn matching the `Bun.spawn` shape the launcher awaits. */
  function recordingSpawn(): {
    fn: typeof Bun.spawn;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const fn = ((argv: string[]) => {
      calls.push(argv);
      return {
        exited: Promise.resolve(0),
        stderr: new Response("").body,
      };
    }) as unknown as typeof Bun.spawn;
    return { fn, calls };
  }

  test("a >100KB wrapped command is NOT passed inline — tmux gets a short script-path argv; the script is written 0600 with the command; token rides env via -e", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "launch-script-"));
    try {
      // A wrapped argv whose command embeds a giant (>100KB) profile inline — the
      // exact shape that overran tmux's buffer in the integration smoke.
      const bigProfile = "X".repeat(100_000);
      const bigCommand = `sandbox-exec -p '${bigProfile}' claude --strict-mcp-config --mcp-config ${join(workspace, ".mcp.json")}`;
      const wrappedArgv = ["/bin/bash", "-c", bigCommand];
      expect(bigCommand.length).toBeGreaterThan(100_000);

      const { fn, calls } = recordingSpawn();
      const launcher = realTmuxLauncher(fn);
      await launcher.newSession({
        name: "big-agent",
        argv: wrappedArgv,
        env: { CLAUDE_CODE_OAUTH_TOKEN: "OAUTH-SECRET", SANDBOX_RUNTIME: "1" },
        cwd: workspace,
      });

      // (a) the argv handed to tmux is SHORT — a script path, not the 100KB inline.
      expect(calls).toHaveLength(1);
      const tmuxArgv = calls[0]!;
      const scriptPath = join(workspace, ".launch.sh");
      expect(tmuxArgv[tmuxArgv.length - 2]).toBe("/bin/bash");
      expect(tmuxArgv[tmuxArgv.length - 1]).toBe(scriptPath);
      // The 100KB profile is NOWHERE on the tmux command line.
      expect(tmuxArgv.some((a) => a.length > 50_000)).toBe(false);
      expect(tmuxArgv.join(" ")).not.toContain(bigProfile);

      // (b) the launch script is written, mode 0600, and contains the wrapped command.
      expect(statSync(scriptPath).mode & 0o777).toBe(0o600);
      const body = readFileSync(scriptPath, "utf8");
      expect(body.startsWith("#!/bin/bash\nset -euo pipefail\n")).toBe(true);
      expect(body).toContain(bigCommand);

      // (c) env still passed via `-e KEY=VAL`.
      expect(tmuxArgv).toContain("-e");
      expect(tmuxArgv).toContain("CLAUDE_CODE_OAUTH_TOKEN=OAUTH-SECRET");
      expect(tmuxArgv).toContain("SANDBOX_RUNTIME=1");

      // SECURITY: the secret rides the ENV, never the script body.
      expect(body).not.toContain("OAUTH-SECRET");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
