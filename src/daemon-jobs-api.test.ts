/**
 * Integration tests for the scheduled-jobs API (`/api/jobs*`) on the REAL daemon
 * fetch handler (runner, design 2026-06-17). They cover:
 *
 *  - auth: all routes require `agent:admin` (no token → 401; agent:read → 403);
 *  - GET    /api/jobs          → lists `#agent/job` notes across the vault channels;
 *  - POST   /api/jobs          → 400 on bad cron / unknown / non-vault channel;
 *                                200 + writes a #agent/job note on success;
 *  - POST   /api/jobs/:id/run  → fires now (injects an inbound #agent/message note);
 *  - DELETE /api/jobs/:id      → deletes the job note.
 *
 * The vault REST API is stubbed via `globalThis.fetch` (no live vault); the hub
 * JWT validator is stubbed (sentinel tokens → fixed scopes) so the accept paths
 * run without a live hub/JWKS. Mirrors daemon-config-api.test.ts's approach.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";

const ADMIN_TOKEN = "test-admin-token";
const READ_TOKEN = "test-read-token";
mock.module("./hub-jwt.ts", () => ({
  AGENT_AUDIENCE: "agent",
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "agent", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["agent:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["agent:read"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { VaultTransport } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";
import type { TransportContext } from "./transport.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const adminAuth = { authorization: "Bearer " + ADMIN_TOKEN } as const;
const readAuth = { authorization: "Bearer " + READ_TOKEN } as const;

/**
 * A live channels map: one vault channel ("eng") + one telegram-shaped channel
 * stub ("tg", non-vault) so the non-vault rejection path is exercised. The vault
 * REST calls are routed through the `vaultFetch` stub the caller installs.
 */
function buildServer() {
  const registry = new ClientRegistry();
  const channels = new Map<string, Channel>();
  const eng = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "vtok", declareSchemaOnStart: false });
  const ctx: TransportContext = { channel: "eng", emit() {}, emitPermissionVerdict() {} };
  void eng.start(ctx);
  channels.set("eng", { name: "eng", transport: eng, entry: { name: "eng", transport: "vault", config: { vault: "default" } } });

  // A minimal non-vault transport stub for the "non-vault channel rejected" case.
  const tgTransport = {
    kind: "telegram",
    async start() {},
    async stop() {},
    async reply() { return { sent: [] }; },
  };
  channels.set("tg", { name: "tg", transport: tgTransport as unknown as Channel["transport"], entry: { name: "tg", transport: "telegram" } });

  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: createFetchHandler(channels, registry) });
  return { srv, base: `http://127.0.0.1:${srv.port}`, channels };
}

/**
 * Install a fetch stub that intercepts ONLY vault REST calls (port 1940 — the
 * VaultTransport's `vaultUrl`) and records them + returns canned responses.
 * Requests to ANY other URL — crucially the test client's own calls to the
 * loopback test server — pass through to the real fetch, so overriding
 * `globalThis.fetch` doesn't swallow the request under test.
 */
function stubVault(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes(":1940/")) {
      calls.push({ url: u, init: init ?? {} });
      return handler(u, init ?? {});
    }
    return realFetch(url as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  return calls;
}

describe("/api/jobs — auth", () => {
  test("no token → 401", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/jobs`);
      expect(res.status).toBe(401);
    } finally { srv.stop(true); }
  });

  test("agent:read (insufficient) → 403", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/jobs`, { headers: readAuth });
      expect(res.status).toBe(403);
    } finally { srv.stop(true); }
  });
});

