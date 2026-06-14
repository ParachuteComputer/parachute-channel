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
import type { SpawnAgentResult } from "./spawn-agent.ts";

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
});

describe("buildSpecFromBody", () => {
  test("minimal valid body (one channel, defaults to write)", () => {
    const spec = buildSpecFromBody({ name: "aaron", channels: ["aaron"] });
    expect(spec).toEqual({ name: "aaron", channels: ["aaron"] });
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
  test("egressUnrestricted is accepted and overrides per-host egress", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], egressUnrestricted: true, egress: ["x.com"] });
    expect(spec.egressUnrestricted).toBe(true);
    expect(spec.egress).toBeUndefined(); // allow-all is strictly broader
  });
  test("rejects a non-boolean egressUnrestricted", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], egressUnrestricted: "yes" })).toThrow(/egressUnrestricted/);
  });
  test("rejects relative mount paths (must be absolute)", () => {
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], mounts: [{ hostPath: "rel", mountPath: "/m", mode: "ro" }] }),
    ).toThrow(/hostPath must be an absolute path/);
    expect(() =>
      buildSpecFromBody({ name: "a", channels: ["c"], mounts: [{ hostPath: "/h", mountPath: "rel", mode: "ro" }] }),
    ).toThrow(/mountPath must be an absolute path/);
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
      config: { network: { allowedDomains: ["api.anthropic.com:443"], deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } },
    },
  };
  test("surfaces scopes + mcp servers + egress, NEVER the token values", () => {
    const red = redactSpawnResult(result);
    expect(red.session).toBe("aaron-agent");
    expect(red.tokens).toEqual([
      { resource: "aaron", scope: "channel:read channel:write", expiresAt: "2026-07-01T00:00:00Z" },
      { resource: "vault:default", scope: "vault:default:read", expiresAt: "2026-07-01T00:00:00Z" },
    ]);
    expect(red.mcpServers).toEqual(["channel-aaron", "vault-default"]);
    expect(red.egress).toEqual(["api.anthropic.com:443"]);
    expect(red.egressUnrestricted).toBe(false);
    // The smoking gun: no token VALUE appears anywhere in the serialized result.
    const wire = JSON.stringify(red);
    expect(wire).not.toContain("SECRET-CHANNEL-TOKEN");
    expect(wire).not.toContain("SECRET-VAULT-TOKEN");
  });
  test("an unrestricted-network result (no allowedDomains) → egressUnrestricted true, egress []", () => {
    const unrestricted: SpawnAgentResult = {
      ...result,
      wrapped: {
        ...result.wrapped,
        // allow-all: allowedDomains absent (the runtime's no-restriction shape).
        config: { network: { deniedDomains: [] }, filesystem: { denyRead: [], allowWrite: [], denyWrite: [] } } as unknown as SpawnAgentResult["wrapped"]["config"],
      },
    };
    const red = redactSpawnResult(unrestricted);
    expect(red.egressUnrestricted).toBe(true);
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
          { name: "aaron", session: "aaron-agent", attached: true, workspace: "/s/aaron", hasWorkspace: true },
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

  test("POST with admin token + valid spec → 200 redacted result (no token values)", async () => {
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
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"] }),
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

  test("spawn throws CredentialNotConfiguredError → 400 with the fix", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new CredentialNotConfiguredError("aaron");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("no Claude credential");
    } finally {
      srv.stop(true);
    }
  });

  test("spawn throws SpawnDepsError (no operator token) → 503", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new SpawnDepsError("no operator token");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"] }),
      });
      expect(res.status).toBe(503);
    } finally {
      srv.stop(true);
    }
  });

  test("spawn throws MintError → forwards the hub status", async () => {
    const { srv, base } = buildServer({
      async spawn() {
        throw new MintError("over-broad scope", 403, "forbidden");
      },
    });
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"] }),
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
