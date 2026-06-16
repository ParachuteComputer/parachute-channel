/**
 * Tests for the web agent-management layer (`src/agents.ts`) + the daemon's
 * `/agents` page and `/api/agents` routes (`src/daemon.ts`).
 *
 * Three layers:
 *   1. Pure functions — no hub, no tmux: `parseTmuxSessions`,
 *      `agentInfoFromSessions`, `buildSpecFromBody` (valid + every error),
 *      `redactSpawnResult` (proves token values never leak).
 *   2. `createRealAgentOps` list/kill with an injected `TmuxAdmin` recorder.
 *   3. The daemon routes through the REAL fetch handler, with `validateHubJwt`
 *      mocked (so a known token carries `channel:admin`) and a STUB `AgentOps`
 *      injected — verifying the gate, the body→spec→spawn wiring, the redaction,
 *      and every error→status mapping, without a hub, a sandbox, or tmux.
 */

import { describe, test, expect, mock } from "bun:test";
// Re-export the REAL error class + helper in the mock below so this process-wide
// `mock.module` doesn't break hub-jwt.test.ts's assertions on the genuine shapes
// (same discipline daemon-config-api.test.ts keeps).
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";

const ADMIN_TOKEN = "test-admin-token"; // channel:admin (the operator gate)
const READ_TOKEN = "test-read-token"; // channel:read only (insufficient)
mock.module("./hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["channel:read", "channel:send", "channel:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["channel:read"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTmuxSessions,
  agentInfoFromSessions,
  buildSpecFromBody,
  redactSpawnResult,
  createRealAgentOps,
  SpawnRequestError,
  type AgentOps,
  type TmuxAdmin,
} from "./agents.ts";
import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import { CredentialNotConfiguredError } from "./credentials.ts";
import { SpawnDepsError } from "./spawn-deps.ts";
import { MintError } from "./mint-token.ts";
import type { Channel } from "./registry.ts";
import {
  persistSpec,
  sessionWorkspace,
  type SpawnAgentResult,
  type SpawnAgentDeps,
  type TmuxLauncher,
} from "./spawn-agent.ts";
import type { SandboxEngine } from "./sandbox/index.ts";
import type { AgentSpec } from "./sandbox/types.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;

// ===========================================================================
// 1. Pure functions
// ===========================================================================
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
    // hasWorkspace is false for a non-existent dir (no .mcp.json on disk).
    expect(infos[0]!.hasWorkspace).toBe(false);
  });
  test("a bare `-agent` (empty slug) is dropped", () => {
    expect(agentInfoFromSessions([{ name: "-agent", attached: false }], "/tmp/s")).toEqual([]);
  });
  test("surfaces systemPromptMode from the persisted spec when a prompt is set; absent otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-info-sysprompt-"));
    try {
      // "withprompt" has a persisted spec carrying a systemPrompt; "noprompt" has one without.
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
      // The mode is surfaced for the prompted agent…
      expect(byName.withprompt!.systemPromptMode).toBe("replace");
      // …and absent for the one with no prompt.
      expect(byName.noprompt!.systemPromptMode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildSpecFromBody", () => {
  test("minimal valid body (one channel, defaults to write + programmatic backend)", () => {
    const spec = buildSpecFromBody({ name: "aaron", channels: ["aaron"] });
    // backend now defaults to "programmatic" for a new request (the default flip).
    expect(spec).toEqual({ name: "aaron", channels: ["aaron"], backend: "programmatic" });
  });
  test("full body — channels (object form), vault+tags, egress, mounts", () => {
    const spec = buildSpecFromBody({
      name: "weaver",
      channels: [{ name: "weave", access: "read" }, { name: "out" }],
      vault: { name: "default", access: "read", tags: ["#channel-message", " "] },
      egress: ["registry.npmjs.org", "  "],
      mounts: [{ hostPath: "/data", mountPath: "/data", mode: "ro", shared: "corpus" }],
    });
    expect(spec.channels).toEqual([{ name: "weave", access: "read" }, { name: "out" }]);
    expect(spec.vault).toEqual({ name: "default", access: "read", tags: ["#channel-message"] });
    expect(spec.egress).toEqual(["registry.npmjs.org"]); // blank trimmed out
    expect(spec.mounts).toEqual([{ hostPath: "/data", mountPath: "/data", mode: "ro", shared: "corpus" }]);
  });
  test("rejects a non-object body", () => {
    expect(() => buildSpecFromBody(null)).toThrow(SpawnRequestError);
    expect(() => buildSpecFromBody("x")).toThrow(/must be a JSON object/);
  });
  test("rejects a missing / non-slug name", () => {
    expect(() => buildSpecFromBody({ channels: ["a"] })).toThrow(/body.name/);
    expect(() => buildSpecFromBody({ name: "bad name", channels: ["a"] })).toThrow(/slug/);
    expect(() => buildSpecFromBody({ name: "../escape", channels: ["a"] })).toThrow(/slug/);
  });
  test("rejects empty / missing channels", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: [] })).toThrow(/non-empty array/);
    expect(() => buildSpecFromBody({ name: "a" })).toThrow(/non-empty array/);
  });
  test("rejects a bad channel access / shape", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: [{ name: "c", access: "admin" }] })).toThrow(/access/);
    expect(() => buildSpecFromBody({ name: "a", channels: [123] })).toThrow(/string or/);
  });
  test("rejects a bad vault access", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], vault: { name: "v", access: "x" } })).toThrow(/vault.access/);
  });
  test("rejects a bad mount mode", () => {
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], mounts: [{ hostPath: "/h", mountPath: "/m", mode: "x" }] }),
    ).toThrow(/mode/);
  });
  test("filesystem/network default (omitted) and accept explicit values + egress", () => {
    const def = buildSpecFromBody({ name: "a", channels: ["c"] });
    expect(def.filesystem).toBeUndefined(); // default = workspace (scoped reads)
    expect(def.network).toBeUndefined(); // default = open
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], filesystem: "full", network: "restricted", egress: ["x.com"] });
    expect(spec.filesystem).toBe("full");
    expect(spec.network).toBe("restricted");
    expect(spec.egress).toEqual(["x.com"]); // additive hosts kept (used under restricted)
  });
  test("rejects invalid filesystem / network values", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], filesystem: "loose" })).toThrow(/filesystem/);
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], network: "loose" })).toThrow(/network/);
  });
  test("rejects relative mount paths (must be absolute)", () => {
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], mounts: [{ hostPath: "rel", mountPath: "/m", mode: "ro" }] }),
    ).toThrow(/hostPath must be an absolute path/);
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], mounts: [{ hostPath: "/h", mountPath: "rel", mode: "ro" }] }),
    ).toThrow(/mountPath must be an absolute path/);
  });
  // Backend default flip (design 2026-06-16 + Aaron's gating decision): a NEW
  // request that OMITS `backend` now defaults to "programmatic" (the reliable
  // primary path), NOT "interactive". Explicit values are still honored.
  test("omitted backend → programmatic (the new-request default)", () => {
    expect(buildSpecFromBody({ name: "a", channels: ["c"] }).backend).toBe("programmatic");
    // null is treated as omitted.
    expect(buildSpecFromBody({ name: "a", channels: ["c"], backend: null }).backend).toBe("programmatic");
  });
  test("explicit backend:\"interactive\" is still honored (opt-out of the default)", () => {
    expect(buildSpecFromBody({ name: "a", channels: ["c"], backend: "interactive" }).backend).toBe("interactive");
  });
  test("explicit backend:\"programmatic\" is honored", () => {
    expect(buildSpecFromBody({ name: "a", channels: ["c"], backend: "programmatic" }).backend).toBe("programmatic");
  });
  test("rejects an invalid backend value", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], backend: "weird" })).toThrow(/backend/);
  });

  // Per-channel system prompt (design 2026-06-16-channel-system-prompt.md):
  // systemPrompt + mode parsed; default mode = append; invalid mode rejected;
  // absent → undefined.
  test("systemPrompt parsed + default mode is append", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "You are the eng bot." });
    expect(spec.systemPrompt).toBe("You are the eng bot.");
    expect(spec.systemPromptMode).toBe("append"); // default
  });
  test("explicit systemPromptMode:\"replace\" is honored", () => {
    const spec = buildSpecFromBody({
      name: "a",
      channels: ["c"],
      systemPrompt: "Full custom persona.",
      systemPromptMode: "replace",
    });
    expect(spec.systemPrompt).toBe("Full custom persona.");
    expect(spec.systemPromptMode).toBe("replace");
  });
  test("absent systemPrompt → both fields undefined", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"] });
    expect(spec.systemPrompt).toBeUndefined();
    expect(spec.systemPromptMode).toBeUndefined();
  });
  test("blank / whitespace-only systemPrompt is treated as unset (no flag)", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "   \n  " });
    expect(spec.systemPrompt).toBeUndefined();
    expect(spec.systemPromptMode).toBeUndefined();
  });
  test("an orphan systemPromptMode with no prompt is dropped (no-op)", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPromptMode: "replace" });
    expect(spec.systemPrompt).toBeUndefined();
    expect(spec.systemPromptMode).toBeUndefined();
  });
  test("rejects an invalid systemPromptMode value", () => {
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "x", systemPromptMode: "merge" }),
    ).toThrow(/systemPromptMode/);
  });
  test("rejects a non-string systemPrompt", () => {
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: 42 }),
    ).toThrow(/systemPrompt must be a string/);
  });
  test("systemPrompt is trimmed", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "  hi  " });
    expect(spec.systemPrompt).toBe("hi");
  });
});

