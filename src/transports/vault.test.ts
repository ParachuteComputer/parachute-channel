/**
 * Tier 1 unit tests for the vault transport.
 *
 * These exercise the transport WITHOUT a live vault — `fetch` is stubbed to
 * capture the outbound note write, and `ctx.emit` is recorded to assert inbound
 * delivery. They cover:
 *   - reply(): writes the right POST .../api/notes tagged BOTH the queryable parent
 *     `#channel-message` AND the directional child `#channel-message/outbound` (no
 *     `outbound` metadata key), with direction, channel, Bearer token; returns the id;
 *   - reply(): threads in_reply_to when the bridge passes it;
 *   - ingestInbound(): emits the inbound content + meta onto its channel;
 *   - ingestInbound(): IGNORES a `#channel-message/outbound`-tagged note (loop avoidance);
 *   - registry: a vault channel instantiates from config.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { VaultTransport, CHANNEL_VAULT_TAG_SCHEMA } from "./vault.ts";
import type { TransportContext, InboundMessage } from "../transport.ts";
import { instantiateTransport } from "../registry.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A test context that records emitted inbound messages. */
function fakeCtx(channel: string): TransportContext & { emitted: InboundMessage[] } {
  const emitted: InboundMessage[] = [];
  return {
    channel,
    emitted,
    emit(msg) {
      emitted.push(msg);
    },
    emitPermissionVerdict() {},
  };
}

function baseConfig() {
  return {
    vault: "default",
    vaultUrl: "http://127.0.0.1:1940",
    token: "write-token-xyz",
    webhookSecret: "s3cret",
  };
}

describe("VaultTransport — reply (outbound note write)", () => {
  test("reply() POSTs .../api/notes tagged #channel-message/outbound + direction + channel + Bearer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "note-created-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const result = await t.reply({ channel: "eng", text: "the reply text" });

    expect(result.sent).toEqual(["note-created-1"]);
    // start() also fires ensureSchema() (PUT .../api/tags/*); isolate the note POST.
    const noteCalls = calls.filter((c) => c.url.endsWith("/api/notes"));
    expect(noteCalls).toHaveLength(1);
    const call = noteCalls[0]!;
    expect(call.url).toBe("http://127.0.0.1:1940/vault/default/api/notes");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer write-token-xyz");

    const sent = JSON.parse(String(call.init.body)) as {
      content: string;
      path: string;
      tags: string[];
      metadata: Record<string, string>;
    };
    expect(sent.content).toBe("the reply text");
    // Two orthogonal tags: the parent `#channel-message` is carried LITERALLY so
    // the note is queryable under it (a slash is namespace, NOT query inheritance —
    // a child-only-tagged note is invisible to a `tag:#channel-message` query), and
    // the directional child `#channel-message/outbound` is the trigger discriminator.
    expect(sent.tags).toEqual(["#channel-message", "#channel-message/outbound"]);
    // Regression guard: the queryable parent tag MUST be present literally.
    expect(sent.tags).toContain("#channel-message");
    expect(sent.tags).toContain("#channel-message/outbound");
    expect(sent.path.startsWith("channel/eng/")).toBe(true);
    expect(sent.metadata.channel).toBe("eng");
    expect(sent.metadata.direction).toBe("outbound");
    expect(sent.metadata.sender).toBe("session");
    // The old `outbound:"1"` presence marker is gone — no such metadata key.
    expect("outbound" in sent.metadata).toBe(false);
    expect(typeof sent.metadata.ts).toBe("string");
  });

  test("reply() threads in_reply_to from args.meta", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      // Ignore the ensureSchema PUTs fired by start(); only the note POST carries metadata.
      if (String(url).endsWith("/api/notes")) {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string> };
        captured = body.metadata;
      }
      return new Response(JSON.stringify({ id: "n2" }), { status: 201 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.reply({ channel: "eng", text: "re", meta: { in_reply_to: "inbound-99" } });
    expect(captured!.in_reply_to).toBe("inbound-99");
  });

  test("reply() falls back to the proposed id when the response has no id", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 201 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const result = await t.reply({ channel: "eng", text: "x" });
    expect(result.sent).toHaveLength(1);
    expect(typeof result.sent[0]).toBe("string");
  });

  test("reply() throws on a non-ok vault response", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(t.reply({ channel: "eng", text: "x" })).rejects.toThrow(/write reply failed/);
  });
});

