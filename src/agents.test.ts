/**
 * Tests for the web agent-management layer (`src/agents.ts`) + the daemon's
 * `/agents` page and `/api/agents` routes (`src/daemon.ts`), POST-interactive-retire.
 *
 * The interactive (tmux) backend was retired 2026-06-19 (design
 * 2026-06-19-retire-interactive-backend.md) — its tmux spawner + session admin moved
 * to `src/_parked/interactive-spawn.ts` and are tested by
 * `src/_parked/interactive-spawn.test.ts`. The daemon no longer has an `agentOps`
 * seam; the spawn/list/restart/delete routes are programmatic-only (channel agents
 * are vault-native). Programmatic + channel routing is covered in
 * `programmatic-wiring.test.ts` / `channel-backend-wiring.test.ts`; here we cover
 * `buildSpecFromBody` + the auth gates / shapes of the daemon routes.
 */

import { describe, test, expect, mock } from "bun:test";
// Re-export the REAL error class + helper in the mock below so this process-wide
// `mock.module` doesn't break hub-jwt.test.ts's assertions on the genuine shapes.
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";

const ADMIN_TOKEN = "test-admin-token"; // agent:admin (the operator gate)
const READ_TOKEN = "test-read-token"; // agent:read only (insufficient)
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:read", "agent:send", "agent:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["agent:read"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { buildSpecFromBody, SpawnRequestError } from "./agents.ts";
import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import type { Channel } from "./registry.ts";

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;

// ===========================================================================
// buildSpecFromBody — body → validated AgentSpec (valid + every error)
// ===========================================================================
describe("buildSpecFromBody", () => {
  test("minimal valid body (one channel, defaults to write + programmatic backend)", () => {
    const spec = buildSpecFromBody({ name: "aaron", channels: ["aaron"] });
    // backend defaults to "programmatic" for a new request (the interactive default
    // was retired 2026-06-19).
    expect(spec).toEqual({ name: "aaron", channels: ["aaron"], backend: "programmatic" });
  });

  test("rejects a missing/empty name", () => {
    expect(() => buildSpecFromBody({ channels: ["c"] })).toThrow(/name/);
    expect(() => buildSpecFromBody({ name: "", channels: ["c"] })).toThrow(/name/);
  });

  test("rejects a non-slug name", () => {
    expect(() => buildSpecFromBody({ name: "../escape", channels: ["c"] })).toThrow(/slug/);
  });

  test("rejects missing / empty channels", () => {
    expect(() => buildSpecFromBody({ name: "a" })).toThrow(/channels/);
    expect(() => buildSpecFromBody({ name: "a", channels: [] })).toThrow(/channels/);
  });

  test("scoped channel object form { name, access } is honored", () => {
    const spec = buildSpecFromBody({ name: "a", channels: [{ name: "ops", access: "read" }] });
    expect(spec.channels).toEqual([{ name: "ops", access: "read" }]);
  });

  test("a vault binding with tag-scope is parsed", () => {
    const spec = buildSpecFromBody({
      name: "a",
      channels: ["c"],
      vault: { name: "default", access: "write", tags: ["#agent/message"] },
    });
    expect(spec.vault).toEqual({ name: "default", access: "write", tags: ["#agent/message"] });
  });

  test("rejects a bad filesystem / network value", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], filesystem: "weird" })).toThrow(/filesystem/);
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], network: "weird" })).toThrow(/network/);
  });

  test("rejects a non-string workspace", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], workspace: 42 })).toThrow(/workspace must be a string/);
  });

  // Backend selection post-retire: omitted → programmatic; "attached" (and the legacy
  // value "channel") is vault-native (rejected with the deflect message); "interactive"
  // is retired (rejected); any other value is rejected.
  test("omitted backend → programmatic (the new-request default)", () => {
    expect(buildSpecFromBody({ name: "a", channels: ["c"] }).backend).toBe("programmatic");
    expect(buildSpecFromBody({ name: "a", channels: ["c"], backend: null }).backend).toBe("programmatic");
  });
  test("explicit backend:\"programmatic\" is honored", () => {
    expect(buildSpecFromBody({ name: "a", channels: ["c"], backend: "programmatic" }).backend).toBe("programmatic");
  });
  test("backend:\"interactive\" is REJECTED (retired)", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], backend: "interactive" })).toThrow(/retired/);
  });
  test("backend:\"attached\" is REJECTED via this endpoint (vault-native)", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], backend: "attached" })).toThrow(/vault-native/);
  });
  test("the legacy backend:\"channel\" is ALSO deflected as vault-native (dual-read)", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], backend: "channel" })).toThrow(/vault-native/);
  });
  test("rejects an invalid backend value", () => {
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], backend: "weird" })).toThrow(/backend/);
  });

  // Per-channel system prompt (design 2026-06-16-channel-system-prompt.md).
  test("systemPrompt parsed + default mode is append", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "You are the eng bot." });
    expect(spec.systemPrompt).toBe("You are the eng bot.");
    expect(spec.systemPromptMode).toBe("append");
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
    expect(() => buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: 42 })).toThrow(/systemPrompt must be a string/);
  });
  test("systemPrompt is trimmed", () => {
    const spec = buildSpecFromBody({ name: "a", channels: ["c"], systemPrompt: "  hi  " });
    expect(spec.systemPrompt).toBe("hi");
  });
});

