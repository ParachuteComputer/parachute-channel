/**
 * Daemon auth-gate tests (Layer 1, bridge-facing).
 *
 * Spins the real daemon fetch handler (`createFetchHandler`) on an ephemeral
 * `Bun.serve` with one http-ui channel, and asserts the bridge-facing endpoints
 * reject a request with no Authorization header (401) while the UI-facing /
 * discovery endpoints stay open (200).
 *
 * Crucially this needs NO live hub / JWKS: the no-token path in `requireScope`
 * short-circuits before any JWKS fetch. We deliberately do NOT mint or validate
 * a real JWT here — that's scope-guard's own tested surface. What we own is the
 * routing layer: which endpoints are guarded, which are exempt, and that the
 * no-token reject is wired in front of the guarded handlers.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import type { Channel } from "./registry.ts";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  const registry = new ClientRegistry();
  const transport = new HttpUiTransport({ channel: "ui1" });
  const channels = new Map<string, Channel>([
    ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
  ]);
  // Wire the transport's ctx so its ingestHttp routes (open) work.
  await transport.start({
    channel: "ui1",
    emit: () => {},
    emitPermissionVerdict: () => {},
  });

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

describe("bridge-facing endpoints require a bearer token (401 with none)", () => {
  test("GET /events with no Authorization → 401", async () => {
    const res = await fetch(`${base}/events?channel=ui1`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
    // Make sure the SSE stream did NOT open — a 401 must short-circuit.
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("POST /api/reply with no Authorization → 401", async () => {
    const res = await fetch(`${base}/api/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "ui1", text: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("POST /api/react with no Authorization → 401", async () => {
    const res = await fetch(`${base}/api/react`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "ui1", message_id: "1", emoji: "👍" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/edit with no Authorization → 401", async () => {
    const res = await fetch(`${base}/api/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "ui1", message_id: "1", text: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/permission with no Authorization → 401", async () => {
    const res = await fetch(`${base}/api/permission`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "ui1",
        request_id: "r1",
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    });
    expect(res.status).toBe(401);
  });

  test("POST /api/download with no Authorization → 401", async () => {
    const res = await fetch(`${base}/api/download`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "ui1", file_id: "f1" }),
    });
    expect(res.status).toBe(401);
  });

  test("an invalid bearer is also rejected (401, no JWKS needed for a non-JWT)", async () => {
    // A non-JWT bearer can't reach the JWKS — looksLikeJwt is false so the lib
    // rejects shape-first. Still no network.
    const res = await fetch(`${base}/api/reply`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ channel: "ui1", text: "hi" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("UI-facing + discovery endpoints stay open (no token, 200)", () => {
  test("GET /health → 200", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("ok");
  });

  test("GET /.parachute/config → 200", async () => {
    const res = await fetch(`${base}/.parachute/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channels: unknown[] };
    expect(Array.isArray(body.channels)).toBe(true);
  });

  test("GET /.parachute/config/schema → 200", async () => {
    const res = await fetch(`${base}/.parachute/config/schema`);
    expect(res.status).toBe(200);
  });

  test("GET /ui → 200 (html)", async () => {
    const res = await fetch(`${base}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

});

// ---------------------------------------------------------------------------
// Layer 2 (human↔UI): the http-ui transport's send + SSE routes are gated the
// same way — a hub JWT (no-token → 401, short-circuits pre-JWKS). The token may
// arrive as a Bearer header (send) or a ?token= query param (SSE). Asserted here
// through the REAL daemon fetch handler so we cover the daemon → ingestHttp →
// requireScope wiring, not just the transport in isolation.
// ---------------------------------------------------------------------------
describe("Layer 2 — http-ui UI endpoints require a token (401 with none)", () => {
  test("POST /api/channels/ui1/send with no token → 401", async () => {
    const res = await fetch(`${base}/api/channels/ui1/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "from-ui" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthorized");
  });

  test("GET /ui/events with no ?token= → 401", async () => {
    const res = await fetch(`${base}/ui/events?channel=ui1`);
    expect(res.status).toBe(401);
    // Must short-circuit before the SSE stream opens.
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
