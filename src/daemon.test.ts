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
import { VaultTransport } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";
import type { TransportContext, InboundMessage } from "./transport.ts";

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
// OAuth discovery for the HTTP MCP surface (RFC 9728 + RFC 8414). These are the
// endpoints a Claude Code HTTP-MCP client probes when adding the channel by URL.
// Path-insertion form (`.well-known` ABOVE the resource path), mirroring vault.
// PUBLIC — no token needed (they must be reachable before the client has one).
// ---------------------------------------------------------------------------
describe("OAuth discovery (RFC 9728 / RFC 8414) — public, points at the hub", () => {
  // The hub origin the daemon advertises as the authorization server. Set on the
  // module's getHubOrigin via PARACHUTE_HUB_ORIGIN; default loopback otherwise.
  const HUB = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "") || "http://127.0.0.1:1939";

  test("GET /.well-known/oauth-protected-resource/mcp/ui1 → 200, names hub + channel scopes", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/ui1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    expect(body.authorization_servers).toEqual([HUB]);
    expect(body.scopes_supported).toEqual(["channel:read", "channel:write"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
    // No forwarded host → loopback resource URL at /mcp/<channel> (no /channel prefix).
    expect(body.resource).toBe(`${base}/mcp/ui1`);
  });

  test("X-Forwarded-Host builds the PUBLIC resource URL (with /channel mount prefix)", async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp/ui1`, {
      headers: { "x-forwarded-host": "parachute.taildf9ce2.ts.net", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe("https://parachute.taildf9ce2.ts.net/channel/mcp/ui1");
  });

  test("GET /.well-known/oauth-authorization-server/mcp/ui1 → 200, forwards every endpoint to the hub", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server/mcp/ui1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      jwks_uri: string;
      scopes_supported: string[];
    };
    expect(body.issuer).toBe(HUB);
    expect(body.authorization_endpoint).toBe(`${HUB}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${HUB}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${HUB}/oauth/register`);
    expect(body.jwks_uri).toBe(`${HUB}/.well-known/jwks.json`);
    expect(body.scopes_supported).toEqual(["channel:read", "channel:write"]);
  });
});

// ---------------------------------------------------------------------------
// RFC 9728 WWW-Authenticate challenge on the /mcp/<channel> 401. A plain 401
// gives a spec OAuth client no way to find the authorization server; the header
// names the protected-resource metadata document so the client can discover
// OAuth and start the flow. Only the /mcp path carries it (it's the one that
// drives a spec client); /events + /api/* stay plain 401.
// ---------------------------------------------------------------------------
describe("MCP 401 carries the WWW-Authenticate challenge (RFC 9728)", () => {
  test("POST /mcp/ui1 with no bearer → 401 + WWW-Authenticate naming the PRM URL", async () => {
    const res = await fetch(`${base}/mcp/ui1`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const header = res.headers.get("WWW-Authenticate");
    expect(header).toBe(
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/ui1"`,
    );
    // And the URL the header names is a route the daemon actually serves.
    const prmUrl = header!.match(/resource_metadata="([^"]+)"/)![1]!;
    const prm = await fetch(prmUrl);
    expect(prm.status).toBe(200);
  });

  test("behind the hub (x-forwarded-host) the challenge names the PUBLIC PRM URL", async () => {
    const res = await fetch(`${base}/mcp/ui1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": "parachute.taildf9ce2.ts.net",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://parachute.taildf9ce2.ts.net/channel/.well-known/oauth-protected-resource/mcp/ui1"',
    );
  });

  test("the other bridge endpoints stay plain 401 (no challenge)", async () => {
    const events = await fetch(`${base}/events?channel=ui1`);
    expect(events.status).toBe(401);
    expect(events.headers.get("WWW-Authenticate")).toBeNull();
    const reply = await fetch(`${base}/api/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "ui1", text: "hi" }),
    });
    expect(reply.status).toBe(401);
    expect(reply.headers.get("WWW-Authenticate")).toBeNull();
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

// ---------------------------------------------------------------------------
// Vault inbound webhook: POST /api/vault/inbound. A vault trigger POSTs here on
// a new inbound #channel-message note; the daemon validates the per-channel
// shared secret, resolves the channel from note.metadata.channel, and hands the
// note to the channel's VaultTransport.ingestInbound (which emits → wakes the
// session). Secret auth, unknown-channel 404, idempotency by note id.
// ---------------------------------------------------------------------------
describe("Vault inbound webhook — POST /api/vault/inbound", () => {
  const SECRET = "s3cret";

  /** Build a daemon over one vault channel + a fake transport ctx recording emits. */
  function buildVaultServer() {
    const registry = new ClientRegistry();
    const transport = new VaultTransport({
      vault: "default",
      vaultUrl: "http://127.0.0.1:1940",
      token: "x",
      webhookSecret: SECRET,
    });
    const emitted: InboundMessage[] = [];
    const ctx: TransportContext = {
      channel: "eng",
      emit(msg) {
        emitted.push(msg);
      },
      emitPermissionVerdict() {},
    };
    void transport.start(ctx);
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport, entry: { name: "eng", transport: "vault" } }],
    ]);
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: createFetchHandler(channels, registry),
    });
    return { srv, base: `http://127.0.0.1:${srv.port}`, emitted };
  }

  function body(noteId: string, extraMeta: Record<string, unknown> = {}) {
    return JSON.stringify({
      trigger: "channel-inbound",
      event: "created",
      note: {
        id: noteId,
        path: `channel/eng/${noteId}`,
        content: "wake up session",
        tags: ["#channel-message"],
        metadata: { channel: "eng", direction: "inbound", sender: "aaron", ...extraMeta },
      },
    });
  }

  test("wrong secret → 401, no emit", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=wrong`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("n1"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("missing secret → 401", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("n1"),
      });
      expect(res.status).toBe(401);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("unknown channel → 404, no emit", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          note: { id: "n1", content: "x", metadata: { channel: "nope", direction: "inbound" } },
        }),
      });
      expect(res.status).toBe(404);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });

  test("missing note.metadata.channel → 400", async () => {
    const { srv, base } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: { id: "n1", content: "x", metadata: {} } }),
      });
      expect(res.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });

  test("valid (query secret) → 200 + routes to the channel's transport + emits", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("n-ok"),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.channel).toBe("eng");
      expect(emitted[0]!.content).toBe("wake up session");
      expect(emitted[0]!.meta.note_id).toBe("n-ok");
      expect(emitted[0]!.meta.source).toBe("vault");
    } finally {
      srv.stop(true);
    }
  });

  test("valid via X-Channel-Webhook-Secret header → 200 + emits", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-channel-webhook-secret": SECRET },
        body: body("n-hdr"),
      });
      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
    } finally {
      srv.stop(true);
    }
  });

  test("duplicate note id → no double-emit (idempotency)", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${base}/api/vault/inbound?secret=${SECRET}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body("dup-1"),
        });
        expect(res.status).toBe(200); // both ack
      }
      expect(emitted).toHaveLength(1); // but only one wake
    } finally {
      srv.stop(true);
    }
  });

  test("outbound-marked note is ack'd 200 but NOT emitted (belt-and-suspenders)", async () => {
    const { srv, base, emitted } = buildVaultServer();
    try {
      const res = await fetch(`${base}/api/vault/inbound?secret=${SECRET}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body("ob-1", { direction: "outbound", outbound: "1" }),
      });
      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(0);
    } finally {
      srv.stop(true);
    }
  });
});
