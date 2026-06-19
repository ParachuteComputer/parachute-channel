/**
 * PARKED unit tests for the interactive (tmux) spawner + session admin
 * (`src/_parked/interactive-spawn.ts`). The interactive backend retired 2026-06-19
 * (design 2026-06-19-retire-interactive-backend.md); these tests keep the parked
 * code provably buildable for the future terminal/process-mgmt revival. They are
 * pure over their inputs (an injected `TmuxAdmin` / `TmuxLauncher` recorder) — no
 * hub, no sandbox, no real tmux server.
 *
 * Spawner-internals coverage (buildAgentClaudeArgs, buildLaunchScript,
 * realTmuxLauncher, confirmDevChannelsPrompt, spawnAgent) lives in
 * `src/spawn-agent.test.ts`, which imports the spawner from the parked module too.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTmuxSessions,
  agentInfoFromSessions,
  redactSpawnResult,
  createRealAgentOps,
  SpawnRequestError,
  type TmuxAdmin,
  type TmuxLauncher,
  type SpawnAgentDeps,
  type SpawnAgentResult,
} from "./interactive-spawn.ts";
import { persistSpec, sessionWorkspace } from "../spawn-agent.ts";
import type { SandboxEngine } from "../sandbox/index.ts";
import type { AgentSpec } from "../sandbox/types.ts";

describe("parseTmuxSessions", () => {
  test("parses `<name> <attachedCount>` lines; attached>0 → true", () => {
    const out = parseTmuxSessions("aaron-agent 1\nweaver-agent 0\nmisc 2\n");
    expect(out).toEqual([
      { name: "aaron-agent", attached: true },
      { name: "weaver-agent", attached: false },
      { name: "misc", attached: true },
    ]);
  });
  test("empty / blank input → empty list", () => {
    expect(parseTmuxSessions("")).toEqual([]);
    expect(parseTmuxSessions("\n  \n")).toEqual([]);
  });
});

describe("agentInfoFromSessions", () => {
  test("keeps only *-agent sessions, strips the suffix, sorts by name", () => {
    const infos = agentInfoFromSessions(
      [
        { name: "weaver-agent", attached: false },
        { name: "scratch", attached: true }, // not an agent session — dropped
        { name: "aaron-agent", attached: true },
      ],
      "/tmp/sessions",
    );
    expect(infos.map((i) => i.name)).toEqual(["aaron", "weaver"]);
    expect(infos[0]).toMatchObject({ name: "aaron", session: "aaron-agent", attached: true });
    expect(infos[0]!.workspace).toBe("/tmp/sessions/aaron");
    expect(infos[0]!.hasWorkspace).toBe(false);
  });
  test("a bare `-agent` (empty slug) is dropped", () => {
    expect(agentInfoFromSessions([{ name: "-agent", attached: false }], "/tmp/s")).toEqual([]);
  });
  test("surfaces systemPromptMode from the persisted spec when a prompt is set; absent otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-info-sysprompt-"));
    try {
      persistSpec(sessionWorkspace(dir, "withprompt"), {
        name: "withprompt",
        channels: ["withprompt"],
        systemPrompt: "You are a focused bot.",
        systemPromptMode: "replace",
      } as AgentSpec);
      persistSpec(sessionWorkspace(dir, "noprompt"), { name: "noprompt", channels: ["noprompt"] } as AgentSpec);
      const infos = agentInfoFromSessions(
        [
          { name: "withprompt-agent", attached: false },
          { name: "noprompt-agent", attached: false },
        ],
        dir,
      );
      const byName = Object.fromEntries(infos.map((i) => [i.name, i]));
      expect(byName.withprompt!.systemPromptMode).toBe("replace");
      expect(byName.noprompt!.systemPromptMode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("surfaces workingDir from the persisted spec when the workspace is set AND exists; absent otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-info-workdir-"));
    const workdir = mkdtempSync(join(tmpdir(), "agent-info-real-workdir-"));
    try {
      persistSpec(sessionWorkspace(dir, "withdir"), {
        name: "withdir",
        channels: ["withdir"],
        workspace: workdir,
      } as AgentSpec);
      persistSpec(sessionWorkspace(dir, "nodir"), { name: "nodir", channels: ["nodir"] } as AgentSpec);
      persistSpec(sessionWorkspace(dir, "gonedir"), {
        name: "gonedir",
        channels: ["gonedir"],
        workspace: "/Users/op/Code/deleted-repo",
      } as AgentSpec);
      const infos = agentInfoFromSessions(
        [
          { name: "withdir-agent", attached: false },
          { name: "nodir-agent", attached: false },
          { name: "gonedir-agent", attached: false },
        ],
        dir,
      );
      const byName = Object.fromEntries(infos.map((i) => [i.name, i]));
      expect(byName.withdir!.workingDir).toBe(workdir);
      expect(byName.nodir!.workingDir).toBeUndefined();
      expect(byName.gonedir!.workingDir).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});

describe("redactSpawnResult", () => {
  const result: SpawnAgentResult = {
    session: "aaron-agent",
    workspace: "/s/aaron",
    alreadyRunning: false,
    tokens: {
      aaron: { jti: "j1", token: "SECRET-AGENT-TOKEN", expiresAt: "2026-07-01T00:00:00Z", scope: "agent:read agent:write" },
      "vault:default": { jti: "j2", token: "SECRET-VAULT-TOKEN", expiresAt: "2026-07-01T00:00:00Z", scope: "vault:default:read" },
    },
    mcpConfigJson: JSON.stringify({ mcpServers: { "agent-aaron": {}, "vault-default": {} } }),
    wrapped: {
      argv: ["/bin/bash", "-c", "..."],
      env: {},
      config: { network: { allowedDomains: ["api.anthropic.com:443"], deniedDomains: [] }, filesystem: { denyRead: ["/Users"], allowWrite: [], denyWrite: [] } },
    },
  };
  test("surfaces scopes + mcp servers + posture + egress, NEVER the token values", () => {
    const red = redactSpawnResult(result);
    expect(red.session).toBe("aaron-agent");
    expect(red.tokens).toEqual([
      { resource: "aaron", scope: "agent:read agent:write", expiresAt: "2026-07-01T00:00:00Z" },
      { resource: "vault:default", scope: "vault:default:read", expiresAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(red.mcpServers).toEqual(["agent-aaron", "vault-default"]);
    expect(red.egress).toEqual(["api.anthropic.com:443"]);
    expect(red.network).toBe("restricted");
    expect(red.filesystem).toBe("workspace");
    const wire = JSON.stringify(red);
    expect(wire).not.toContain("SECRET-AGENT-TOKEN");
    expect(wire).not.toContain("SECRET-VAULT-TOKEN");
  });
  test("an open result (no allowedDomains, no denyRead) → network 'open' + filesystem 'full', egress []", () => {
    const open: SpawnAgentResult = {
      ...result,
      wrapped: {
        ...result.wrapped,
        config: { network: { deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } } as unknown as SpawnAgentResult["wrapped"]["config"],
      },
    };
    const red = redactSpawnResult(open);
    expect(red.network).toBe("open");
    expect(red.filesystem).toBe("full");
    expect(red.egress).toEqual([]);
  });
});

describe("createRealAgentOps — list + kill", () => {
  function recorder(sessions: { name: string; attached: boolean }[]): { tmux: TmuxAdmin; killed: string[] } {
    const killed: string[] = [];
    const tmux: TmuxAdmin = {
      async listSessions() {
        return sessions;
      },
      async killSession(name: string) {
        killed.push(name);
        return sessions.some((s) => s.name === name);
      },
    };
    return { tmux, killed };
  }

  test("list maps tmux sessions to agent infos under the sessions dir", async () => {
    const { tmux } = recorder([{ name: "aaron-agent", attached: true }, { name: "other", attached: false }]);
    const ops = createRealAgentOps({ tmux, sessionsDirPath: "/tmp/s" });
    const list = await ops.list();
    expect(list.map((a) => a.name)).toEqual(["aaron"]);
  });

  test("kill targets `<name>-agent` and reports whether it existed", async () => {
    const { tmux, killed } = recorder([{ name: "aaron-agent", attached: false }]);
    const ops = createRealAgentOps({ tmux, sessionsDirPath: "/tmp/s" });
    expect(await ops.kill("aaron")).toEqual({ killed: true });
    expect(killed).toEqual(["aaron-agent"]);
    expect(await ops.kill("ghost")).toEqual({ killed: false });
  });

  test("kill rejects a non-slug name before touching tmux", async () => {
    const { tmux, killed } = recorder([]);
    const ops = createRealAgentOps({ tmux, sessionsDirPath: "/tmp/s" });
    await expect(ops.kill("../escape")).rejects.toThrow(SpawnRequestError);
    expect(killed).toEqual([]);
  });
});

describe("createRealAgentOps — restart (param recovery via persisted spec)", () => {
  function spawnDeps(sessionsDirPath: string): {
    deps: SpawnAgentDeps;
    launched: Array<{ name: string }>;
  } {
    const launched: Array<{ name: string }> = [];
    const launcher: TmuxLauncher = {
      async hasSession() {
        return false;
      },
      async newSession(opts) {
        launched.push({ name: opts.name });
      },
      async confirmDevChannelsPrompt() {
        return "already-running";
      },
    };
    const engine: SandboxEngine = {
      isSupportedPlatform: () => true,
      isSandboxingEnabled: () => true,
      async initialize() {},
      async wrapWithSandboxArgv(command: string) {
        return { argv: ["/bin/bash", "-c", command], env: {} };
      },
      async reset() {},
    };
    const fetchFn = (async (_u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { scope: string };
      return new Response(
        JSON.stringify({ jti: "j", token: "TOK", expires_at: "2026-09-01T00:00:00Z", scope: body.scope }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const deps: SpawnAgentDeps = {
      hubOrigin: "https://hub.example.com",
      managerBearer: "MANAGER",
      channelUrl: "http://127.0.0.1:1941",
      vaultUrl: "http://127.0.0.1:1940",
      sessionsDir: sessionsDirPath,
      runtimeReadOnly: [],
      resolveClaudeToken: () => "OAUTH-PLACEHOLDER",
      resolveChannelEnv: () => ({ GH_TOKEN: "ghp_FROM-STORE" }),
      sandboxEngine: engine,
      tmux: launcher,
      fetchFn,
      parentEnv: { PATH: "/usr/bin" },
      claudeBin: "claude",
    };
    return { deps, launched };
  }

  test("recovers the persisted spec, kills the old session, re-spawns it", async () => {
    const sessionsDirPath = mkdtempSync(join(tmpdir(), "restart-ops-"));
    try {
      const spec: AgentSpec = { name: "aaron", channels: ["aaron"], network: "open" };
      persistSpec(sessionWorkspace(sessionsDirPath, "aaron"), spec);

      const killed: string[] = [];
      const tmux: TmuxAdmin = {
        async listSessions() {
          return [{ name: "aaron-agent", attached: false }];
        },
        async killSession(name) {
          killed.push(name);
          return true;
        },
      };
      const { deps, launched } = spawnDeps(sessionsDirPath);
      const ops = createRealAgentOps({ tmux, sessionsDirPath, depsFactory: () => deps });

      const result = await ops.restart("aaron");
      expect(killed).toEqual(["aaron-agent"]);
      expect(launched).toEqual([{ name: "aaron-agent" }]);
      expect(result.killed).toBe(true);
      expect(result.session).toBe("aaron-agent");
      expect(JSON.stringify(result)).not.toContain("TOK");
    } finally {
      rmSync(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("a missing persisted spec → SpawnRequestError (kill not attempted)", async () => {
    const sessionsDirPath = mkdtempSync(join(tmpdir(), "restart-nospec-"));
    try {
      const killed: string[] = [];
      const tmux: TmuxAdmin = {
        async listSessions() {
          return [];
        },
        async killSession(name) {
          killed.push(name);
          return true;
        },
      };
      const { deps } = spawnDeps(sessionsDirPath);
      const ops = createRealAgentOps({ tmux, sessionsDirPath, depsFactory: () => deps });
      await expect(ops.restart("ghost")).rejects.toThrow(SpawnRequestError);
      await expect(ops.restart("ghost")).rejects.toThrow(/no persisted spec/);
      expect(killed).toEqual([]);
    } finally {
      rmSync(sessionsDirPath, { recursive: true, force: true });
    }
  });

  test("restart rejects a non-slug name before touching anything", async () => {
    const tmux: TmuxAdmin = {
      async listSessions() {
        return [];
      },
      async killSession() {
        return false;
      },
    };
    const { deps } = spawnDeps("/tmp/s");
    const ops = createRealAgentOps({ tmux, sessionsDirPath: "/tmp/s", depsFactory: () => deps });
    await expect(ops.restart("../escape")).rejects.toThrow(SpawnRequestError);
  });
});
