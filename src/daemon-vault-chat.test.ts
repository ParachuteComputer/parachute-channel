/**
 * Vault-backed chat — daemon route tests for the read/send the built-in chat uses
 * against a VAULT-transport channel (Phase 4).
 *
 *   - GET  /api/channels/<ch>/messages  (gate channel:read) →
 *       vault   → loadTranscript() → { messages }
 *       http-ui → { messages: [] }  (ephemeral transport, no durable store)
 *       unknown → 404
 *   - POST /api/channels/<ch>/send      (gate channel:send) →
 *       vault   → writeInbound(text, "operator") → { ok, id }   (the WAKE path)
 *
 * Auth: the same sentinel-token `mock.module("./hub-jwt.ts")` harness the other
 * daemon tests use — a `Bearer test-rw-token` validates with channel:read + send
 * WITHOUT a live hub/JWKS; the no-token path still hits the real 401 short-circuit.
 *
 * The vault I/O is exercised through a REAL `VaultTransport` instance (the daemon
 * branches on `instanceof VaultTransport`) whose `loadTranscript` / `writeInbound`
 * are MONKEYPATCHED on the instance — so we assert the daemon's dispatch + shaping
 * without writing to (or reading from) any real vault. NO live vault, NO uni-* writes.
 */
import { describe, test, expect, mock } from "bun:test";

const RW_TOKEN = "test-rw-token"; // channel:read + channel:send
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === RW_TOKEN) return { ...base, scopes: ["channel:read", "channel:send"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import { VaultTransport, type ChannelMessage } from "./transports/vault.ts";
import type { Channel } from "./registry.ts";

/** A VaultTransport whose vault I/O is stubbed on the instance (instanceof holds). */
function stubVault(opts: {
  transcript?: ChannelMessage[];
  loadThrows?: Error;
  onWrite?: (text: string, sender?: string) => void;
  writeThrows?: Error;
  writeId?: string;
}): VaultTransport {
  const t = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:1940", token: "x" });
  // Bind ctx without firing the real ensureSchema network call.
  (t as unknown as { ctx: { channel: string } }).ctx = { channel: "eng" };
  t.loadTranscript = async () => {
    if (opts.loadThrows) throw opts.loadThrows;
    return opts.transcript ?? [];
  };
  t.writeInbound = async (text: string, sender?: string) => {
    if (opts.writeThrows) throw opts.writeThrows;
    opts.onWrite?.(text, sender);
    return { id: opts.writeId ?? "written-note-1" };
  };
  return t;
}

function serverWith(channels: Map<string, Channel>) {
  const registry = new ClientRegistry();
  const srv = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch: createFetchHandler(channels, registry),
  });
  return { srv, base: `http://127.0.0.1:${srv.port}` };
}

const auth = { authorization: `Bearer ${RW_TOKEN}` };

describe("GET /api/channels/<ch>/messages", () => {
  test("vault channel → { messages } from loadTranscript()", async () => {
    const transcript: ChannelMessage[] = [
      { id: "n-in", text: "hi", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:01Z" },
      { id: "n-out", text: "hello", direction: "outbound", sender: "session", ts: "2026-06-08T00:00:02Z" },
    ];
    const t = stubVault({ transcript });
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/messages`, { headers: auth });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: ChannelMessage[] };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]!.id).toBe("n-in");
      expect(body.messages[0]!.direction).toBe("inbound");
      expect(body.messages[1]!.direction).toBe("outbound");
    } finally {
      srv.stop(true);
    }
  });

  test("http-ui channel → { messages: [] } (no durable transcript)", async () => {
    const transport = new HttpUiTransport({ channel: "ui1" });
    await transport.start({ channel: "ui1", emit: () => {}, emitPermissionVerdict: () => {} });
    const channels = new Map<string, Channel>([
      ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/ui1/messages`, { headers: auth });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ messages: [] });
    } finally {
      srv.stop(true);
    }
  });

  test("unknown channel → 404", async () => {
    const channels = new Map<string, Channel>();
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/nope/messages`, { headers: auth });
      expect(res.status).toBe(404);
    } finally {
      srv.stop(true);
    }
  });

  test("no token → 401 (gate present), does not call the transport", async () => {
    let loaded = false;
    const t = stubVault({ transcript: [] });
    t.loadTranscript = async () => { loaded = true; return []; };
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/messages`);
      expect(res.status).toBe(401);
      expect(loaded).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("a vault read failure → 502 (chat shows an error, not a silent empty)", async () => {
    const t = stubVault({ loadThrows: new Error("vault transport: load transcript failed (502)") });
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/messages`, { headers: auth });
      expect(res.status).toBe(502);
    } finally {
      srv.stop(true);
    }
  });
});

describe("POST /api/channels/<ch>/send — vault path (writeInbound = the wake)", () => {
  test("vault channel → writeInbound(text, 'operator') → { ok, id }", async () => {
    let wrote: { text: string; sender?: string } | undefined;
    const t = stubVault({ onWrite: (text, sender) => { wrote = { text, sender }; }, writeId: "inbound-99" });
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/send`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "wake up" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: "inbound-99" });
      expect(wrote).toEqual({ text: "wake up", sender: "operator" });
    } finally {
      srv.stop(true);
    }
  });

  test("vault send with no token → 401, does not write", async () => {
    let wrote = false;
    const t = stubVault({ onWrite: () => { wrote = true; } });
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "wake up" }),
      });
      expect(res.status).toBe(401);
      expect(wrote).toBe(false);
    } finally {
      srv.stop(true);
    }
  });

  test("vault send with empty text → 400", async () => {
    const t = stubVault({});
    const channels = new Map<string, Channel>([
      ["eng", { name: "eng", transport: t, entry: { name: "eng", transport: "vault" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/eng/send`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      });
      expect(res.status).toBe(400);
    } finally {
      srv.stop(true);
    }
  });

  test("http-ui send is NOT intercepted by the vault path — its own ingestHttp handles it", async () => {
    const emitted: string[] = [];
    const transport = new HttpUiTransport({ channel: "ui1" });
    await transport.start({
      channel: "ui1",
      emit: (m) => emitted.push(m.content),
      emitPermissionVerdict: () => {},
    });
    const channels = new Map<string, Channel>([
      ["ui1", { name: "ui1", transport, entry: { name: "ui1", transport: "http-ui" } }],
    ]);
    const { srv, base } = serverWith(channels);
    try {
      const res = await fetch(`${base}/api/channels/ui1/send`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ text: "hi http-ui" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // http-ui's ingestHttp emit'd it (vault path returns { ok, id }, not { ok }).
      expect(emitted).toEqual(["hi http-ui"]);
    } finally {
      srv.stop(true);
    }
  });
});
