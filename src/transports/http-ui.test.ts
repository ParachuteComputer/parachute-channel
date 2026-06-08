/**
 * Tier 1 unit + integration tests for the http-ui transport.
 *
 * These exercise the transport (and a daemon-shaped Bun.serve harness) WITHOUT a
 * live Claude session. They cover:
 *   - inbound routing: a UI `send` reaches the bridge subscribed to that channel;
 *   - outbound to UI: `transport.reply()` pushes a `reply` event to a connected
 *     /ui/events SSE client;
 *   - round-trip through the daemon HTTP server (UI send → bridge, bridge reply
 *     → UI) with no Claude;
 *   - channel isolation (a send on A never reaches a UI client on B);
 *   - registry: an http-ui channel instantiates without a token;
 *   - reply() with no connected UI client does not throw.
 */

import { describe, test, expect, mock } from "bun:test";

// Layer 2 gates the http-ui send + SSE routes on `requireScope`, which validates
// a hub JWT against the hub's JWKS. The no-token path short-circuits to 401
// before any JWKS fetch (asserted below). To exercise the *delivery* paths
// (routing, SSE fan-out) without a live hub, stub the JWT validator so a single
// sentinel token validates with the channel scopes. A request with no token (or
// any other token) still hits the real no-token / shape-first reject. This keeps
// the round-trip coverage genuine while staying hub-free.
const VALID_TOKEN = "test-valid-token";
// A token carrying ONLY channel:write (a session/bridge token) — must be
// REJECTED on the UI send endpoint, which requires channel:send. Locks the
// privilege separation (a session token can't post as a human).
const WRITE_ONLY_TOKEN = "test-write-only-token";
mock.module("../hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    if (token === VALID_TOKEN) {
      return {
        sub: "test",
        scopes: ["channel:read", "channel:send", "channel:write"],
        aud: "channel",
        jti: undefined,
        clientId: undefined,
        vaultScope: undefined,
      };
    }
    if (token === WRITE_ONLY_TOKEN) {
      return {
        sub: "test",
        scopes: ["channel:write"],
        aud: "channel",
        jti: undefined,
        clientId: undefined,
        vaultScope: undefined,
      };
    }
    throw new HubJwtError("invalid token");
  },
  HubJwtError: class HubJwtError extends Error {},
  looksLikeJwt: (t: string) => t.split(".").length === 3,
  resetJwksCache() {},
  resetRevocationCache() {},
}));
class HubJwtError extends Error {}

import { HttpUiTransport } from "./http-ui.ts";
import type { TransportContext, InboundMessage } from "../transport.ts";
import { ClientRegistry } from "../routing.ts";
import { instantiateTransport } from "../registry.ts";

/** Authorization header carrying the sentinel valid token. */
const AUTH = { authorization: "Bearer " + VALID_TOKEN } as const;
/** Append the sentinel token as a `?token=` query param (the SSE auth path). */
function withToken(path: string): string {
  return path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(VALID_TOKEN);
}

/** A test context that records emitted inbound messages + permission verdicts. */
function fakeCtx(channel: string): TransportContext & {
  emitted: InboundMessage[];
  verdicts: { request_id: string; behavior: string }[];
} {
  const emitted: InboundMessage[] = [];
  const verdicts: { request_id: string; behavior: string }[] = [];
  return {
    channel,
    emitted,
    verdicts,
    emit(msg) {
      emitted.push(msg);
    },
    emitPermissionVerdict(v) {
      verdicts.push(v);
    },
  };
}

/**
 * Read the next non-comment SSE frame from a reader. Handles both the bytes a
 * `fetch` response body yields and the raw string chunks a directly-read
 * in-process ReadableStream<string> yields (the transport enqueues strings).
 */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array | string>,
  decoder = new TextDecoder(),
): Promise<string> {
  while (true) {
    const { value, done } = await reader.read();
    if (done) return "";
    const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });
    if (chunk.includes("event:")) return chunk;
  }
}

