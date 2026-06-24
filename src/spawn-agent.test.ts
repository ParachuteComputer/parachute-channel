import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// SHARED spawn helpers (live tree).
import {
  buildAgentChildEnv,
  mergeSandboxLaunchEnv,
  SANDBOX_ENV_ALLOWLIST,
  resolveAgentCwd,
  seedAgentHome,
  sessionWorkspace,
  shellJoin,
  persistSpec,
  readPersistedSpec,
  specFilePath,
} from "./spawn-agent.ts";
// PARKED interactive spawner (the interactive backend retired 2026-06-19; its
// spawner + tmux launcher live in src/_parked/interactive-spawn.ts now — these tests
// still exercise that parked code so it stays buildable for the future revival).
import {
  spawnAgent,
  buildAgentClaudeArgs,
  buildLaunchScript,
  confirmDevChannelsPrompt,
  DEV_CHANNELS_PROMPT_MARKER,
  DEV_CHANNELS_READY_MARKER,
  realTmuxLauncher,
  sessionName,
  type SpawnAgentDeps,
  type TmuxLauncher,
} from "./_parked/interactive-spawn.ts";
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
  launched: Array<{
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
    scriptDir?: string;
  }>;
  confirmed: string[];
} {
  const launched: Array<{
    name: string;
    argv: string[];
    env: Record<string, string | undefined>;
    cwd: string;
    scriptDir?: string;
  }> = [];
  const confirmed: string[] = [];
  return {
    launched,
    confirmed,
    async hasSession(name) {
      return existing.has(name);
    },
    async newSession(opts) {
      launched.push(opts);
    },
    async confirmDevChannelsPrompt(session) {
      confirmed.push(session);
      return "confirmed";
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

  test("INJECTION: the per-channel env reaches the child (gh/git see the token)", () => {
    const env = buildAgentChildEnv(
      { PATH: "/usr/bin", HOME: "/h" },
      "tok",
      { GH_TOKEN: "ghp_X", CLOUDFLARE_API_TOKEN: "cf_Y" },
    );
    expect(env.GH_TOKEN).toBe("ghp_X");
    expect(env.CLOUDFLARE_API_TOKEN).toBe("cf_Y");
  });

  test("INJECTION: a channel-set var can NOT clobber CLAUDE_CODE_OAUTH_TOKEN (auth wins)", () => {
    // Even if the store somehow carried CLAUDE_CODE_OAUTH_TOKEN, the managed token
    // set last must win — and the denylist drop means it never even lands.
    const env = buildAgentChildEnv(
      { PATH: "/usr/bin" },
      "THE-REAL-OAUTH",
      { CLAUDE_CODE_OAUTH_TOKEN: "ATTACKER-SWAP", GH_TOKEN: "ghp_X" },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("THE-REAL-OAUTH");
    expect(env.GH_TOKEN).toBe("ghp_X");
  });

  test("INJECTION: a channel-set var can NOT clobber a structural passthrough (PATH/HOME)", () => {
    const env = buildAgentChildEnv(
      { PATH: "/real/path", HOME: "/real/home" },
      "tok",
      { PATH: "/evil", HOME: "/evil" },
    );
    expect(env.PATH).toBe("/real/path");
    expect(env.HOME).toBe("/real/home");
  });

  test("INJECTION: denylisted keys (API keys) are dropped defensively with a warning", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
    try {
      const env = buildAgentChildEnv(
        { PATH: "/usr/bin" },
        "tok",
        { ANTHROPIC_API_KEY: "sk-ant-SMUGGLED", CLAUDE_API_KEY: "y", GH_TOKEN: "ghp_X" },
      );
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_API_KEY).toBeUndefined();
      expect(env.GH_TOKEN).toBe("ghp_X"); // the legit var still passes
      expect(warnings.some((w) => w.includes("ANTHROPIC_API_KEY") && w.includes("denylisted"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("INJECTION: an empty channel env is a no-op (back-compat default arg)", () => {
    const env = buildAgentChildEnv({ PATH: "/usr/bin" }, "tok");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("tok");
    expect(env.PATH).toBe("/usr/bin");
  });
});

describe("mergeSandboxLaunchEnv — the scrub WINS over the engine's returned env", () => {
  // The REAL `wrapWithSandboxArgv` returns `env: process.env` (the FULL daemon env) on
  // macOS/Linux; on Windows it returns `{...process.env, ...proxy}`. So `wrapped.env` is
  // essentially the whole daemon env. The old `{ ...childEnv, ...wrapped.env, ...homeEnv }`
  // spread let that OVERRIDE the scrubbed childEnv — re-admitting the daemon's ambient
  // ANTHROPIC_API_KEY/secrets into the sandboxed turn (isolation/billing leak).

  const childEnv = buildAgentChildEnv({ PATH: "/usr/bin", HOME: "/h" }, "THE-OAUTH-TOKEN");
  // A representative `wrapped.env` = the daemon's process.env + the sandbox/proxy vars.
  const wrappedEnv = {
    ANTHROPIC_API_KEY: "sk-ant-DAEMON-AMBIENT",
    CLAUDE_API_KEY: "daemon-ambient",
    CLAUDE_CODE_OAUTH_TOKEN: "WRONG-DAEMON-TOKEN",
    SECRET_THING: "daemon-secret",
    PATH: "/daemon/bin",
    SANDBOX_RUNTIME: "1",
    HTTP_PROXY: "http://localhost:5555",
    HTTPS_PROXY: "http://localhost:5555",
    NO_PROXY: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: "/tmp/claude/ca.pem",
    TMPDIR: "/tmp/claude",
  };
  const homeEnv: Record<string, string> = { CLAUDE_CONFIG_DIR: "/sess/.claude" };

  test("LEAK CLOSED: the daemon's ambient secrets in wrapped.env never reach the launch env", () => {
    const env = mergeSandboxLaunchEnv(childEnv, wrappedEnv, homeEnv);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.SECRET_THING).toBeUndefined();
  });

  test("MANAGED AUTH WINS: CLAUDE_CODE_OAUTH_TOKEN is the scrubbed value, not the engine env's wrong one", () => {
    const env = mergeSandboxLaunchEnv(childEnv, wrappedEnv, homeEnv);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("THE-OAUTH-TOKEN");
  });

  test("EGRESS PRESERVED: the allowlisted sandbox/proxy vars survive (the proxy keeps working)", () => {
    const env = mergeSandboxLaunchEnv(childEnv, wrappedEnv, homeEnv);
    expect(env.SANDBOX_RUNTIME).toBe("1");
    expect(env.HTTP_PROXY).toBe("http://localhost:5555");
    expect(env.HTTPS_PROXY).toBe("http://localhost:5555");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1");
    expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/claude/ca.pem");
  });

  test("the scrubbed PATH wins (PATH is not in the sandbox allowlist)", () => {
    const env = mergeSandboxLaunchEnv(childEnv, wrappedEnv, homeEnv);
    expect(env.PATH).toBe("/usr/bin"); // childEnv's, not the engine env's /daemon/bin
  });

  test("homeEnv wins last (CLAUDE_CONFIG_DIR/XDG/TMP overrides)", () => {
    const env = mergeSandboxLaunchEnv(childEnv, wrappedEnv, homeEnv);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/sess/.claude");
  });

  test("the allowlist never contains the Claude-auth trio (defense-in-depth)", () => {
    expect(SANDBOX_ENV_ALLOWLIST.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(SANDBOX_ENV_ALLOWLIST.has("CLAUDE_API_KEY")).toBe(false);
    expect(SANDBOX_ENV_ALLOWLIST.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });
});

describe("buildAgentClaudeArgs", () => {
  test("interactive claude (no -p) with strict MCP config + dev-channels for the first channel", () => {
    const argv = buildAgentClaudeArgs({
      mcpConfigPath: "/ws/.mcp.json",
      firstChannelEntryKey: "agent-aaron-dev",
    });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--mcp-config");
    expect(argv).toContain("/ws/.mcp.json");
    expect(argv).toContain("--dangerously-load-development-channels=server:agent-aaron-dev");
    // Autonomous: no human answers tool prompts; the sandbox is the containment.
    expect(argv).toContain("--dangerously-skip-permissions");
    // NOT headless: no `-p`.
    expect(argv).not.toContain("-p");
  });
  test("no systemPromptFile → neither system-prompt flag (today's behavior)", () => {
    const argv = buildAgentClaudeArgs({ mcpConfigPath: "/ws/.mcp.json", firstChannelEntryKey: "agent-c" });
    expect(argv).not.toContain("--append-system-prompt-file");
    expect(argv).not.toContain("--system-prompt-file");
  });
  test("systemPromptFile (append, default) → --append-system-prompt-file <path>", () => {
    const argv = buildAgentClaudeArgs({
      mcpConfigPath: "/ws/.mcp.json",
      firstChannelEntryKey: "agent-c",
      systemPromptFile: "/ws/system-prompt.txt",
      systemPromptMode: "append",
    });
    expect(argv).toContain("--append-system-prompt-file");
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe("/ws/system-prompt.txt");
    expect(argv).not.toContain("--system-prompt-file");
  });
  test("systemPromptFile (replace) → --system-prompt-file <path>", () => {
    const argv = buildAgentClaudeArgs({
      mcpConfigPath: "/ws/.mcp.json",
      firstChannelEntryKey: "agent-c",
      systemPromptFile: "/ws/system-prompt.txt",
      systemPromptMode: "replace",
    });
    expect(argv).toContain("--system-prompt-file");
    expect(argv).not.toContain("--append-system-prompt-file");
  });
});

describe("shellJoin", () => {
  test("leaves safe args bare, quotes args with spaces", () => {
    expect(shellJoin(["claude", "--mcp-config", "/a/b.json"])).toBe("claude --mcp-config /a/b.json");
    expect(shellJoin(["echo", "a b"])).toBe("echo 'a b'");
  });
});

describe("seedAgentHome — the per-session writable HOME (stability keystone)", () => {
  test("seeds from the operator config (inherits first-run state), strips projects+oauthAccount, trusts the workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "seed-home-"));
    const opDir = mkdtempSync(join(tmpdir(), "seed-op-"));
    const opPath = join(opDir, ".claude.json");
    // A realistic operator config: completed first-run flags + history + account.
    writeFileSync(opPath, JSON.stringify({
      hasCompletedOnboarding: true,
      theme: "dark",
      numStartups: 536,
      sonnet45MigrationComplete: true,
      oauthAccount: { email: "op@example.com", secret: "DO-NOT-COPY" },
      projects: { "/some/other/proj": { hasTrustDialogAccepted: true } },
    }));
    try {
      const env = seedAgentHome(ws, { mcpServers: ["agent-uni-dev", "vault-default"], operatorConfigPath: opPath });
      // Config + temp are redirected to per-session dirs INSIDE the workspace.
      // (HOME is deliberately NOT overridden — claude finds its real install there.)
      expect(env.HOME).toBeUndefined();
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(ws, "home", ".claude"));
      expect(env.TMPDIR).toBe(join(ws, "tmp"));
      expect(env.CLAUDE_CODE_TMPDIR).toBe(join(ws, "tmp"));
      const seed = JSON.parse(readFileSync(join(ws, "home", ".claude", ".claude.json"), "utf8")) as Record<string, unknown>;
      // Inherits the operator's completed first-run state (onboarding, theme, migrations).
      expect(seed.hasCompletedOnboarding).toBe(true);
      expect(seed.theme).toBe("dark");
      expect(seed.sonnet45MigrationComplete).toBe(true);
      // Strips the account; replaces project history with ONLY this workspace, trusted.
      expect(seed.oauthAccount).toBeUndefined();
      const projects = seed.projects as Record<string, { hasTrustDialogAccepted: boolean; hasCompletedProjectOnboarding: boolean }>;
      expect(Object.keys(projects)).toEqual([ws]);
      expect(projects[ws]!.hasTrustDialogAccepted).toBe(true);
      expect(projects[ws]!.hasCompletedProjectOnboarding).toBe(true);
      // Our configured MCP servers are pre-approved (no "trust this MCP server" prompt).
      expect((projects[ws] as { enabledMcpjsonServers?: string[] }).enabledMcpjsonServers).toEqual([
        "agent-uni-dev",
        "vault-default",
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(opDir, { recursive: true, force: true });
    }
  });

  test("falls back to the minimal seed when the operator has no config", () => {
    const ws = mkdtempSync(join(tmpdir(), "seed-home-noop-"));
    try {
      seedAgentHome(ws, { operatorConfigPath: join(ws, "does-not-exist.json") });
      const seed = JSON.parse(readFileSync(join(ws, "home", ".claude", ".claude.json"), "utf8")) as {
        hasCompletedOnboarding: boolean;
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      expect(seed.hasCompletedOnboarding).toBe(true);
      expect(seed.projects[ws]!.hasTrustDialogAccepted).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("projectRoot override → the SHARED working dir is the pre-trusted project, not the private home", () => {
    const ws = mkdtempSync(join(tmpdir(), "seed-home-projroot-"));
    const noop = join(ws, "no-operator.json");
    try {
      // The cwd (a shared working dir) is pre-trusted; the seed still lives UNDER ws.
      seedAgentHome(ws, { operatorConfigPath: noop, projectRoot: "/Users/op/Code/repo", mcpServers: ["vault-default"] });
      const seed = JSON.parse(readFileSync(join(ws, "home", ".claude", ".claude.json"), "utf8")) as {
        projects: Record<string, { hasTrustDialogAccepted: boolean }>;
      };
      // The PROJECT (pre-trusted) is the shared working dir, NOT the private ws.
      expect(Object.keys(seed.projects)).toEqual(["/Users/op/Code/repo"]);
      expect(seed.projects["/Users/op/Code/repo"]!.hasTrustDialogAccepted).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("idempotent — an existing seed is left as-is (claude owns it after first boot)", () => {
    const ws = mkdtempSync(join(tmpdir(), "seed-home-idem-"));
    const noop = join(ws, "no-operator.json");
    try {
      seedAgentHome(ws, { operatorConfigPath: noop });
      const path = join(ws, "home", ".claude", ".claude.json");
      writeFileSync(path, JSON.stringify({ hasCompletedOnboarding: true, mine: true }));
      seedAgentHome(ws, { operatorConfigPath: noop }); // second call must not clobber
      expect(JSON.parse(readFileSync(path, "utf8")).mine).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
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
      vault: { name: "default", access: "read", tags: ["#agent/message"] },
      network: "restricted", // exercise the egress floor; scoped reads are the default (step 6)
    };
    const res = await spawnAgent(spec, baseDeps({ tmux, sandboxEngine: engine }));

    // 1. tmux session created with the spec's name.
    expect(res.alreadyRunning).toBe(false);
    expect(res.session).toBe(sessionName("aaron-dev"));
    expect(tmux.launched).toHaveLength(1);
    const launch = tmux.launched[0]!;
    expect(launch.name).toBe("aaron-dev-agent");

    // 1b. The dev-channels consent gate is auto-answered for THIS session after the
    // launch (channel#70) — otherwise the headless spawn hangs at the prompt forever.
    expect(tmux.confirmed).toEqual(["aaron-dev-agent"]);
    expect(res.devChannelsPrompt).toBe("confirmed");

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

  test("a spec with systemPrompt writes system-prompt.txt 0600 + passes the -file flag in the launch argv", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-sysprompt-"));
    const tmux = recordingTmux();
    const spec: AgentSpec = {
      name: "eng",
      channels: ["eng"],
      systemPrompt: "You are the eng channel's assistant.",
      systemPromptMode: "append",
    };
    const res = await spawnAgent(spec, baseDeps({ tmux }));

    // The prompt file is written 0600 with the exact text.
    const promptPath = join(res.workspace, "system-prompt.txt");
    expect(statSync(promptPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(promptPath, "utf8")).toBe("You are the eng channel's assistant.");
    // The launched claude command carries --append-system-prompt-file <path>.
    const cmd = tmux.launched[0]!.argv[2]!;
    expect(cmd).toContain("--append-system-prompt-file");
    expect(cmd).toContain(promptPath);
  });

  test("a spec with NO systemPrompt writes no prompt file + no system-prompt flag", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-nosysprompt-"));
    const tmux = recordingTmux();
    const res = await spawnAgent({ name: "bare", channels: ["bare"] }, baseDeps({ tmux }));
    expect(existsSync(join(res.workspace, "system-prompt.txt"))).toBe(false);
    expect(tmux.launched[0]!.argv[2]!).not.toContain("system-prompt-file");
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
      vault: { name: "default", access: "read", tags: ["#agent/message"] },
    };
    await spawnAgent(spec, baseDeps({ fetchFn }));
    const vaultCall = calls.find((c) => String(c.scope).startsWith("vault:"));
    expect(vaultCall).toBeDefined();
    expect(vaultCall!.scope).toBe("vault:default:read");
    expect(vaultCall!.permissions).toEqual({ scoped_tags: ["#agent/message"] });
  });

  test("idempotent: an already-running session is a no-op", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-idem-"));
    const tmux = recordingTmux(new Set(["arm-agent"]));
    const res = await spawnAgent({ name: "arm", channels: ["c"] }, baseDeps({ tmux }));
    expect(res.alreadyRunning).toBe(true);
    expect(tmux.launched).toHaveLength(0);
    // No launch → the dev-channels gate is NOT touched (guards against someone
    // moving the confirm call above the early-return — channel#70).
    expect(tmux.confirmed).toHaveLength(0);
    expect(res.devChannelsPrompt).toBeUndefined();
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

  test("ENV INJECTION: the resolved per-channel env reaches the tmux launch env (Claude auth intact)", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-env-"));
    const tmux = recordingTmux();
    const deps = baseDeps({
      tmux,
      // The wake channel is the first channel ("aaron-dev") — env resolves on it.
      resolveChannelEnv: (ch): Record<string, string> =>
        ch === "aaron-dev" ? { GH_TOKEN: "ghp_INJECTED", CLOUDFLARE_API_TOKEN: "cf_INJECTED" } : {},
    });
    await spawnAgent({ name: "aaron-dev", channels: ["aaron-dev"] }, deps);
    expect(tmux.launched).toHaveLength(1);
    const env = tmux.launched[0]!.env;
    // The injected vars reach the child…
    expect(env.GH_TOKEN).toBe("ghp_INJECTED");
    expect(env.CLOUDFLARE_API_TOKEN).toBe("cf_INJECTED");
    // …Claude auth is the stub placeholder (not clobbered), and no API key leaked.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("OAUTH-CRED-PLACEHOLDER");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("ENV INJECTION: a denylisted key planted in the resolver is dropped at launch", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-env-deny-"));
    const tmux = recordingTmux();
    const deps = baseDeps({
      tmux,
      resolveChannelEnv: () => ({ ANTHROPIC_API_KEY: "sk-ant-SMUGGLED", GH_TOKEN: "ghp_OK" }),
    });
    await spawnAgent({ name: "x", channels: ["c"] }, deps);
    const env = tmux.launched[0]!.env;
    expect(env.GH_TOKEN).toBe("ghp_OK");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // dropped defensively in buildAgentChildEnv
  });

  test("SPEC PERSISTENCE: spawn writes spec.json so a restart can reproduce the launch", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-agent-spec-"));
    const spec: AgentSpec = {
      name: "weaver",
      channels: [{ name: "weave", access: "read" }],
      vault: { name: "default", access: "read", tags: ["#agent/message"] },
      network: "restricted",
      egress: ["registry.npmjs.org"],
    };
    const res = await spawnAgent(spec, baseDeps());
    // The persisted spec round-trips to the exact spec the launch used.
    const recovered = readPersistedSpec(res.workspace);
    expect(recovered).toEqual(spec);
    // And it's at the conventional path.
    expect(specFilePath(res.workspace)).toBe(join(res.workspace, "spec.json"));
  });

  test("read-only channel mints agent:read ONLY (not read+write)", async () => {
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
    expect(scopes).toContain("agent:read"); // the read-only channel
    expect(scopes.filter((s) => s === "agent:read")).toHaveLength(1);
    expect(scopes.filter((s) => s === "agent:read agent:write")).toHaveLength(2); // rw + bare
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

// ---- the workspace seam (working-directory axis) ---------------------------
// design 2026-06-16-agent-filesystem-and-sharing.md — a `workspace` host path is
// the agent's cwd + an rw working-root; the credential-bearing private home
// (.mcp.json / system-prompt.txt / spec.json / seeded CLAUDE_CONFIG_DIR) STAYS in
// the per-agent sessions/<name> dir, never written into the shared workspace.

describe("resolveAgentCwd — cwd is the workspace when set, else the private dir", () => {
  test("workspace set → that path; the private dir is untouched as the cwd", () => {
    expect(resolveAgentCwd({ name: "a", channels: ["c"], workspace: "/ws/repo" }, "/private/a")).toBe("/ws/repo");
  });
  test("workspace unset → the private dir (today's behavior)", () => {
    expect(resolveAgentCwd({ name: "a", channels: ["c"] }, "/private/a")).toBe("/private/a");
  });
  test("a blank workspace falls back to the private dir", () => {
    expect(resolveAgentCwd({ name: "a", channels: ["c"], workspace: "" }, "/private/a")).toBe("/private/a");
  });
});

describe("spawnAgent — workspace seam (interactive): cwd = workspace, secrets stay private", () => {
  test("workspace SET → tmux cwd is the workspace; .mcp.json/system-prompt/spec/home stay in the PRIVATE dir; workspace is in the sandbox rw set", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-ws-set-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "shared-workdir-"));
    const tmux = recordingTmux();
    const engine = fakeEngine();
    try {
      const spec: AgentSpec = {
        name: "worker",
        channels: ["worker"],
        workspace: workspaceDir,
        systemPrompt: "You work in the repo.",
      };
      const res = await spawnAgent(spec, baseDeps({ tmux, sandboxEngine: engine }));
      const privateDir = sessionWorkspace(sessionsDir, "worker");
      // res.workspace is still the PRIVATE session dir (the home of secrets).
      expect(res.workspace).toBe(privateDir);

      // 1. The tmux session's cwd is the SHARED workspace, NOT the private dir.
      const launch = tmux.launched[0]!;
      expect(launch.cwd).toBe(workspaceDir);
      // …and the launch script (private) is written to the PRIVATE dir, never the shared one.
      expect(launch.scriptDir).toBe(privateDir);

      // 2. SECRETS-STAY-PRIVATE invariant: .mcp.json / system-prompt.txt / spec.json /
      // the seeded home all live UNDER the private dir, and NONE under the workspace.
      expect(existsSync(join(privateDir, ".mcp.json"))).toBe(true);
      expect(existsSync(join(privateDir, "system-prompt.txt"))).toBe(true);
      expect(existsSync(join(privateDir, "spec.json"))).toBe(true);
      expect(existsSync(join(privateDir, "home", ".claude", ".claude.json"))).toBe(true);
      // The workspace dir is NOT littered with any private artifact.
      expect(existsSync(join(workspaceDir, ".mcp.json"))).toBe(false);
      expect(existsSync(join(workspaceDir, "system-prompt.txt"))).toBe(false);
      expect(existsSync(join(workspaceDir, "spec.json"))).toBe(false);
      expect(existsSync(join(workspaceDir, ".launch.sh"))).toBe(false);
      expect(existsSync(join(workspaceDir, "home"))).toBe(false);

      // 3. --mcp-config / --append-system-prompt-file point at the PRIVATE absolute
      // paths (unaffected by the cwd change).
      const cmd = launch.argv[2]!;
      expect(cmd).toContain(join(privateDir, ".mcp.json"));
      expect(cmd).toContain(join(privateDir, "system-prompt.txt"));

      // 4. The workspace IS an rw working-root in the sandbox (read + write).
      expect(engine.initializedWith!.filesystem.allowWrite).toContain(workspaceDir);
      expect(engine.initializedWith!.filesystem.allowWrite).toContain(privateDir);
      expect(engine.initializedWith!.filesystem.allowRead).toContain(workspaceDir);

      // 5. CLAUDE_CONFIG_DIR / TMPDIR still point at the PRIVATE home (not the workspace).
      expect(launch.env.CLAUDE_CONFIG_DIR).toBe(join(privateDir, "home", ".claude"));
      expect(launch.env.TMPDIR).toBe(join(privateDir, "tmp"));

      // 6. The seeded project (pre-trusted) is the agent's CWD (the shared workspace).
      const seed = JSON.parse(
        readFileSync(join(privateDir, "home", ".claude", ".claude.json"), "utf8"),
      ) as { projects: Record<string, unknown> };
      expect(Object.keys(seed.projects)).toEqual([workspaceDir]);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("workspace UNSET → cwd is the private dir (unchanged); workspace not in the rw set beyond the private dir", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-ws-unset-"));
    const tmux = recordingTmux();
    const engine = fakeEngine();
    const res = await spawnAgent({ name: "plain", channels: ["plain"] }, baseDeps({ tmux, sandboxEngine: engine }));
    const launch = tmux.launched[0]!;
    // The cwd is the private session dir (today's behavior, exactly).
    expect(launch.cwd).toBe(res.workspace);
    expect(launch.scriptDir).toBe(res.workspace);
    // The only writable dir is the private session dir.
    expect(engine.initializedWith!.filesystem.allowWrite).toEqual([res.workspace]);
    // The pre-trusted project is the private dir (no shared working dir).
    const seed = JSON.parse(
      readFileSync(join(res.workspace, "home", ".claude", ".claude.json"), "utf8"),
    ) as { projects: Record<string, unknown> };
    expect(Object.keys(seed.projects)).toEqual([res.workspace]);
  });

  test("SECRETS-STAY-PRIVATE: .mcp.json (scoped tokens) is NEVER written into a shared workspace dir", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-ws-secrets-"));
    const workspaceDir = mkdtempSync(join(tmpdir(), "shared-secrets-"));
    try {
      const spec: AgentSpec = {
        name: "secretkeeper",
        channels: ["secretkeeper"],
        vault: { name: "default", access: "read" },
        workspace: workspaceDir,
      };
      await spawnAgent(spec, baseDeps({ tmux: recordingTmux() }));
      // The shared workspace holds NO .mcp.json (the file that inlines the minted
      // vault/channel tokens). It only ever lives in the per-agent private dir.
      expect(existsSync(join(workspaceDir, ".mcp.json"))).toBe(false);
      // Belt-and-suspenders: no file under the shared workspace contains the minted
      // token marker the fake hub stamps (TOK-).
      const privateMcp = readFileSync(join(sessionWorkspace(sessionsDir, "secretkeeper"), ".mcp.json"), "utf8");
      expect(privateMcp).toContain("Bearer TOK-"); // the secret IS in the private file…
      // …and the shared dir has no such file at all (asserted above) — so the token
      // never crosses into the shareable dir.
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test("two agents can SHARE one workspace dir (allowed, not solved) — each keeps its OWN private home", async () => {
    sessionsDir = mkdtempSync(join(tmpdir(), "spawn-ws-shared-"));
    const shared = mkdtempSync(join(tmpdir(), "shared-by-two-"));
    try {
      const tmuxA = recordingTmux();
      const tmuxB = recordingTmux();
      await spawnAgent({ name: "agent-a", channels: ["a"], workspace: shared }, baseDeps({ tmux: tmuxA }));
      await spawnAgent({ name: "agent-b", channels: ["b"], workspace: shared }, baseDeps({ tmux: tmuxB }));
      // Both cwd into the SAME shared dir…
      expect(tmuxA.launched[0]!.cwd).toBe(shared);
      expect(tmuxB.launched[0]!.cwd).toBe(shared);
      // …but each has its OWN private home (distinct .mcp.json under distinct dirs).
      const aPriv = sessionWorkspace(sessionsDir, "agent-a");
      const bPriv = sessionWorkspace(sessionsDir, "agent-b");
      expect(aPriv).not.toBe(bPriv);
      expect(existsSync(join(aPriv, ".mcp.json"))).toBe(true);
      expect(existsSync(join(bPriv, ".mcp.json"))).toBe(true);
      // The shared dir holds NEITHER agent's secrets.
      expect(existsSync(join(shared, ".mcp.json"))).toBe(false);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
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

describe("confirmDevChannelsPrompt — auto-answer the dev-channels consent gate (channel#70)", () => {
  /**
   * A recording spawnFn whose `tmux capture-pane` returns configurable pane text and
   * whose `tmux send-keys` is recorded. Mirrors the `recordingSpawn` shape above but
   * with a per-argv stdout (capture must return the pane content).
   */
  function recordingSpawn(paneText: string): {
    fn: typeof Bun.spawn;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const fn = ((argv: string[]) => {
      calls.push(argv);
      const isCapture = argv.includes("capture-pane");
      return {
        exited: Promise.resolve(0),
        stdout: new Response(isCapture ? paneText : "").body,
        stderr: new Response("").body,
      };
    }) as unknown as typeof Bun.spawn;
    return { fn, calls };
  }

  const noSleep = async () => {};

  test("prompt marker present → returns 'confirmed' AND sends Enter to the pane", async () => {
    const pane = `WARNING: Loading development channels\n❯ 1. ${DEV_CHANNELS_PROMPT_MARKER}\n  2. Exit`;
    const { fn, calls } = recordingSpawn(pane);
    const result = await confirmDevChannelsPrompt("aaron-agent", {
      spawnFn: fn,
      timeoutMs: 5_000,
      intervalMs: 10,
      sleepFn: noSleep,
    });
    expect(result).toBe("confirmed");
    // A `tmux send-keys -t aaron-agent Enter` call was recorded.
    const sendKeys = calls.find((c) => c.includes("send-keys"));
    expect(sendKeys).toBeDefined();
    expect(sendKeys).toEqual(["tmux", "send-keys", "-t", "aaron-agent", "Enter"]);
  });

  test("ready marker present (no prompt) → returns 'already-running', NO send-keys", async () => {
    const pane = `Welcome to Claude Code\n  ${DEV_CHANNELS_READY_MARKER} · /help for help`;
    const { fn, calls } = recordingSpawn(pane);
    const result = await confirmDevChannelsPrompt("aaron-agent", {
      spawnFn: fn,
      timeoutMs: 5_000,
      intervalMs: 10,
      sleepFn: noSleep,
    });
    expect(result).toBe("already-running");
    expect(calls.some((c) => c.includes("send-keys"))).toBe(false);
  });

  test("neither marker, tiny timeout + no-op sleep → returns 'timeout', NO throw, NO send-keys", async () => {
    const { fn, calls } = recordingSpawn("just some unrelated pane output\n$ ");
    const result = await confirmDevChannelsPrompt("aaron-agent", {
      spawnFn: fn,
      timeoutMs: 1,
      intervalMs: 1,
      sleepFn: noSleep,
    });
    expect(result).toBe("timeout");
    expect(calls.some((c) => c.includes("send-keys"))).toBe(false);
    // It DID poll at least once (the do-while guarantees a capture even at timeoutMs<=interval).
    expect(calls.some((c) => c.includes("capture-pane"))).toBe(true);
  });

  test("a capture subprocess that throws degrades to timeout, never throws", async () => {
    const fn = (() => {
      throw new Error("tmux not found");
    }) as unknown as typeof Bun.spawn;
    const result = await confirmDevChannelsPrompt("aaron-agent", {
      spawnFn: fn,
      timeoutMs: 1,
      intervalMs: 1,
      sleepFn: noSleep,
    });
    expect(result).toBe("timeout");
  });

  test("prompt seen but send-keys throws → degrades to timeout (does NOT lie 'confirmed'), never throws", async () => {
    const pane = `❯ 1. ${DEV_CHANNELS_PROMPT_MARKER}\n  2. Exit`;
    // capture-pane succeeds (returns the prompt); send-keys throws.
    const fn = ((argv: string[]) => {
      if (argv.includes("send-keys")) throw new Error("send-keys failed");
      return {
        exited: Promise.resolve(0),
        stdout: new Response(pane).body,
        stderr: new Response("").body,
      };
    }) as unknown as typeof Bun.spawn;
    const result = await confirmDevChannelsPrompt("aaron-agent", {
      spawnFn: fn,
      timeoutMs: 1,
      intervalMs: 1,
      sleepFn: noSleep,
    });
    expect(result).toBe("timeout");
  });
});

describe("persistSpec / readPersistedSpec — spawn-spec recovery for restart", () => {
  test("round-trips a spec; readPersistedSpec returns null for a missing/garbage file", () => {
    const ws = mkdtempSync(join(tmpdir(), "spec-rt-"));
    try {
      expect(readPersistedSpec(ws)).toBeNull(); // nothing written yet
      const spec: AgentSpec = { name: "a", channels: ["c"], filesystem: "full" };
      persistSpec(ws, spec);
      expect(readPersistedSpec(ws)).toEqual(spec);
      // Written 0600 (matches the secret-bearing .mcp.json discipline; the workspace
      // dir is only umask-tight, so the file perm is the real guard).
      expect(statSync(specFilePath(ws)).mode & 0o777).toBe(0o600);
      // Corrupt it -> null (the restart path treats this as "no spec").
      writeFileSync(specFilePath(ws), "{not json");
      expect(readPersistedSpec(ws)).toBeNull();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