describe("GET /api/jobs — list", () => {
  test("lists #agent/job notes from the vault", async () => {
    const { srv, base } = buildServer();
    stubVault(() =>
      new Response(
        JSON.stringify([
          { id: "Channels/eng/jobs/m", content: "go", metadata: { channel: "eng", cron: "0 9 * * *", enabled: "true", createdAt: "t0" } },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    try {
      const res = await fetch(`${base}/api/jobs`, { headers: adminAuth });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0]).toMatchObject({ id: "Channels/eng/jobs/m", channel: "eng", message: "go" });
    } finally { srv.stop(true); }
  });
});

describe("POST /api/jobs — create + validation", () => {
  test("bad cron → 400", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ id: "x", channel: "eng", message: "m", schedule: { cron: "99 9 * * *" } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/cron/);
    } finally { srv.stop(true); }
  });

  test("unknown channel → 400", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ id: "x", channel: "ghost", message: "m", schedule: { cron: "0 9 * * *" } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/unknown channel/);
    } finally { srv.stop(true); }
  });

  test("non-vault channel → 400", async () => {
    const { srv, base } = buildServer();
    try {
      const res = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ id: "x", channel: "tg", message: "m", schedule: { cron: "0 9 * * *" } }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not a vault channel/);
    } finally { srv.stop(true); }
  });

  test("valid → 200 + writes a #agent/job note", async () => {
    const { srv, base } = buildServer();
    const calls = stubVault((url, init) => {
      // The job POST is to /api/notes; everything else (ensureSchema PUTs) is benign.
      if (url.endsWith("/api/notes") && init.method === "POST") {
        return new Response(JSON.stringify({ id: "Channels/eng/jobs/x" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const res = await fetch(`${base}/api/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...adminAuth },
        body: JSON.stringify({ id: "x", channel: "eng", message: "  do it  ", schedule: { cron: "0 9 * * *", tz: "UTC" } }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.job.id).toBe("x"); // the operator slug stays the id
      expect(body.job.noteId).toBe("Channels/eng/jobs/x"); // vault note id for addressing
      const post = calls.find((c) => c.url.endsWith("/api/notes") && c.init.method === "POST")!;
      const sent = JSON.parse(String(post.init.body));
      expect(sent.tags).toEqual(["agent/job"]);
      expect(sent.content).toBe("do it"); // trimmed
      expect(sent.metadata.enabled).toBe("true");
      expect(sent.metadata.jobId).toBe("x");
    } finally { srv.stop(true); }
  });
});

describe("POST /api/jobs/:id/run — fire now", () => {
  test("injects an inbound #agent/message note + returns ok", async () => {
    const { srv, base } = buildServer();
    const calls = stubVault((url, init) => {
      if (url.includes("/api/notes") && (init.method ?? "GET") === "GET") {
        // The store's listAll → return the job to find.
        return new Response(
          JSON.stringify([{ id: "Channels/eng/jobs/x", content: "do it", metadata: { channel: "eng", cron: "0 9 * * *", enabled: "true", createdAt: "t0" } }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // The inject POST (and any patch).
      return new Response(JSON.stringify({ id: "inbound-1" }), { status: 201, headers: { "content-type": "application/json" } });
    });
    try {
      // The "id" the route addresses is the vault NOTE id returned by the list.
      const res = await fetch(`${base}/api/jobs/${encodeURIComponent("Channels/eng/jobs/x")}/run`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      // The injected note is INBOUND with the #agent/message tags.
      const inject = calls.find((c) => c.url.endsWith("/api/notes") && c.init.method === "POST")!;
      const sent = JSON.parse(String(inject.init.body));
      expect(sent.tags).toEqual(["agent/message", "agent/message/inbound"]);
      expect(sent.metadata.sender).toBe("runner:Channels/eng/jobs/x");
    } finally { srv.stop(true); }
  });

  test("unknown job id → 404", async () => {
    const { srv, base } = buildServer();
    stubVault(() => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const res = await fetch(`${base}/api/jobs/nope/run`, { method: "POST", headers: adminAuth });
      expect(res.status).toBe(404);
    } finally { srv.stop(true); }
  });
});

describe("DELETE /api/jobs/:id", () => {
  test("deletes the job note", async () => {
    const { srv, base } = buildServer();
    const calls = stubVault((url, init) => {
      if (url.includes("/api/notes") && (init.method ?? "GET") === "GET") {
        return new Response(
          JSON.stringify([{ id: "Channels/eng/jobs/x", content: "go", metadata: { channel: "eng", cron: "0 9 * * *", enabled: "true" } }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 204 });
    });
    try {
      const res = await fetch(`${base}/api/jobs/Channels%2Feng%2Fjobs%2Fx`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      expect((await res.json()).removed).toBe(true);
      expect(calls.some((c) => c.init.method === "DELETE")).toBe(true);
    } finally { srv.stop(true); }
  });

  test("deleting an absent job is idempotent (removed:false)", async () => {
    const { srv, base } = buildServer();
    stubVault(() => new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } }));
    try {
      const res = await fetch(`${base}/api/jobs/gone`, { method: "DELETE", headers: adminAuth });
      expect(res.status).toBe(200);
      expect((await res.json()).removed).toBe(false);
    } finally { srv.stop(true); }
  });
});