describe("HttpUiTransport — direct", () => {
  test("ingestHttp send (authed) → ctx.emit on its own channel", async () => {
    const t = new HttpUiTransport();
    const ctx = fakeCtx("dev");
    await t.start(ctx);

    const req = new Request("http://x/api/channels/dev/send", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ text: "hello session" }),
    });
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true });

    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.content).toBe("hello session");
    expect(ctx.emitted[0]!.channel).toBe("dev");
    expect(ctx.emitted[0]!.source).toBe("http-ui");
  });

  test("ingestHttp send WITHOUT a token → 401, no emit (Layer 2)", async () => {
    const t = new HttpUiTransport();
    const ctx = fakeCtx("dev");
    await t.start(ctx);
    const req = new Request("http://x/api/channels/dev/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "no token" }),
    });
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(ctx.emitted).toHaveLength(0);
  });

  test("ingestHttp send with a channel:write-only (session) token → 403, no emit", async () => {
    // Privilege separation: a session/bridge token (channel:write) must NOT be
    // usable to post a human message through the UI send endpoint (channel:send).
    const t = new HttpUiTransport();
    const ctx = fakeCtx("dev");
    await t.start(ctx);
    const req = new Request("http://x/api/channels/dev/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + WRITE_ONLY_TOKEN },
      body: JSON.stringify({ text: "trying to send as a session" }),
    });
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(ctx.emitted).toHaveLength(0);
  });

  test("ingestHttp SSE WITHOUT a ?token= → 401 (Layer 2)", async () => {
    const t = new HttpUiTransport();
    await t.start(fakeCtx("dev"));
    const req = new Request("http://x/ui/events?channel=dev");
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    expect(res!.headers.get("content-type")).toContain("application/json");
  });

  test("ingestHttp ignores a send for a DIFFERENT channel's path", async () => {
    const t = new HttpUiTransport();
    await t.start(fakeCtx("dev"));
    const req = new Request("http://x/api/channels/other/send", {
      method: "POST",
      body: JSON.stringify({ text: "nope" }),
    });
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res).toBeNull();
  });

  test("send (authed) with empty/missing text → 400, no emit", async () => {
    const t = new HttpUiTransport();
    const ctx = fakeCtx("dev");
    await t.start(ctx);
    const req = new Request("http://x/api/channels/dev/send", {
      method: "POST",
      headers: { ...AUTH },
      body: JSON.stringify({ text: "" }),
    });
    const res = await t.ingestHttp(req, new URL(req.url));
    expect(res!.status).toBe(400);
    expect(ctx.emitted).toHaveLength(0);
  });

  test("reply() with no connected UI client does not throw and returns sent:[]", async () => {
    const t = new HttpUiTransport();
    await t.start(fakeCtx("dev"));
    const result = await t.reply({ channel: "dev", text: "ping" });
    expect(result.sent).toEqual([]);
  });

  test("reply() pushes a `reply` event to a connected /ui/events SSE client", async () => {
    const t = new HttpUiTransport();
    await t.start(fakeCtx("dev"));

    // Open the UI SSE stream via ingestHttp (authed via ?token=).
    const sseReq = new Request("http://x" + withToken("/ui/events?channel=dev"));
    const sseRes = await t.ingestHttp(sseReq, new URL(sseReq.url));
    expect(sseRes).not.toBeNull();
    const reader = sseRes!.body!.getReader();

    // Drain the ": connected" comment, then reply.
    const result = await t.reply({ channel: "dev", text: "from session", files: ["/tmp/a.png"] });
    expect(result.sent).toHaveLength(1);

    const frame = await readFrame(reader);
    expect(frame).toContain("event: reply");
    expect(frame).toContain("from session");
    expect(frame).toContain("/tmp/a.png");
    reader.cancel().catch(() => {});
  });

  test("stop() clears UI clients", async () => {
    const t = new HttpUiTransport();
    await t.start(fakeCtx("dev"));
    const sseReq = new Request("http://x" + withToken("/ui/events?channel=dev"));
    const sseRes = await t.ingestHttp(sseReq, new URL(sseReq.url));
    sseRes!.body!.getReader();
    await t.stop();
    // After stop, a reply reaches nobody.
    const result = await t.reply({ channel: "dev", text: "x" });
    expect(result.sent).toEqual([]);
  });
});

describe("registry — http-ui", () => {
  test("an http-ui channel instantiates without a token", () => {
    const transport = instantiateTransport({ name: "dev", transport: "http-ui" });
    expect(transport.kind).toBe("http-ui");
  });
});

// ---------------------------------------------------------------------------
// Daemon-shaped integration: a Bun.serve harness wiring routing + ingestHttp,
// mirroring daemon.ts. No Claude.
// ---------------------------------------------------------------------------