describe("redactSpawnResult", () => {
  const result: SpawnAgentResult = {
    session: "aaron-agent",
    workspace: "/s/aaron",
    alreadyRunning: false,
    tokens: {
      aaron: { jti: "j1", token: "SECRET-CHANNEL-TOKEN", expiresAt: "2026-07-01T00:00:00Z", scope: "channel:read channel:write" },
      "vault:default": { jti: "j2", token: "SECRET-VAULT-TOKEN", expiresAt: "2026-07-01T00:00:00Z", scope: "vault:default:read" },
    },
    mcpConfigJson: JSON.stringify({ mcpServers: { "channel-aaron": {}, "vault-default": {} } }),
    wrapped: {
      argv: ["/bin/bash", "-c", "..."],
      env: {},
      // scoped reads (denyRead carries the home tree) + restricted network (allowedDomains present).
      config: { network: { allowedDomains: ["api.anthropic.com:443"], deniedDomains: [] }, filesystem: { denyRead: ["/Users"], allowWrite: [], denyWrite: [] } },
    },
  };
  test("surfaces scopes + mcp servers + posture + egress, NEVER the token values", () => {
    const red = redactSpawnResult(result);
    expect(red.session).toBe("aaron-agent");
    expect(red.tokens).toEqual([
      { resource: "aaron", scope: "channel:read channel:write", expiresAt: "2026-07-01T00:00:00Z" },
      { resource: "vault:default", scope: "vault:default:read", expiresAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(red.mcpServers).toEqual(["channel-aaron", "vault-default"]);
    expect(red.egress).toEqual(["api.anthropic.com:443"]);
    expect(red.network).toBe("restricted"); // allowedDomains present → restricted
    expect(red.filesystem).toBe("workspace"); // home-tree denyRead present → scoped
    // The smoking gun: no token VALUE appears anywhere in the serialized result.
    const wire = JSON.stringify(red);
    expect(wire).not.toContain("SECRET-CHANNEL-TOKEN");
    expect(wire).not.toContain("SECRET-VAULT-TOKEN");
  });
  test("an open result (no allowedDomains, no denyRead) → network 'open' + filesystem 'full', egress []", () => {
    const open: SpawnAgentResult = {
      ...result,
      wrapped: {
        ...result.wrapped,
        // open network: allowedDomains absent (the runtime's no-restriction shape);
        // full reads: denyRead empty.
        config: { network: { deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } } as unknown as SpawnAgentResult["wrapped"]["config"],
      },
    };
    const red = redactSpawnResult(open);
    expect(red.network).toBe("open");
    expect(red.filesystem).toBe("full");
    expect(red.egress).toEqual([]);
  });
});

// ===========================================================================
// 2. createRealAgentOps list/kill with an injected tmux admin
// ===========================================================================
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

// ===========================================================================
// 2b. createRealAgentOps.restart — kill + re-spawn from the persisted spec
// ===========================================================================
describe("createRealAgentOps — restart (param recovery via persisted spec)", () => {
  // A recording spawn-launcher (the tmux launcher spawnAgent uses) + a fake sandbox
  // engine, so restart drives the REAL spawnAgent through a persisted spec without a
  // hub/sandbox/tmux server.
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
      // Seed a persisted spec where a prior spawn would have written it.
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
      // It killed the old `<name>-agent` first…
      expect(killed).toEqual(["aaron-agent"]);
      // …then re-spawned from the recovered spec (the spawn launcher fired).
      expect(launched).toEqual([{ name: "aaron-agent" }]);
      expect(result.killed).toBe(true);
      expect(result.session).toBe("aaron-agent");
      // The result is redacted (scopes surfaced, no token values).
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
      expect(killed).toEqual([]); // bailed before touching tmux
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

// ===========================================================================
// 3. The daemon routes (real handler, mocked JWT, stub AgentOps)
// ===========================================================================
function buildServer(agentOps?: Partial<AgentOps>) {
  const registry = new ClientRegistry();
  const transport = new HttpUiTransport({ channel: "ui1" });
  const channels = new Map<string, Channel>([
    ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
  ]);
  void transport.start({ channel: "ui1", emit: () => {}, emitPermissionVerdict: () => {} });
  const ops: AgentOps = {
    async spawn() {
      throw new Error("spawn not stubbed");
    },
    async list() {
      return [];
    },
    async kill() {
      return { killed: false };
    },
    async restart() {
      throw new Error("restart not stubbed");
    },
    ...agentOps,
  };
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry, { agentOps: ops }),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

describe("GET /agents — the management page (loads open)", () => {
  test("returns the HTML page with no token", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/agents`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("parachute-channel");
      expect(html).toContain("Spawn an agent");
    } finally {
      srv.stop(true);
    }
  });

  // UI gating (design 2026-06-16 + Aaron's gating decision): the backend selector
  // DEFAULTS to programmatic; interactive is moved behind an "Advanced" disclosure
  // (a collapsed <details>) but stays fully selectable.
  test("spawn form defaults the backend selector to programmatic + gates interactive under Advanced", async () => {
    const { srv, base } = buildServer();
    try {
      const html = await (await fetch(`${base}/agents`)).text();
      // The programmatic <option> carries `selected` (the default); interactive does not.
      expect(html).toMatch(/<option value="programmatic" selected>/);
      expect(html).not.toMatch(/<option value="interactive" selected>/);
      expect(html).toContain('<option value="interactive">');
      // Interactive lives behind an Advanced disclosure (a <details>) with the caveat.
      expect(html).toContain('<details id="backend-advanced"');
      expect(html).toContain("Advanced — interactive");
      expect(html).toContain("less stable");
      expect(html).toContain("Use Programmatic unless you specifically want");
    } finally {
      srv.stop(true);
    }
  });

  // Per-channel system prompt (design 2026-06-16-channel-system-prompt.md): the
  // spawn form carries a System prompt textarea + an Append (default)/Replace mode
  // control with the one-line hint.
  test("spawn form has a System prompt textarea + Append(default)/Replace mode control", async () => {
    const { srv, base } = buildServer();
    try {
      const html = await (await fetch(`${base}/agents`)).text();
      expect(html).toContain('id="spawn-system-prompt"');
      expect(html).toContain("System prompt");
      expect(html).toContain('<option value="append" selected>Append (default)</option>');
      expect(html).toContain('<option value="replace">Replace</option>');
      expect(html).toContain("Append keeps Claude Code's capable base");
    } finally {
      srv.stop(true);
    }
  });
});

describe("/api/agents — operator-gated on channel:admin", () => {
  test("GET with no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`);
      expect(res.status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("GET with channel:read (insufficient) → 403", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`, { headers: readAuth });
      expect(res.status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("GET with channel:admin → 200 + the agent list", async () => {
    const { srv, base } = buildServer({
      async list() {
        return [
          { name: "aaron", session: "aaron-agent", attached: true, workspace: "/s/aaron", hasWorkspace: true, backend: "interactive" as const },
        ];
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: { name: string }[] };
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]!.name).toBe("aaron");
    } finally {
      srv.stop(true);
    }
  });

  // The /api/agents response surfaces the system-prompt MODE but NEVER the prompt
  // text (the AgentInfo contract carries mode only — design 2026-06-16). A raw-body
  // scan proves the text can't leak through the list endpoint.
  test("GET surfaces systemPromptMode but never the prompt text", async () => {
    const secretPrompt = "TOP-SECRET-PROMPT-TEXT-do-not-leak";
    const { srv, base } = buildServer({
      async list() {
        return [
          {
            name: "aaron",
            session: "aaron-agent",
            attached: true,
            workspace: "/s/aaron",
            hasWorkspace: true,
            backend: "interactive" as const,
            systemPromptMode: "replace" as const,
          },
        ];
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const raw = await res.text();
      // The mode IS surfaced…
      expect(raw).toContain("systemPromptMode");
      expect(raw).toContain("replace");
      // …and the prompt TEXT never appears in the response (it isn't on AgentInfo).
      expect(raw).not.toContain(secretPrompt);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with no token → 401 (and spawn is never called)", async () => {
    let spawned = false;
    const { srv, base } = buildServer({
      async spawn() {
        spawned = true;
        throw new Error("unreachable");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", channels: ["x"] }),
      });
      expect(res.status).toBe(401);
      expect(spawned).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with admin token + valid interactive spec → 200 redacted result (no token values)", async () => {
    const { srv, base } = buildServer({
      async spawn(spec) {
        return {
          session: spec.name + "-agent",
          workspace: "/s/" + spec.name,
          alreadyRunning: false,
          tokens: { [spec.name]: { jti: "j", token: "LEAKME", expiresAt: "2026-07-01T00:00:00Z", scope: "channel:read channel:write" } },
          mcpConfigJson: JSON.stringify({ mcpServers: { ["channel-" + spec.name]: {} } }),
          wrapped: {
            argv: [],
            env: {},
            config: { network: { allowedDomains: ["api.anthropic.com:443"], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
          },
        } satisfies SpawnAgentResult;
      },
    });
    try {
      // backend:"interactive" is now an explicit opt-in (the default flipped to
      // programmatic) — this exercises the interactive (agentOps.spawn) path.
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("LEAKME");
      const body = JSON.parse(text) as { session: string; tokens: { scope: string }[]; mcpServers: string[] };
      expect(body.session).toBe("aaron-agent");
      expect(body.tokens[0]!.scope).toBe("channel:read channel:write");
      expect(body.mcpServers).toEqual(["channel-aaron"]);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with admin token + bad spec → 400 (spawn never called)", async () => {
    let spawned = false;
    const { srv, base } = buildServer({
      async spawn() {
        spawned = true;
        throw new Error("unreachable");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron" }), // no channels
      });
      expect(res.status).toBe(400);
      expect(spawned).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("interactive spawn throws CredentialNotConfiguredError → 400 with the fix", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new CredentialNotConfiguredError("aaron");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("no Claude credential");
    } finally {
      srv.stop(true);
    }
  });

  test("interactive spawn throws SpawnDepsError (no operator token) → 503", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new SpawnDepsError("no operator token");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(503);
    } finally {
      srv.stop(true);
    }
  });

  test("interactive spawn throws MintError → forwards the hub status", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new MintError("over-broad scope", 403, "forbidden");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("mint failed");
    } finally {
      srv.stop(true);
    }
  });
});

describe("GET /api/vaults", () => {
  test("no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/vaults`)).status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("admin token → 200 with a vaults array", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/vaults`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { vaults: unknown };
      expect(Array.isArray(body.vaults)).toBe(true);
    } finally {
      srv.stop(true);
    }
  });
});

describe("DELETE /api/agents/:name", () => {
  test("no token → 401 (kill never called)", async () => {
    let killed = false;
    const { srv, base } = buildServer({
      async kill() {
        killed = true;
        return { killed: true };
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron`, { method: "DELETE" });
      expect(res.status).toBe(401);
      expect(killed).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("channel:read (insufficient) → 403 (kill never called)", async () => {
    let killed = false;
    const { srv, base } = buildServer({
      async kill() {
        killed = true;
        return { killed: true };
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron`, { method: "DELETE", headers: readAuth });
      expect(res.status).toBe(403);
      expect(killed).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("admin token → 200 { killed }", async () => {
    const { srv, base } = buildServer({
      async kill(name) {
        expect(name).toBe("aaron");
        return { killed: true };
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; name: string; killed: boolean };
      expect(body).toEqual({ ok: true, name: "aaron", killed: true });
    } finally {
      srv.stop(true);
    }
  });

  test("kill's SpawnRequestError (bad slug) → 400", async () => {
    const { srv, base } = buildServer({
      async kill() {
        throw new SpawnRequestError("bad slug");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/whatever`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });
});

describe("POST /api/agents/:name/restart — per-session restart (channel:admin)", () => {
  function restartResult(name: string, killed: boolean) {
    return {
      session: name + "-agent",
      workspace: "/s/" + name,
      alreadyRunning: false,
      killed,
      tokens: [{ resource: name, scope: "channel:read channel:write", expiresAt: "2026-07-01T00:00:00Z" }],
      mcpServers: ["channel-" + name],
      filesystem: "workspace" as const,
      network: "open" as const,
      egress: [],
    };
  }

  test("no token → 401 (restart never called)", async () => {
    let restarted = false;
    const { srv, base } = buildServer({
      async restart() {
        restarted = true;
        return restartResult("aaron", true);
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST" });
      expect(res.status).toBe(401);
      expect(restarted).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("channel:read (insufficient) → 403 (restart never called)", async () => {
    let restarted = false;
    const { srv, base } = buildServer({
      async restart() {
        restarted = true;
        return restartResult("aaron", true);
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: readAuth });
      expect(res.status).toBe(403);
      expect(restarted).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("admin token → 200 redacted restart result (killed + new session, no token values)", async () => {
    const { srv, base } = buildServer({
      async restart(name) {
        expect(name).toBe("aaron");
        return restartResult("aaron", true);
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session: string; killed: boolean; mcpServers: string[] };
      expect(body.session).toBe("aaron-agent");
      expect(body.killed).toBe(true);
      expect(body.mcpServers).toEqual(["channel-aaron"]);
    } finally {
      srv.stop(true);
    }
  });

  test("a missing persisted spec (SpawnRequestError) → 400 with the fix", async () => {
    const { srv, base } = buildServer({
      async restart() {
        throw new SpawnRequestError("no persisted spec at .../spec.json");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("no persisted spec");
    } finally {
      srv.stop(true);
    }
  });

  test("a missing operator token (SpawnDepsError) → 503; a missing credential → 400", async () => {
    const deps = buildServer({
      async restart() {
        throw new SpawnDepsError("no operator token");
      },
    });
    try {
      const res = await fetch(`${deps.base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(503);
    } finally {
      deps.srv.stop(true);
    }
    const creds = buildServer({
      async restart() {
        throw new CredentialNotConfiguredError("aaron");
      },
    });
    try {
      const res = await fetch(`${creds.base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("no Claude credential");
    } finally {
      creds.srv.stop(true);
    }
  });

  test("a refused mint (MintError) → forwards the hub status", async () => {
    const { srv, base } = buildServer({
      async restart() {
        throw new MintError("over-broad scope", 403, "forbidden");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain("mint failed");
    } finally {
      srv.stop(true);
    }
  });
});