// ===========================================================================
// The daemon routes (real handler, mocked JWT). No interactive `agentOps` seam.
// ===========================================================================
function buildServer() {
  const registry = new ClientRegistry();
  const transport = new HttpUiTransport({ channel: "ui1" });
  const channels = new Map<string, Channel>([
    ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
  ]);
  void transport.start({ channel: "ui1", emit: () => {}, emitPermissionVerdict: () => {} });
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

describe("GET /agents — retired into the SPA (Phase 4c)", () => {
  test("302 redirects to the SPA app root", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/agents`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("app/");
    } finally {
      srv.stop(true);
    }
  });
});

describe("/api/agents — operator-gated on agent:admin", () => {
  test("GET with no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents`)).status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("GET with agent:read (insufficient) → 403", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents`, { headers: readAuth })).status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("GET with agent:admin → 200 + an (empty) agent list", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { agents: unknown[] };
      expect(Array.isArray(body.agents)).toBe(true);
      // No interactive tmux sessions are merged in anymore — the list is the
      // registered programmatic + channel agents (none registered here).
      expect(body.agents).toEqual([]);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", channels: ["x"] }),
      });
      expect(res.status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with admin token + bad spec → 400", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron" }), // no channels
      });
      expect(res.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });

  test("POST with backend:\"interactive\" → 400 (retired)", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { ...adminAuth, "content-type": "application/json" },
        body: JSON.stringify({ name: "aaron", channels: ["aaron"], backend: "interactive" }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("retired");
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
  test("no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents/aaron`, { method: "DELETE" })).status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("agent:read (insufficient) → 403", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents/aaron`, { method: "DELETE", headers: readAuth })).status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("admin token, no live agent → 200 idempotent no-op { killed: false }", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents/aaron`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; name: string; killed: boolean };
      expect(body).toEqual({ ok: true, name: "aaron", killed: false });
    } finally {
      srv.stop(true);
    }
  });
});

describe("POST /api/agents/:name/restart — per-session restart (agent:admin)", () => {
  test("no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents/aaron/restart`, { method: "POST" })).status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });

  test("agent:read (insufficient) → 403", async () => {
    const { srv, base } = buildServer();
    try {
      expect((await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: readAuth })).status).toBe(403);
    } finally {
      srv.stop(true);
    }
  });

  test("admin token, no programmatic agent by that name → 404", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/agents/aaron/restart`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });
});

// Keep a direct reference so the SpawnRequestError import is exercised.
test("SpawnRequestError carries its message", () => {
  expect(new SpawnRequestError("boom").message).toBe("boom");
});