describe("HttpUiTransport — through a daemon-shaped server", () => {
  /** Build a minimal daemon-shaped server over the given channels. */
  function buildServer(channelDefs: { name: string }[]) {
    const registry = new ClientRegistry();
    const channels = new Map<string, { name: string; transport: HttpUiTransport }>();
    for (const def of channelDefs) {
      const transport = new HttpUiTransport();
      channels.set(def.name, { name: def.name, transport });
    }

    // Start each transport with a ctx that routes into the bridge registry,
    // exactly like daemon.ts's contextFor.
    for (const ch of channels.values()) {
      const name = ch.name;
      const ctx: TransportContext = {
        channel: name,
        emit(msg) {
          registry.routeToChannel(name, "message", {
            content: msg.content,
            meta: msg.meta,
            source: msg.source,
          });
        },
        emitPermissionVerdict(v) {
          registry.routeToChannel(name, "permission_verdict", v);
        },
      };
      ch.transport.start(ctx);
    }

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      async fetch(req) {
        const url = new URL(req.url);

        // Bridge SSE subscription (mirrors daemon /events).
        if (req.method === "GET" && url.pathname === "/events") {
          const channel = url.searchParams.get("channel") ?? "default";
          const id = crypto.randomUUID();
          const stream = new ReadableStream<string>({
            start(controller) {
              registry.add(id, { channel, enqueue: (p) => controller.enqueue(p) });
              controller.enqueue(": connected\n\n");
            },
            cancel() {
              registry.remove(id);
            },
          });
          return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }

        // Bridge reply (mirrors daemon /api/reply dispatch).
        if (req.method === "POST" && url.pathname === "/api/reply") {
          const body = (await req.json()) as { channel: string; text?: string };
          const ch = channels.get(body.channel);
          if (!ch) return new Response(JSON.stringify({ error: "unknown channel" }), { status: 400 });
          const r = await ch.transport.reply({ channel: body.channel, text: body.text });
          return new Response(JSON.stringify({ sent: r.sent }), {
            headers: { "content-type": "application/json" },
          });
        }

        // Transport-owned routes (send + /ui/events).
        for (const ch of channels.values()) {
          const res = await ch.transport.ingestHttp(req, url);
          if (res) return res;
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      },
    });

    return { server, base: `http://127.0.0.1:${server.port}`, registry };
  }

  /** Open an SSE stream and return a reader + helpers. The http-ui `/ui/events`
   *  route is Layer-2-gated, so append the sentinel `?token=` for those; the
   *  bridge `/events` route in this harness is ungated (pass through as-is). */
  async function openSse(base: string, path: string) {
    const url = path.startsWith("/ui/events") ? withToken(path) : path;
    const res = await fetch(`${base}${url}`);
    const reader = res.body!.getReader();
    return {
      read: () => readFrame(reader),
      cancel: () => reader.cancel().catch(() => {}),
    };
  }

  test("inbound routing: UI send reaches the subscribed bridge", async () => {
    const { server, base, registry } = buildServer([{ name: "dev" }]);
    try {
      // A bridge subscribes to channel "dev".
      const bridge = await openSse(base, "/events?channel=dev");
      // Wait for registration.
      const start = Date.now();
      while (registry.size < 1 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(registry.size).toBe(1);

      // UI POSTs a send (authed — Layer 2).
      const res = await fetch(`${base}/api/channels/dev/send`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ text: "hi from UI" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const frame = await bridge.read();
      expect(frame).toContain("event: message");
      expect(frame).toContain("hi from UI");
      bridge.cancel();
    } finally {
      server.stop(true);
    }
  });

  test("round-trip: UI send → bridge AND bridge /api/reply → UI SSE, end to end", async () => {
    const { server, base, registry } = buildServer([{ name: "dev" }]);
    try {
      const bridge = await openSse(base, "/events?channel=dev");
      const ui = await openSse(base, "/ui/events?channel=dev");
      const start = Date.now();
      while (registry.size < 1 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // UI → bridge (authed — Layer 2).
      await fetch(`${base}/api/channels/dev/send`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ text: "wake up" }),
      });
      const bridgeFrame = await bridge.read();
      expect(bridgeFrame).toContain("wake up");

      // bridge → UI (the session replied via the reply tool).
      const replyRes = await fetch(`${base}/api/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "dev", text: "I am awake" }),
      });
      expect((await replyRes.json()).sent).toHaveLength(1);

      const uiFrame = await ui.read();
      expect(uiFrame).toContain("event: reply");
      expect(uiFrame).toContain("I am awake");

      bridge.cancel();
      ui.cancel();
    } finally {
      server.stop(true);
    }
  });

  test("channel isolation: a send on A reaches A's bridge but NOT a UI client on B", async () => {
    const { server, base } = buildServer([{ name: "A" }, { name: "B" }]);
    try {
      const bridgeA = await openSse(base, "/events?channel=A");
      const uiB = await openSse(base, "/ui/events?channel=B");

      // Send on channel A, then reply on A (authed — Layer 2).
      await fetch(`${base}/api/channels/A/send`, {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ text: "for-A" }),
      });
      // Close the loop: A's bridge MUST receive the inbound (not just "B didn't").
      const bridgeFrame = await bridgeA.read();
      expect(bridgeFrame).toContain("for-A");

      await fetch(`${base}/api/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "A", text: "reply-to-A" }),
      });

      // Now reply on B so B's stream definitely has a frame, and assert it's B's
      // only — none of A's traffic leaked across.
      await fetch(`${base}/api/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "B", text: "reply-to-B" }),
      });

      const frame = await uiB.read();
      expect(frame).toContain("reply-to-B");
      expect(frame).not.toContain("reply-to-A");
      expect(frame).not.toContain("for-A");
      bridgeA.cancel();
      uiB.cancel();
    } finally {
      server.stop(true);
    }
  });
});
