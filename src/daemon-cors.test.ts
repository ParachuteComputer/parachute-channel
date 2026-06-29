/**
 * CORS — the agent daemon SELF-SETS module-level CORS headers on every response
 * (mirroring the vault), so the browser surface's cross-origin reads aren't
 * blocked behind the hub reverse proxy. The motivating bug: the "watch it work"
 * turn-events SSE (`GET /api/channels/<ch>/turn-events`) opened cross-origin from
 * the surface was CORS-blocked because the daemon set NO `Access-Control-*`
 * headers on any response.
 *
 * Three things to lock here:
 *  (a) a STREAMING (SSE) turn-events 200 carries `Access-Control-Allow-Origin`
 *      AND its `text/event-stream` body survives the header-merge reconstruction
 *      (a streaming Response's headers can't be mutated in place, so `withCors`
 *      reconstructs — this is the load-bearing, easy-to-break part);
 *  (b) a JSON API response carries the CORS headers;
 *  (c) an `OPTIONS` preflight short-circuits to 204 + the CORS headers.
 *
 * Pure handler-level: we call the fetch handler returned by `createFetchHandler`
 * DIRECTLY with a `Request` (no live port bound, no `Bun.serve`, no daemon
 * booted). The SSE ticket is minted via `ui-ticket.ts` directly (the route gates
 * on `requireSseTicket`), so no hub/JWKS is needed.
 */
import { describe, test, expect, beforeEach } from "bun:test";

import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { mintTicket, _resetTicketsForTest } from "./ui-ticket.ts";
import type { Channel } from "./registry.ts";

beforeEach(() => {
  _resetTicketsForTest();
});

/** A plain handler over empty channel/turn-event registries (no live deps). */
function handler() {
  const channels = new Map<string, Channel>();
  const registry = new ClientRegistry();
  const turnEvents = new ClientRegistry();
  return createFetchHandler(channels, registry, { turnEvents });
}

describe("CORS — module self-sets Access-Control-* on every response", () => {
  test("(a) turn-events SSE 200 carries CORS + preserves the text/event-stream body", async () => {
    const fetch = handler();
    const { ticket } = mintTicket(["agent:read"]);
    const res = await fetch(
      new Request(`http://x/api/channels/eng/turn-events?ticket=${ticket}`),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // The streaming body must survive the header-merge reconstruction.
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    // The route enqueues string chunks; read in-process they come back as
    // strings (over the wire Bun serializes them to bytes) — handle both.
    const chunk = typeof value === "string" ? value : new TextDecoder().decode(value!);
    expect(chunk).toContain(": connected");
    await reader.cancel();
  });

  test("(b) a JSON API response carries the CORS headers", async () => {
    const fetch = handler();
    const res = await fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("content-type")).toContain("application/json");
    // The body still parses — reconstruction preserved it.
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  test("(c) an OPTIONS preflight short-circuits to 204 + the CORS headers", async () => {
    const fetch = handler();
    const res = await fetch(
      new Request("http://x/api/channels/eng/turn-events", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});
