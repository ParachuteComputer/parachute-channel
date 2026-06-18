/**
 * Tier 1 unit tests for the vault transport.
 *
 * These exercise the transport WITHOUT a live vault — `fetch` is stubbed to
 * capture the outbound note write, and `ctx.emit` is recorded to assert inbound
 * delivery. They cover:
 *   - reply(): writes the right POST .../api/notes tagged BOTH the queryable parent
 *     `#agent/message` AND the directional child `#agent/message/outbound` (no
 *     `outbound` metadata key), with direction, channel, Bearer token; returns the id;
 *   - reply(): threads in_reply_to when the bridge passes it;
 *   - loadTranscript(): DUAL-READS — a note tagged only the LEGACY `#channel-message`
 *     (or the interim `#agent-message`) still appears (the impl unions a
 *     `#agent/message`, an `#agent-message`, and a `#channel-message` query by note id);
 *   - ingestInbound(): emits the inbound content + meta onto its channel;
 *   - ingestInbound(): IGNORES a `#agent/message/outbound`-tagged note AND a LEGACY
 *     `#channel-message/outbound`-tagged note (loop avoidance, dual-read);
 *   - schema: `AGENT_VAULT_TAG_SCHEMA` declares the `#agent/*` namespace rollup PLUS
 *     the interim + legacy tag families so pre-namespace history keeps its inheritance;
 *   - registry: a vault channel instantiates from config.
 *
 * TAG NAMESPACE — `#agent/*` (design 2026-06-17-vault-native-agents). WRITE
 * assertions expect the NEW `#agent/message*` tags; READ assertions ALSO exercise
 * the interim `#agent-message*` and legacy `#channel-message*` families (dual-read).
 * The `metadata.channel` routing key, the channel-name slugs, `?channel=`, the
 * `Channel*` types, and the `channel/<name>/` note path prefix are DOMAIN — unchanged.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { VaultTransport, AGENT_VAULT_TAG_SCHEMA } from "./vault.ts";
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
  test("reply() POSTs .../api/notes tagged #agent/message + #agent/message/outbound + direction + channel + Bearer", async () => {
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
    // Two orthogonal tags: the parent `#agent/message` is carried LITERALLY so
    // the note is queryable under it (a slash is namespace, NOT query inheritance —
    // a child-only-tagged note is invisible to a `tag:#agent/message` query), and
    // the directional child `#agent/message/outbound` is the trigger discriminator.
    // We WRITE only the NEW namespaced tags; dual-read recognizes the interim +
    // legacy families on READ.
    expect(sent.tags).toEqual(["#agent/message", "#agent/message/outbound"]);
    // Regression guard: the queryable parent tag MUST be present literally.
    expect(sent.tags).toContain("#agent/message");
    expect(sent.tags).toContain("#agent/message/outbound");
    // Loop-avoidance / write-discipline: we NEVER write the interim/legacy tags going forward.
    expect(sent.tags).not.toContain("#agent-message");
    expect(sent.tags).not.toContain("#agent-message/outbound");
    expect(sent.tags).not.toContain("#channel-message");
    expect(sent.tags).not.toContain("#channel-message/outbound");
    // The note PATH prefix is DOMAIN (`channel/<name>/`) — unchanged by the rename.
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

describe("VaultTransport — loadTranscript (read the durable store)", () => {
  test("queries by tag only (NO operator metadata filter), filters this channel client-side, sorts ascending by ts", async () => {
    const getUrls: string[] = [];
    let capturedAuth = "";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      // Ignore the ensureSchema PUTs fired by start(); only the GET /api/notes is the transcript read.
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        getUrls.push(u);
        capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
        // The dual-read fires THREE queries (#agent/message + interim
        // #agent-message + legacy #channel-message). Serve the NEW-tagged notes on
        // the #agent/message query; an empty array on the interim + legacy queries
        // (those dual-read paths have their own dedicated tests).
        if (u.includes("tag=%23agent%2Fmessage")) {
          // Return notes OUT of ts order (prove the ascending sort) + a note from a
          // DIFFERENT channel (prove the client-side channel filter excludes it).
          return new Response(
            JSON.stringify([
              {
                id: "n-out",
                content: "session reply",
                tags: ["#agent/message", "#agent/message/outbound"],
                metadata: { channel: "eng", direction: "outbound", sender: "session", ts: "2026-06-08T00:00:02Z", in_reply_to: "n-in" },
              },
              {
                id: "n-other",
                content: "different channel — must be excluded",
                tags: ["#agent/message", "#agent/message/inbound"],
                metadata: { channel: "other", direction: "inbound", sender: "x", ts: "2026-06-08T00:00:03Z" },
              },
              {
                id: "n-in",
                content: "hi session",
                tags: ["#agent/message", "#agent/message/inbound"],
                metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:01Z" },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        // interim #agent-message + legacy #channel-message queries → nothing here.
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      // ensureSchema PUTs
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript();

    // DUAL-READ: the new + interim + legacy parent tags are queried (unioned by id).
    // Each query carries the encoded parent tag + include_content, and DELIBERATELY
    // no `metadata=` operator filter (the channel field isn't indexed on a bare
    // vault; we filter client-side). Overfetches the tag so other channels don't
    // crowd us out.
    const agentGet = getUrls.find((u) => u.includes("tag=%23agent%2Fmessage"));
    const interimGet = getUrls.find((u) => u.includes("tag=%23agent-message"));
    const legacyGet = getUrls.find((u) => u.includes("tag=%23channel-message"));
    expect(agentGet).toBeDefined();
    expect(interimGet).toBeDefined(); // proves the interim flat tag is also queried (dual-read)
    expect(legacyGet).toBeDefined(); // proves the legacy tag is also queried (dual-read)
    expect(agentGet!.startsWith("http://127.0.0.1:1940/vault/default/api/notes?")).toBe(true);
    expect(agentGet!).toContain("include_content=true");
    expect(agentGet!).not.toContain("metadata=");
    expect(capturedAuth).toBe("Bearer write-token-xyz");

    // The "other" channel note is filtered OUT; the two "eng" notes remain, sorted
    // ascending by ts (n-in before n-out).
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.id).toBe("n-in");
    expect(msgs[0]!.direction).toBe("inbound");
    expect(msgs[0]!.text).toBe("hi session");
    expect(msgs[0]!.sender).toBe("aaron");
    expect(msgs[1]!.id).toBe("n-out");
    expect(msgs[1]!.direction).toBe("outbound");
    expect(msgs[1]!.inReplyTo).toBe("n-in");
  });

  test("DUAL-READ: a note tagged ONLY the LEGACY #channel-message still appears in the transcript", async () => {
    // The dual-read proof (rule 2). The impl issues TWO tag queries — one for the
    // NEW `#agent/message`, one for the legacy `#channel-message` — and unions the
    // results by note id. A pre-rename note carrying ONLY the legacy tags (and the
    // matching `metadata.channel`) must STILL load, so existing history survives the
    // rename until the one-time re-tag run lands.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        if (u.includes("tag=%23agent%2Fmessage")) {
          // A NEW-tagged note (post-rename) on this channel.
          return new Response(
            JSON.stringify([
              {
                id: "n-new",
                content: "post-rename message",
                tags: ["#agent/message", "#agent/message/inbound"],
                metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:02Z" },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (u.includes("tag=%23channel-message")) {
          // A LEGACY-only note (pre-rename) — carries ONLY the old tag family.
          return new Response(
            JSON.stringify([
              {
                id: "n-legacy",
                content: "pre-rename message",
                tags: ["#channel-message", "#channel-message/inbound"],
                metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:01Z" },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript();

    // Union of both queries: the legacy-only note is present alongside the new one,
    // sorted ascending by ts (legacy ts is earlier → first).
    expect(msgs.map((m) => m.id)).toEqual(["n-legacy", "n-new"]);
    const legacy = msgs.find((m) => m.id === "n-legacy")!;
    expect(legacy.text).toBe("pre-rename message");
    expect(legacy.direction).toBe("inbound");
  });

  test("DUAL-READ: a note carried by BOTH queries (re-tagged) is NOT duplicated (union by id)", async () => {
    // A note re-tagged to carry both families appears on each query; the union
    // dedups by note id so it shows exactly once.
    const dual = {
      id: "n-both",
      content: "re-tagged message",
      tags: ["#agent/message", "#channel-message", "#agent/message/inbound", "#channel-message/inbound"],
      metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:01Z" },
    };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        // Both queries return the same note.
        return new Response(JSON.stringify([dual]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.id).toBe("n-both");
  });

  test("caps the returned transcript to the requested limit (most-recent by ts)", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        // Only the #agent/message query returns notes; the legacy query is empty
        // (so the union doesn't double-count by id under dual-read).
        if (u.includes("tag=%23agent%2Fmessage")) {
          return new Response(
            JSON.stringify([1, 2, 3, 4].map((i) => ({
              id: "n" + i,
              content: "m" + i,
              tags: ["#agent/message", "#agent/message/inbound"],
              metadata: { channel: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:0" + i + "Z" },
            }))),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript({ limit: 2 });
    // 4 notes fetched → the 2 most recent (by ts) returned, ascending.
    expect(msgs.map((m) => m.id)).toEqual(["n3", "n4"]);
  });

  test("falls back to the child tag for direction when metadata.direction is absent (new + legacy outbound tags)", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        if (u.includes("tag=%23agent%2Fmessage")) {
          return new Response(
            JSON.stringify([
              // NEW outbound child → direction inferred "outbound".
              { id: "a", content: "x", tags: ["#agent/message", "#agent/message/outbound"], metadata: { channel: "eng", ts: "2026-06-08T00:00:01Z" } },
              // No direction signal at all → defaults to "inbound".
              { id: "b", content: "y", tags: ["#agent/message", "#agent/message/inbound"], metadata: { channel: "eng", ts: "2026-06-08T00:00:02Z" } },
            ]),
            { status: 200 },
          );
        }
        if (u.includes("tag=%23channel-message")) {
          // LEGACY outbound child → dual-read recognizes it too → "outbound".
          return new Response(
            JSON.stringify([
              { id: "c", content: "z", tags: ["#channel-message", "#channel-message/outbound"], metadata: { channel: "eng", ts: "2026-06-08T00:00:03Z" } },
            ]),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript();
    expect(msgs.find((m) => m.id === "a")!.direction).toBe("outbound");
    expect(msgs.find((m) => m.id === "b")!.direction).toBe("inbound");
    // Dual-read: the legacy outbound child tag is recognized for direction too.
    expect(msgs.find((m) => m.id === "c")!.direction).toBe("outbound");
  });

  test("throws a clear error on a non-ok vault response", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        return new Response("nope", { status: 502 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(t.loadTranscript()).rejects.toThrow(/load transcript failed/);
  });
});

describe("VaultTransport — writeInbound (the chat's send → wakes the session)", () => {
  test("POSTs an INBOUND note tagged [#agent/message, #agent/message/inbound] with direction + channel + sender + Bearer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "inbound-note-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const result = await t.writeInbound("wake up", "operator");

    expect(result.id).toBe("inbound-note-1");
    const noteCalls = calls.filter((c) => c.url.endsWith("/api/notes") && c.init.method === "POST");
    expect(noteCalls).toHaveLength(1);
    const call = noteCalls[0]!;
    expect(call.url).toBe("http://127.0.0.1:1940/vault/default/api/notes");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer write-token-xyz");

    const sent = JSON.parse(String(call.init.body)) as {
      content: string;
      path: string;
      tags: string[];
      metadata: Record<string, string>;
    };
    expect(sent.content).toBe("wake up");
    // The INBOUND tag pair — the child is the trigger discriminator that wakes the session.
    expect(sent.tags).toEqual(["#agent/message", "#agent/message/inbound"]);
    expect(sent.tags).toContain("#agent/message");
    expect(sent.tags).toContain("#agent/message/inbound");
    // It must NOT carry the outbound tag (that would be a reply, never wake).
    expect(sent.tags).not.toContain("#agent/message/outbound");
    // Write-discipline: never write the legacy tag family going forward.
    expect(sent.tags).not.toContain("#channel-message");
    expect(sent.metadata.channel).toBe("eng");
    expect(sent.metadata.direction).toBe("inbound");
    expect(sent.metadata.sender).toBe("operator");
    expect(typeof sent.metadata.ts).toBe("string");
    // Note PATH prefix is DOMAIN (`channel/<name>/`) — unchanged.
    expect(sent.path.startsWith("channel/eng/")).toBe(true);
  });

  test("defaults sender to 'operator' when omitted", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes") && init?.method === "POST") {
        captured = (JSON.parse(String(init?.body)) as { metadata: Record<string, string> }).metadata;
      }
      return new Response(JSON.stringify({ id: "n" }), { status: 201 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.writeInbound("hi");
    expect(captured!.sender).toBe("operator");
  });

  test("does NOT emit (no double-wake) — the trigger is the single wake path", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "n" }), { status: 201 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    await t.start(ctx);
    await t.writeInbound("hi");
    // writeInbound must never ctx.emit — the vault trigger wakes the session.
    expect(ctx.emitted).toHaveLength(0);
  });

  test("throws a clear error on a non-ok vault response", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(t.writeInbound("x")).rejects.toThrow(/write inbound failed/);
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
      tags: ["#agent/message", "#agent/message/inbound"],
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

  test("IGNORES a #agent/message/outbound-tagged note (loop avoidance)", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    t.ingestInbound({
      id: "our-own-reply",
      content: "I am awake",
      tags: ["#agent/message", "#agent/message/outbound"],
      metadata: { channel: "eng", direction: "outbound", sender: "session" },
    });
    expect(ctx.emitted).toHaveLength(0);
  });

  test("DUAL-READ loop avoidance: IGNORES a LEGACY #channel-message/outbound-tagged note", () => {
    // Belt-and-suspenders dual-read (rule 2): even a pre-rename reply note —
    // carrying only the legacy outbound child tag, and WITHOUT a direction
    // metadata field — must be dropped, so a still-live legacy trigger that
    // mis-delivers our own old reply can never wake the session on it.
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    t.ingestInbound({
      id: "our-own-legacy-reply",
      content: "I am awake (legacy)",
      tags: ["#channel-message", "#channel-message/outbound"],
      // No direction field — the drop must come from the legacy outbound TAG alone.
      metadata: { channel: "eng", sender: "session" },
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

  test("PUTs each AGENT_VAULT_TAG_SCHEMA entry with the right URL encoding, Bearer, and body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(calls).toHaveLength(AGENT_VAULT_TAG_SCHEMA.length);

    // Namespace ROOT `#agent` — no parent_names, just a description. Plain `#` → `%23`.
    const root = calls[0]!;
    expect(root.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23agent",
    );
    expect(root.init.method).toBe("PUT");
    expect((root.init.headers as Record<string, string>).authorization).toBe(
      "Bearer write-token-xyz",
    );
    const rootBody = JSON.parse(String(root.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect("parent_names" in rootBody).toBe(false);

    // Definition (NEW) — name carries `#` + `/`; rolls up to the namespace root.
    const def = calls[1]!;
    expect(def.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23agent%2Fdefinition",
    );
    expect(decodeURIComponent(def.url.split("/api/tags/")[1]!)).toBe("#agent/definition");
    const defBody = JSON.parse(String(def.init.body)) as { parent_names?: string[] };
    expect(defBody.parent_names).toEqual(["#agent"]);

    // Message parent (NEW) — rolls up to the namespace root.
    const parent = calls[2]!;
    expect(parent.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23agent%2Fmessage",
    );
    const parentBody = JSON.parse(String(parent.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(parentBody.description).toBe(
      "A message in a Parachute channel (parent of /inbound + /outbound).",
    );
    expect(parentBody.parent_names).toEqual(["#agent"]);

    // Inbound child (NEW) — name carries BOTH `#` and `/`. The vault route matches a
    // single path segment (`[^/]+`) then decodeURIComponent's it, so the `/` MUST
    // be encoded as `%2F` (a bare slash would fail the single-segment match → 404).
    const inbound = calls[3]!;
    expect(inbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23agent%2Fmessage%2Finbound",
    );
    // Confirm the encoding decodes back to the literal tag name the vault stores.
    const encodedSegment = inbound.url.split("/api/tags/")[1]!;
    expect(decodeURIComponent(encodedSegment)).toBe("#agent/message/inbound");
    const inboundBody = JSON.parse(String(inbound.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(inboundBody.parent_names).toEqual(["#agent/message"]);
    expect(inboundBody.description).toBe(
      "Human→session message; the vault trigger fires on this.",
    );

    // Outbound child (NEW) — same encoding, parent declared.
    const outbound = calls[4]!;
    expect(outbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/%23agent%2Fmessage%2Foutbound",
    );
    expect(decodeURIComponent(outbound.url.split("/api/tags/")[1]!)).toBe(
      "#agent/message/outbound",
    );
    const outboundBody = JSON.parse(String(outbound.init.body)) as { parent_names?: string[] };
    expect(outboundBody.parent_names).toEqual(["#agent/message"]);

    // Job (NEW) — rolls up to the namespace root.
    const job = calls[5]!;
    expect(decodeURIComponent(job.url.split("/api/tags/")[1]!)).toBe("#agent/job");
    const jobBody = JSON.parse(String(job.init.body)) as { parent_names?: string[] };
    expect(jobBody.parent_names).toEqual(["#agent"]);
  });

  test("schema declares the #agent/* namespace rollup PLUS the interim + legacy families (dual-read, 12 entries)", async () => {
    // The `#agent/*` namespace (design 2026-06-17-vault-native-agents) rolls up
    // definitions, messages, and jobs to the `#agent` root. DUAL-READ: the schema
    // ALSO keeps declaring the interim flat `#agent-message*` AND legacy
    // `#channel-message*` inheritance so pre-namespace history keeps its parent/child
    // expansion until the one-time re-tag run lands. Exactly 12 entries.
    const names = AGENT_VAULT_TAG_SCHEMA.map((e) => e.name);
    expect(names).toEqual([
      "#agent",
      "#agent/definition",
      "#agent/message",
      "#agent/message/inbound",
      "#agent/message/outbound",
      "#agent/job",
      "#agent-message",
      "#agent-message/inbound",
      "#agent-message/outbound",
      "#channel-message",
      "#channel-message/inbound",
      "#channel-message/outbound",
    ]);
    // The namespace children all roll up to the `#agent` root (the human rollup).
    const byName = (n: string) => AGENT_VAULT_TAG_SCHEMA.find((e) => e.name === n)!;
    expect(byName("#agent/definition").parent_names).toEqual(["#agent"]);
    expect(byName("#agent/message").parent_names).toEqual(["#agent"]);
    expect(byName("#agent/job").parent_names).toEqual(["#agent"]);
    expect(byName("#agent/message/inbound").parent_names).toEqual(["#agent/message"]);
    expect(byName("#agent/message/outbound").parent_names).toEqual(["#agent/message"]);
    // The interim + legacy children still declare their own parents (inheritance preserved).
    expect(byName("#agent-message/inbound").parent_names).toEqual(["#agent-message"]);
    expect(byName("#agent-message/outbound").parent_names).toEqual(["#agent-message"]);
    expect(byName("#channel-message/inbound").parent_names).toEqual(["#channel-message"]);
    expect(byName("#channel-message/outbound").parent_names).toEqual(["#channel-message"]);
  });

  test("schema is sourced from AGENT_VAULT_TAG_SCHEMA — declares exactly its entries", async () => {
    const declared: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      declared.push(decodeURIComponent(String(url).split("/api/tags/")[1]!));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(declared).toEqual(AGENT_VAULT_TAG_SCHEMA.map((e) => e.name));
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
      tags: ["#agent/message", "#agent/message/inbound"],
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

describe("VaultTransport — injectInbound (runner seam)", () => {
  test("injectInbound writes an INBOUND note (both tags) with runner provenance", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "inbound-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const r = await t.injectInbound({ content: "Run the morning weave", sender: "runner:morning" });
    expect(r.id).toBe("inbound-1");

    const noteCalls = calls.filter((c) => c.url.endsWith("/api/notes"));
    expect(noteCalls).toHaveLength(1);
    const body = JSON.parse(String(noteCalls[0]!.init.body));
    // Inbound: BOTH the parent + the inbound child (the trigger discriminator).
    expect(body.tags).toEqual(["#agent/message", "#agent/message/inbound"]);
    expect(body.content).toBe("Run the morning weave");
    expect(body.metadata.direction).toBe("inbound");
    expect(body.metadata.sender).toBe("runner:morning");
    // NEVER stamps channel_inbound_rendered_at (so the trigger fires).
    expect(body.metadata.channel_inbound_rendered_at).toBeUndefined();
  });

  test("injectInbound defaults sender to 'runner'", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "x" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    // No throw + returns the id; the default-sender path is exercised.
    expect((await t.injectInbound({ content: "hi" })).id).toBe("x");
  });
});

describe("VaultTransport — scheduled-job notes (vault-native store)", () => {
  test("listJobNotes queries by #agent/job + maps metadata; skips malformed", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify([
          {
            id: "note-uuid-1",
            content: "the message",
            metadata: { jobId: "morning", channel: "eng", cron: "0 9 * * *", tz: "UTC", enabled: "true", createdAt: "t0" },
          },
          // a note WITHOUT jobId metadata → slug falls back to the note id
          {
            id: "Channels/eng/jobs/legacy",
            content: "legacy",
            metadata: { channel: "eng", cron: "0 0 * * *", enabled: "false" },
          },
          // malformed (no cron) → skipped
          { id: "job-bad", content: "x", metadata: { channel: "eng" } },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    const jobs = await t.listJobNotes();
    expect(urls[0]).toContain("tag=%23agent%2Fjob");
    expect(urls[0]).toContain("include_content=true");
    expect(jobs).toHaveLength(2);
    // id = the slug from metadata.jobId; noteId = the vault note id.
    expect(jobs[0]).toMatchObject({ id: "morning", noteId: "note-uuid-1", channel: "eng", cron: "0 9 * * *", tz: "UTC", enabled: true });
    // legacy note (no jobId) → id falls back to the note id.
    expect(jobs[1]).toMatchObject({ id: "Channels/eng/jobs/legacy", noteId: "Channels/eng/jobs/legacy", enabled: false });
  });

  test("listJobNotes throws on a non-ok vault response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await expect(t.listJobNotes()).rejects.toThrow(/list jobs failed \(502\)/);
  });

  test("upsertJobNote POSTs a #agent/job note at the deterministic path", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "Channels/eng/jobs/m" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const r = await t.upsertJobNote({
      id: "m",
      message: "go",
      channel: "eng",
      cron: "0 9 * * *",
      enabled: true,
      createdAt: "t0",
    });
    expect(r.id).toBe("Channels/eng/jobs/m");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.path).toBe("Channels/eng/jobs/m");
    expect(body.tags).toEqual(["#agent/job"]);
    expect(body.metadata.enabled).toBe("true");
    expect(body.metadata.jobId).toBe("m"); // slug persisted for stable display
  });

  test("patchJobNote sends a PATCH with only the changed metadata", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.patchJobNote("job-1", { lastStatus: "ok", lastRunAt: "t1" });
    expect(calls[0]!.init.method).toBe("PATCH");
    expect(calls[0]!.url).toContain("/api/notes/job-1");
    expect(JSON.parse(String(calls[0]!.init.body)).metadata).toEqual({ lastRunAt: "t1", lastStatus: "ok" });
  });

  test("deleteJobNote DELETEs by id", async () => {
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.deleteJobNote("job-1");
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toContain("/api/notes/job-1");
  });

  test("deleteJobNote throws on a non-ok vault response", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await expect(t.deleteJobNote("job-1")).rejects.toThrow(/delete job failed \(404\)/);
  });
});