describe("VaultTransport — ingestInbound", () => {
  test("emits the inbound content + meta onto its channel", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    // start synchronously enough for the test (start just stores ctx).
    void t.start(ctx);
    t.ingestInbound({
      id: "note-in-1",
      content: "hello session",
      tags: ["#channel-message", "#channel-message/inbound"],
      metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:00Z" },
    });
    expect(ctx.emitted).toHaveLength(1);
    const m = ctx.emitted[0]!;
    expect(m.channel).toBe("eng");
    expect(m.content).toBe("hello session");
    expect(m.source).toBe("vault");
    expect(m.meta.source).toBe("vault");
    expect(m.meta.note_id).toBe("note-in-1");
    expect(m.meta.sender).toBe("aaron");
    expect(m.meta.direction).toBe("inbound");
  });

  test("IGNORES a #channel-message/outbound-tagged note (loop avoidance)", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    t.ingestInbound({
      id: "our-own-reply",
      content: "I am awake",
      tags: ["#channel-message", "#channel-message/outbound"],
      metadata: { channel: "eng", direction: "outbound", sender: "session" },
    });
    expect(ctx.emitted).toHaveLength(0);
  });

  test("IGNORES a note with direction:outbound even if the outbound tag is absent", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    t.ingestInbound({
      id: "x",
      content: "y",
      metadata: { channel: "eng", direction: "outbound" },
    });
    expect(ctx.emitted).toHaveLength(0);
  });
});

describe("VaultTransport — ensureSchema (tag-schema declaration on connect)", () => {
  /** Drain microtasks so a fire-and-forget `void this.ensureSchema()` from
   *  start() has issued its fetches before we assert. */
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  test("PUTs each CHANNEL_VAULT_TAG_SCHEMA entry with the right URL encoding, Bearer, and body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(calls).toHaveLength(CHANNEL_VAULT_TAG_SCHEMA.length);

    // Parent — no parent_names, just a description. Plain `#` → `%23`.
    const parent = calls[0]!;
    expect(parent.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23channel-message",
    );
    expect(parent.init.method).toBe("PUT");
    expect((parent.init.headers as Record<string, string>).authorization).toBe(
      "Bearer write-token-xyz",
    );
    const parentBody = JSON.parse(String(parent.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(parentBody.description).toBe(
      "A message in a Parachute channel (parent of /inbound + /outbound).",
    );
    expect("parent_names" in parentBody).toBe(false);

    // Inbound child — name carries BOTH `#` and `/`. The vault route matches a
    // single path segment (`[^/]+`) then decodeURIComponent's it, so the `/` MUST
    // be encoded as `%2F` (a bare slash would fail the single-segment match → 404).
    const inbound = calls[1]!;
    expect(inbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23channel-message%2Finbound",
    );
    // Confirm the encoding decodes back to the literal tag name the vault stores.
    const encodedSegment = inbound.url.split("/api/tags/")[1]!;
    expect(decodeURIComponent(encodedSegment)).toBe("#channel-message/inbound");
    const inboundBody = JSON.parse(String(inbound.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(inboundBody.parent_names).toEqual(["#channel-message"]);
    expect(inboundBody.description).toBe(
      "Human→session message; the vault trigger fires on this.",
    );

    // Outbound child — same encoding, parent declared.
    const outbound = calls[2]!;
    expect(outbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23channel-message%2Foutbound",
    );
    expect(decodeURIComponent(outbound.url.split("/api/tags/")[1]!)).toBe(
      "#channel-message/outbound",
    );
    const outboundBody = JSON.parse(String(outbound.init.body)) as { parent_names?: string[] };
    expect(outboundBody.parent_names).toEqual(["#channel-message"]);
  });

  test("schema is sourced from CHANNEL_VAULT_TAG_SCHEMA — declares exactly its entries", async () => {
    const declared: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      declared.push(decodeURIComponent(String(url).split("/api/tags/")[1]!));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(declared).toEqual(CHANNEL_VAULT_TAG_SCHEMA.map((e) => e.name));
  });

  test("best-effort: a rejecting fetch does NOT throw out of ensureSchema", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const t = new VaultTransport(baseConfig());
    // Must resolve, not reject.
    await expect(t.ensureSchema()).resolves.toBeUndefined();
  });

  test("best-effort: a 500 response does NOT throw out of ensureSchema", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await expect(t.ensureSchema()).resolves.toBeUndefined();
  });

  test("start() stays non-fatal + the transport still works when schema-ensure fails", async () => {
    // A fetch that fails the PUT (schema) but the test asserts start() resolves
    // and ingestInbound still emits — the transport is fully functional regardless.
    globalThis.fetch = (async () => {
      throw new Error("vault unreachable");
    }) as unknown as typeof fetch;

    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    await expect(t.start(ctx)).resolves.toBeUndefined();
    await flush(); // let the fire-and-forget ensureSchema settle (it must not reject globally)

    // Transport still delivers inbound after a failed schema declaration.
    t.ingestInbound({
      id: "n1",
      content: "still works",
      tags: ["#channel-message", "#channel-message/inbound"],
      metadata: { channel: "eng", direction: "inbound", sender: "aaron" },
    });
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.content).toBe("still works");
  });
});

describe("registry — vault", () => {
  test("a vault channel instantiates from config", () => {
    const transport = instantiateTransport({
      name: "eng",
      transport: "vault",
      config: baseConfig(),
    });
    expect(transport.kind).toBe("vault");
    expect(transport).toBeInstanceOf(VaultTransport);
  });

  test("a vault channel without a token throws", () => {
    expect(() =>
      instantiateTransport({
        name: "eng",
        transport: "vault",
        config: { vault: "default", webhookSecret: "s" },
      }),
    ).toThrow(/token/);
  });
});
