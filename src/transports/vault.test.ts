/**
 * Tier 1 unit tests for the vault transport.
 *
 * These exercise the transport WITHOUT a live vault — `fetch` is stubbed to
 * capture the outbound note write, and `ctx.emit` is recorded to assert inbound
 * delivery. They cover:
 *   - reply(): writes the right POST .../api/notes tagged BOTH the queryable parent
 *     `#agent/message` AND the directional child `#agent/message/outbound` (no
 *     `outbound` metadata key), with direction, `metadata.agent`, Bearer token; returns the id;
 *   - reply(): threads in_reply_to when the bridge passes it;
 *   - loadTranscript(): queries the single `#agent/message` parent tag, filters by
 *     `noteAgentKey(meta)` (the routing key) client-side;
 *   - ingestInbound(): emits the inbound content + meta onto its channel;
 *   - ingestInbound(): IGNORES a `#agent/message/outbound`-tagged note (loop avoidance);
 *   - schema: `AGENT_VAULT_TAG_SCHEMA` declares the `#agent/*` namespace rollup;
 *   - registry: a vault channel instantiates from config.
 *
 * TAG NAMESPACE — `#agent/*` (design 2026-06-17-vault-native-agents). WRITE + READ
 * are the `#agent/message*` tags only — the channel→agent data-model rename CONTRACT
 * dropped the legacy `#channel-message*` / interim `#agent-message*` dual-read. The
 * routing key is written under `metadata.agent` ONLY (the `channel` dual-write is
 * dropped); `noteAgentKey` keeps an `agent ?? channel` read fallback for stragglers.
 * The channel-name slugs, `?channel=`, the `Channel*` types, and the `channel/<name>/`
 * note path prefix are DOMAIN — unchanged.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { VaultTransport, AGENT_VAULT_TAG_SCHEMA, AGENT_THREAD_TAG, AGENT_JOB_TAG, InboundClaimConflictError, noteAgentKey } from "./vault.ts";
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
    // Default OFF here: these are unit tests for reply/writeThread/transcript etc.
    // that mock fetch for ONE specific URL and don't want start()'s fire-and-forget
    // ensureSchema() PUT hitting the (unmocked) tag-schema path → benign 401 warn
    // spam against the live vault (#32). The dedicated `ensureSchema` describe block
    // calls `t.ensureSchema()` directly, and the one test that exercises the
    // start()→ensureSchema fire-and-forget path overrides this back to `true`.
    declareSchemaOnStart: false,
  };
}

describe("noteAgentKey — the expand-phase dual-read routing key", () => {
  test("returns `agent` when present", () => {
    expect(noteAgentKey({ agent: "eng" })).toBe("eng");
  });
  test("falls back to legacy `channel` when `agent` is absent", () => {
    expect(noteAgentKey({ channel: "ops" })).toBe("ops");
  });
  test("prefers `agent` over `channel` when BOTH are present", () => {
    expect(noteAgentKey({ agent: "eng", channel: "legacy" })).toBe("eng");
  });
  test("returns undefined when neither is present", () => {
    expect(noteAgentKey({})).toBeUndefined();
    expect(noteAgentKey(undefined)).toBeUndefined();
    expect(noteAgentKey(null)).toBeUndefined();
  });
  test("ignores empty-string / non-string values (falls through)", () => {
    // An empty `agent` is not a usable routing key → fall back to channel.
    expect(noteAgentKey({ agent: "", channel: "ops" })).toBe("ops");
    // Non-string values are ignored entirely.
    expect(noteAgentKey({ agent: 123 as unknown as string, channel: "ops" })).toBe("ops");
    expect(noteAgentKey({ agent: "", channel: "" })).toBeUndefined();
  });
});

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
    // We WRITE only the `#agent/message*` tags.
    expect(sent.tags).toEqual(["agent/message", "agent/message/outbound"]);
    // Regression guard: the queryable parent tag MUST be present literally.
    expect(sent.tags).toContain("agent/message");
    expect(sent.tags).toContain("agent/message/outbound");
    // Write-discipline: the interim/legacy tags are gone (CONTRACT dropped them).
    expect(sent.tags).not.toContain("#agent-message");
    expect(sent.tags).not.toContain("#agent-message/outbound");
    expect(sent.tags).not.toContain("#channel-message");
    expect(sent.tags).not.toContain("#channel-message/outbound");
    // The note PATH prefix is DOMAIN (`channel/<name>/`) — unchanged by the rename.
    expect(sent.path.startsWith("channel/eng/")).toBe(true);
    // CONTRACT: the routing key is written under `metadata.agent` ONLY — no `channel`.
    expect(sent.metadata.agent).toBe("eng");
    expect(sent.metadata.channel).toBeUndefined();
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

  test("reply() stamps metadata.thread from args.meta.thread (the definition→thread→message link)", async () => {
    let captured: Record<string, string> | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes")) {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string> };
        captured = body.metadata;
      }
      return new Response(JSON.stringify({ id: "n3" }), { status: 201 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.reply({ channel: "eng", text: "re", meta: { in_reply_to: "inbound-99", thread: "fire-7" } });
    expect(captured!.thread).toBe("fire-7");
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

describe("VaultTransport — injectInbound (the runner fire) + subject (roles×threads NOW slice)", () => {
  /** Capture the note POST body (ignoring the start()→ensureSchema PUTs). */
  function captureInboundWrite(): { body: () => { content: string; metadata: Record<string, string> } } {
    let captured: { content: string; metadata: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes")) {
        captured = JSON.parse(String(init?.body));
      }
      return new Response(JSON.stringify({ id: "inj-1" }), { status: 201 });
    }) as typeof fetch;
    return { body: () => captured! };
  }

  test("NULL-SUBJECT INVARIANT: injectInbound with NO subject → note metadata has NO `subject` (weave fire byte-identical to HEAD)", async () => {
    const cap = captureInboundWrite();
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    // Exactly the weave job's fire shape today.
    await t.injectInbound({ content: "run the weave", sender: "runner:weave" });

    const m = cap.body().metadata;
    expect(cap.body().content).toBe("run the weave");
    expect(m.agent).toBe("eng");
    expect(m.direction).toBe("inbound");
    expect(m.sender).toBe("runner:weave");
    expect("subject" in m).toBe(false);
  });

  test("injectInbound WITH a subject → stamps metadata.subject", async () => {
    const cap = captureInboundWrite();
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("pm"));
    await t.injectInbound({ content: "status", sender: "runner:standup", subject: "launch-blockers" });
    expect(cap.body().metadata.subject).toBe("launch-blockers");
  });

  test("injectInbound with an EMPTY/whitespace subject → NO `subject` key (trimmed → absent)", async () => {
    const cap = captureInboundWrite();
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("pm"));
    await t.injectInbound({ content: "x", sender: "runner:j", subject: "   " });
    expect("subject" in cap.body().metadata).toBe(false);
  });

  test("injectInbound still defaults sender to `runner` (unchanged) and stays an inbound note", async () => {
    const cap = captureInboundWrite();
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.injectInbound({ content: "y" });
    expect(cap.body().metadata.sender).toBe("runner");
    expect(cap.body().metadata.direction).toBe("inbound");
  });
});

describe("VaultTransport — writeThread (#agent/thread note, the unified model)", () => {
  test("MULTI-THREADED: writeThread() PATCH-upserts (if_missing:create) a fresh-per-fire #agent/thread note with indexed status/definition/mode + timing + Bearer (NO read-back)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "thread-note-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const result = await t.writeThread({
      channel: "eng",
      name: "digest",
      definition: "Agents/digest",
      mode: "multi-threaded",
      status: "ok",
      input: "run the daily digest",
      output: "digest complete: 3 items",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:12.000Z",
      usage: { inputTokens: 100, outputTokens: 40, totalCostUsd: 0.002 },
    });

    expect(result.sent).toEqual(["thread-note-1"]);
    // start() also fires ensureSchema() (PUT .../api/tags/*); isolate the thread-note
    // write. The write is a PATCH-by-path upsert (NOT POST — POST 409s on an existing
    // path), so it targets /api/notes/<encoded-path>, discriminated by method.
    const noteCalls = calls.filter((c) => c.url.includes("/api/notes/") && c.init.method === "PATCH");
    expect(noteCalls).toHaveLength(1);
    // Multi-threaded does NO read-back (no GET to /api/notes/<path>) — fresh per fire.
    const getCalls = calls.filter((c) => c.url.includes("/api/notes/") && (c.init.method ?? "GET") === "GET");
    expect(getCalls).toHaveLength(0);
    const call = noteCalls[0]!;
    expect(decodeURIComponent(call.url)).toContain("/vault/default/api/notes/Threads/eng/");
    expect(call.init.method).toBe("PATCH");
    expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer write-token-xyz");

    const sent = JSON.parse(String(call.init.body)) as {
      content: string;
      path: string;
      tags: string[];
      metadata: Record<string, string>;
      if_missing: string;
      force: boolean;
    };
    // The upsert verb: PATCH + `if_missing: "create"` (creates when missing — every
    // multi-threaded fire — updates when present) + `force: true` (the 428 precondition).
    expect(sent.if_missing).toBe("create");
    expect(sent.force).toBe(true);
    // LOOP SAFETY (HARD CONSTRAINT 4): the thread note carries the thread tag EXACTLY —
    // NOT a message tag + NOT the inbound child — so it can never wake a session.
    expect(sent.tags).toEqual([AGENT_THREAD_TAG]);
    expect(sent.tags).not.toContain("agent/message");
    expect(sent.tags).not.toContain("agent/message/inbound");
    // Indexed/queryable fields.
    expect(sent.metadata.status).toBe("ok");
    expect(sent.metadata.definition).toBe("Agents/digest");
    expect(sent.metadata.mode).toBe("multi-threaded");
    // Thread-state + routing key + usage (stringified for the vault).
    // CONTRACT: routing key under `metadata.agent` ONLY — no `channel`.
    expect(sent.metadata.agent).toBe("eng");
    expect(sent.metadata.channel).toBeUndefined();
    expect(sent.metadata.started_at).toBe("2026-06-18T07:00:00.000Z");
    expect(sent.metadata.last_turn_at).toBe("2026-06-18T07:00:12.000Z");
    expect(sent.metadata.turn_count).toBe("1");
    expect(sent.metadata.input_tokens).toBe("100");
    expect(sent.metadata.output_tokens).toBe("40");
    expect(sent.metadata.total_cost_usd).toBe("0.002");
    // The body is a rolling SUMMARY with the two documented sections.
    expect(sent.content).toContain("## Summary");
    expect(sent.content).toContain("## Latest turn");
    expect(sent.content).toContain("run the daily digest");
    expect(sent.content).toContain("digest complete: 3 items");
    // Multi-threaded path leaf is a fresh uuid under Threads/<channel>/.
    expect(sent.path.startsWith("Threads/eng/")).toBe(true);
  });

  test("SINGLE-THREADED: writeThread() upserts ONE deterministic-path note named after the def (reads existing first)", async () => {
    const posts: { url: string; init: RequestInit }[] = [];
    const gets: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        gets.push(u);
        // First turn: the note doesn't exist yet (404 → turn_count starts at 0).
        return new Response("not found", { status: 404 });
      }
      // The write is a PATCH-by-path upsert (if_missing:create), NOT POST.
      if (u.includes("/api/notes/") && method === "PATCH") {
        posts.push({ url: u, init: init ?? {} });
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 }); // ensureSchema PUTs
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "hello",
      output: "hi there",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    // It READ the existing note first (the upsert read-back), by the DETERMINISTIC path.
    expect(gets).toHaveLength(1);
    expect(decodeURIComponent(gets[0]!)).toContain("/api/notes/Threads/eng/eng");
    // Then UPSERTED via PATCH (if_missing:create) to the same deterministic path.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.init.method).toBe("PATCH");
    expect(decodeURIComponent(posts[0]!.url)).toContain("/api/notes/Threads/eng/eng");
    const sent = JSON.parse(String(posts[0]!.init.body)) as {
      path: string;
      tags: string[];
      metadata: Record<string, string>;
      content: string;
      if_missing: string;
      force: boolean;
    };
    expect(sent.if_missing).toBe("create"); // upsert verb (not POST — POST 409s).
    expect(sent.force).toBe(true);
    expect(sent.tags).toEqual([AGENT_THREAD_TAG]); // loop safety.
    expect(sent.path).toBe("Threads/eng/eng"); // deterministic, named after the def.
    expect(sent.metadata.mode).toBe("single-threaded");
    expect(sent.metadata.turn_count).toBe("1"); // first turn (no prior).
    expect(sent.metadata.started_at).toBe("2026-06-18T07:00:00.000Z");
    expect(sent.metadata.last_turn_at).toBe("2026-06-18T07:00:05.000Z");
    expect(sent.content).toContain("## Summary");
    expect(sent.content).toContain("single-threaded thread for eng");
  });

  test("SINGLE-THREADED over TWO turns: same deterministic path, turn_count==2, summed usage, preserved started_at", async () => {
    // Simulate a vault: the second turn reads back the note the FIRST turn wrote.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      // PATCH-by-path with if_missing:create is the upsert (turn 1 creates, turn 2 updates).
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content }; // the vault upserts it.
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "turn one",
      output: "reply one",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z",
      usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.001 },
    });
    expect(stored!.metadata.turn_count).toBe("1");

    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "turn two",
      output: "reply two",
      started_at: "2026-06-18T08:00:00.000Z", // a LATER start — must NOT overwrite the first.
      ended_at: "2026-06-18T08:00:09.000Z",
      usage: { inputTokens: 20, outputTokens: 8, totalCostUsd: 0.002 },
    });

    // ONE note, upserted: turn_count incremented, usage SUMMED, started_at PRESERVED,
    // last_turn_at advanced.
    expect(stored!.metadata.turn_count).toBe("2");
    expect(stored!.metadata.input_tokens).toBe("30"); // 10 + 20
    expect(stored!.metadata.output_tokens).toBe("13"); // 5 + 8
    expect(stored!.metadata.total_cost_usd).toBe("0.003"); // 0.001 + 0.002
    expect(stored!.metadata.started_at).toBe("2026-06-18T07:00:00.000Z"); // first turn's, preserved.
    expect(stored!.metadata.last_turn_at).toBe("2026-06-18T08:00:09.000Z"); // latest turn.
    // The body's summary reflects 2 turns + the latest turn's content.
    expect(stored!.content).toContain("2 turns");
    expect(stored!.content).toContain("turn two");
    expect(stored!.content).toContain("reply two");
  });

  test("SINGLE-THREADED re-record of the SAME turn (sameTurn) flips status WITHOUT double-counting turn_count (PR #3 FIX 1)", async () => {
    // The outbound-failure path: the turn was recorded `ok`, then the additive transcript
    // write failed, so the same turn is re-recorded `error`. `sameTurn` must keep the count
    // (the turn was already counted) — the reviewer caught the original re-record bumping it.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "ok",
      input: "q", output: "a", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", threadId: "t1",
    });
    expect(stored!.metadata.turn_count).toBe("1");
    // Re-record the SAME turn as error (outbound delivery failed). sameTurn → no increment.
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "error",
      input: "q", output: "reply produced but NOT delivered", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:06.000Z", threadId: "t1", sameTurn: true,
    });
    expect(stored!.metadata.turn_count).toBe("1"); // NOT 2 — the same turn, not a new one.
    expect(stored!.metadata.status).toBe("error");
    expect(stored!.content).toContain("NOT delivered");
  });

  test("SINGLE-THREADED FULL lifecycle start→end(ok)→end(error,sameTurn): count goes 0→1→1, never double-counts (thread-as-container + FIX 1)", async () => {
    // The real drain path now writes a `working` start-ensure BEFORE the turn, then an
    // `end` record, then (on outbound failure) an `end` re-record with sameTurn. This is
    // the one combination the prior FIX-1 test didn't exercise: a start-ensure preceding
    // the re-record. The start must NOT count; the first end counts once; the sameTurn
    // re-record must keep it.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const base = {
      channel: "eng", name: "eng", mode: "single-threaded" as const, input: "q",
      started_at: "2026-06-18T07:00:00.000Z", ended_at: "2026-06-18T07:00:05.000Z", threadId: "t1",
    };
    // 1) start-ensure (working) — the container, BEFORE the turn. Must NOT count.
    await t.writeThread({ ...base, status: "working", output: "", phase: "start" });
    expect(stored!.metadata.turn_count).toBe("0");
    expect(stored!.metadata.status).toBe("working");
    // 2) end(ok) — the turn completed: count once.
    await t.writeThread({ ...base, status: "ok", output: "a", phase: "end" });
    expect(stored!.metadata.turn_count).toBe("1");
    expect(stored!.metadata.status).toBe("ok");
    // 3) end(error, sameTurn) — outbound write failed, re-record the SAME turn. No increment.
    await t.writeThread({ ...base, status: "error", output: "reply produced but NOT delivered", phase: "end", sameTurn: true });
    expect(stored!.metadata.turn_count).toBe("1"); // STILL 1 — start didn't count, sameTurn didn't re-count.
    expect(stored!.metadata.status).toBe("error");
  });

  test("MULTI-THREADED re-record reuses the passed threadId leaf — ONE note, not a duplicate (PR #3 FIX 1)", async () => {
    const patchPaths: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        patchPaths.push(decodeURIComponent(u));
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const base = {
      channel: "eng", name: "d", mode: "multi-threaded" as const,
      input: "q", started_at: "2026-06-18T07:00:00.000Z", ended_at: "2026-06-18T07:00:05.000Z",
      threadId: "fixed-uuid",
    };
    await t.writeThread({ ...base, status: "ok", output: "a" });
    await t.writeThread({ ...base, status: "error", output: "undelivered", sameTurn: true });
    // Both writes hit the SAME per-fire path (the reused threadId) — without the fix the
    // second would mint a fresh uuid → a DIFFERENT path → a duplicate note for one turn.
    const threadPatches = patchPaths.filter((p) => p.includes("/Threads/eng/"));
    expect(threadPatches).toHaveLength(2);
    expect(threadPatches[0]).toContain("/Threads/eng/fixed-uuid");
    expect(threadPatches[1]).toContain("/Threads/eng/fixed-uuid");
  });

  test("SINGLE-THREADED error on turn 2: turn_count==2, status:error, started_at preserved, last_turn_at advanced", async () => {
    // Same stored-note simulation as the two-turn test: turn 2 reads back turn 1's note.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    // Turn 1 — ok.
    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "turn one",
      output: "reply one",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z",
    });
    expect(stored!.metadata.status).toBe("ok");

    // Turn 2 — ERROR. The single-threaded thread keeps upserting (the failure is part of
    // the rolling thread record); the status reflects this latest turn.
    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "error",
      input: "turn two",
      output: "claude -p exited 1: boom",
      started_at: "2026-06-18T08:00:00.000Z", // later — must NOT overwrite the first.
      ended_at: "2026-06-18T08:00:09.000Z",
    });

    expect(stored!.metadata.turn_count).toBe("2"); // incremented despite the error.
    expect(stored!.metadata.status).toBe("error"); // the latest turn's outcome.
    expect(stored!.metadata.started_at).toBe("2026-06-18T07:00:00.000Z"); // preserved.
    expect(stored!.metadata.last_turn_at).toBe("2026-06-18T08:00:09.000Z"); // advanced.
    // The body's latest-turn section is the Error block.
    expect(stored!.content).toContain("**Error:**");
    expect(stored!.content).toContain("claude -p exited 1: boom");
  });

  test("SINGLE-THREADED: a 500 on the read-back GET rejects (not a silent aggregate reset)", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      // The single-threaded read-back GET returns a 500 (an UNEXPECTED non-404 error) →
      // readThreadNote throws → writeThread rejects, surfacing the misconfig rather than
      // silently resetting the thread's aggregates.
      if (u.includes("/api/notes/") && method === "GET") {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(
      t.writeThread({
        channel: "eng",
        name: "eng",
        mode: "single-threaded",
        status: "ok",
        input: "x",
        output: "y",
        started_at: "2026-06-18T07:00:00.000Z",
        ended_at: "2026-06-18T07:00:01.000Z",
      }),
    ).rejects.toThrow(/read thread note failed/);
  });

  test("SINGLE-THREADED cost rounding: 0.1 + 0.2 serializes as \"0.3\" (no IEEE-754 drift)", async () => {
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "one",
      output: "r1",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z",
      usage: { totalCostUsd: 0.1 },
    });
    await t.writeThread({
      channel: "eng",
      name: "eng",
      mode: "single-threaded",
      status: "ok",
      input: "two",
      output: "r2",
      started_at: "2026-06-18T08:00:00.000Z",
      ended_at: "2026-06-18T08:00:09.000Z",
      usage: { totalCostUsd: 0.2 },
    });

    // The naive sum 0.1 + 0.2 === 0.30000000000000004; the round-to-9-decimals guard
    // serializes it cleanly as "0.3".
    expect(stored!.metadata.total_cost_usd).toBe("0.3");
  });

  test("writeThread() on a MULTI-THREADED error turn records status:error + the failure reason in the body (NO read-back)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let captured: { tags: string[]; metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        captured = JSON.parse(String(init?.body));
      }
      return new Response(JSON.stringify({ id: "thread-err-1" }), { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.writeThread({
      channel: "eng",
      mode: "multi-threaded",
      status: "error",
      input: "do the thing",
      output: "claude -p exited 1: boom",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:01.000Z",
    });

    expect(captured!.metadata.status).toBe("error");
    // No definition → the field is absent (not an empty string).
    expect("definition" in captured!.metadata).toBe(false);
    // The body's latest-turn section is the Error block on a failure.
    expect(captured!.content).toContain("**Error:**");
    expect(captured!.content).toContain("claude -p exited 1: boom");
    // Multi-threaded does NO read-back even on the error path (fresh per fire).
    expect(
      calls.filter((c) => c.url.includes("/api/notes/") && (c.init.method ?? "GET") === "GET"),
    ).toHaveLength(0);
  });

  test("writeThread() throws on a non-ok vault response (PATCH)", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      // multi-threaded → no GET; the PATCH upsert fails.
      if (String(url).includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(
      t.writeThread({
        channel: "eng",
        mode: "multi-threaded",
        status: "ok",
        input: "x",
        output: "y",
        started_at: "2026-06-18T07:00:00.000Z",
        ended_at: "2026-06-18T07:00:01.000Z",
      }),
    ).rejects.toThrow(/write thread note failed/);
  });

  // ── Thread-as-container: the phase:"start" working-ensure (Part B) ────────────────────
  // A turn now writes TWO thread notes: a `phase:"start"` working-ensure BEFORE the turn
  // (status:working, NO reply, turn_count UNCHANGED) and a `phase:"end"` final record after
  // (status:ok/error, turn counted). turn_count must be counted EXACTLY ONCE — on `end` —
  // never double-counted across the start+end pair. These assert that at the transport.

  test("SINGLE-THREADED start→end does NOT double-count: turn 1 start writes turn_count 0 (working), end writes 1", async () => {
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    // START-ENSURE (before the turn): status working, turn_count UNCHANGED (prior 0 → 0).
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "working",
      input: "turn one", output: "", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:00.000Z", threadId: "t1", phase: "start",
    });
    expect(stored!.metadata.status).toBe("working");
    expect(stored!.metadata.turn_count).toBe("0"); // NOT counted yet.
    // The working body shows the input + an awaiting-reply state — NO fake reply.
    expect(stored!.content).toContain("turn one");
    expect(stored!.content).toContain("working");
    expect(stored!.content).not.toContain("**Reply:**");
    // last_turn_at is not stamped on a brand-new working-ensure (no turn completed yet).
    expect(stored!.metadata.last_turn_at).toBeUndefined();

    // END (after the turn): status ok, turn_count now 1 (counted exactly once).
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "ok",
      input: "turn one", output: "reply one", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", threadId: "t1", phase: "end",
    });
    expect(stored!.metadata.status).toBe("ok");
    expect(stored!.metadata.turn_count).toBe("1"); // counted ONCE across start+end.
    expect(stored!.metadata.last_turn_at).toBe("2026-06-18T07:00:05.000Z");
    expect(stored!.content).toContain("reply one");
  });

  test("SINGLE-THREADED turn 2 start preserves prior count (1), end increments to 2 — start never double-counts", async () => {
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const tn = (status: "working" | "ok", input: string, output: string, ended: string, phase: "start" | "end") => ({
      channel: "eng", name: "eng", mode: "single-threaded" as const, status,
      input, output, started_at: "2026-06-18T07:00:00.000Z", ended_at: ended, phase,
    });

    // Turn 1 — start (0) then end (1).
    await t.writeThread(tn("working", "one", "", "2026-06-18T07:00:00.000Z", "start"));
    expect(stored!.metadata.turn_count).toBe("0");
    await t.writeThread(tn("ok", "one", "reply one", "2026-06-18T07:00:05.000Z", "end"));
    expect(stored!.metadata.turn_count).toBe("1");

    // Turn 2 — start reads prior=1 → writes 1 (UNCHANGED, the no-double-count invariant),
    // then end increments to 2. The start working-ensure must NOT bump the count.
    await t.writeThread(tn("working", "two", "", "2026-06-18T08:00:00.000Z", "start"));
    expect(stored!.metadata.turn_count).toBe("1"); // start preserves the count.
    expect(stored!.metadata.status).toBe("working");
    expect(stored!.metadata.started_at).toBe("2026-06-18T07:00:00.000Z"); // first turn's, preserved.
    await t.writeThread(tn("ok", "two", "reply two", "2026-06-18T08:00:09.000Z", "end"));
    expect(stored!.metadata.turn_count).toBe("2"); // counted twice total — once per turn.
    expect(stored!.metadata.last_turn_at).toBe("2026-06-18T08:00:09.000Z");
  });

  test("MULTI-THREADED start writes turn_count 0 (working) at the per-fire path; end writes 1 at the SAME path", async () => {
    const patches: { path: string; metadata: Record<string, string>; content: string }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          path: string; metadata: Record<string, string>; content: string;
        };
        patches.push({ path: decodeURIComponent(u), metadata: body.metadata, content: body.content });
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const base = {
      channel: "eng", name: "d", mode: "multi-threaded" as const, input: "q",
      started_at: "2026-06-18T07:00:00.000Z", threadId: "fire-1",
    };
    // START — working, turn_count 0, the per-fire note created.
    await t.writeThread({ ...base, status: "working", output: "", ended_at: "2026-06-18T07:00:00.000Z", phase: "start" });
    // END — ok, turn_count 1, the SAME per-fire path (same threadId).
    await t.writeThread({ ...base, status: "ok", output: "a", ended_at: "2026-06-18T07:00:05.000Z", phase: "end" });

    expect(patches).toHaveLength(2);
    expect(patches[0]!.metadata.status).toBe("working");
    expect(patches[0]!.metadata.turn_count).toBe("0");
    expect(patches[1]!.metadata.status).toBe("ok");
    expect(patches[1]!.metadata.turn_count).toBe("1");
    // Both writes hit the SAME per-fire path (the reused threadId) — start updates, not dupes.
    expect(patches[0]!.path).toContain("/Threads/eng/fire-1");
    expect(patches[1]!.path).toContain("/Threads/eng/fire-1");
    // The working body shows no fake reply; the end body carries the real reply.
    expect(patches[0]!.content).not.toContain("**Reply:**");
    expect(patches[1]!.content).toContain("a");
  });

  // ── thread ≡ session (metadata.session — the unified record) ──────────────────────────

  test("writeThread() persists metadata.session when thread.session is set", async () => {
    const posts: { metadata: Record<string, string> }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        posts.push({ metadata: (JSON.parse(String(init?.body)) as { metadata: Record<string, string> }).metadata });
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }
      // multi-threaded → no GET read-back; serve ensureSchema PUTs + anything else 200.
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await t.writeThread({
      channel: "eng",
      mode: "multi-threaded",
      status: "ok",
      input: "q",
      output: "a",
      started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z",
      session: "11111111-1111-4111-8111-111111111111",
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.metadata.session).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("SINGLE-THREADED upsert PRESERVES a prior metadata.session when the new write carries none", async () => {
    // The start-phase working-ensure carries NO session; it must not drop the prior one.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    // Turn 1 END establishes the session on the note.
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "ok",
      input: "one", output: "reply one", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", phase: "end",
      session: "sess-ESTABLISHED",
    });
    expect(stored!.metadata.session).toBe("sess-ESTABLISHED");

    // Turn 2 START-ENSURE carries NO session — the upsert must PRESERVE the prior one.
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "working",
      input: "two", output: "", started_at: "2026-06-18T08:00:00.000Z",
      ended_at: "2026-06-18T08:00:00.000Z", phase: "start",
    });
    expect(stored!.metadata.session).toBe("sess-ESTABLISHED"); // preserved, not dropped.
  });

  // ── roles×threads NEXT slice (#120) — a MULTI-THREADED SUBJECT thread is a DETERMINISTIC,
  //    upserting note at `Threads/<ch>/<name>--<subject>` (rolling turn_count + preserved
  //    session across fires), NOT a per-fire uuid note. ─────────────────────────────────────
  test("MULTI-THREADED SUBJECT: writeThread() upserts a DETERMINISTIC `<name>--<subject>` note (rolls turn_count, reads back)", async () => {
    // Per (channel, leaf) store — keyed by the path so distinct subjects are distinct notes.
    const store = new Map<string, { metadata: Record<string, string>; content: string }>();
    const patched: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = decodeURIComponent(String(url));
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        const path = u.split("/api/notes/")[1]!;
        const hit = store.get(path);
        return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("nf", { status: 404 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { path: string; metadata: Record<string, string>; content: string };
        store.set(body.path, { metadata: body.metadata, content: body.content });
        patched.push(body.path);
        return new Response(JSON.stringify({ id: body.path }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("pm"));

    // Fire 1 of subject "eco-civ" — creates the deterministic subject note, turn_count 1.
    const r1 = await t.writeThread({
      channel: "pm", name: "pm", subject: "eco-civ", mode: "multi-threaded", status: "ok",
      input: "kickoff", output: "ok1", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", session: "sess-ECO", phase: "end",
    });
    // Fire 2 of the SAME subject — UPSERTS the same note (turn_count 2), proving continuity.
    const r2 = await t.writeThread({
      channel: "pm", name: "pm", subject: "eco-civ", mode: "multi-threaded", status: "ok",
      input: "next", output: "ok2", started_at: "2026-06-18T08:00:00.000Z",
      ended_at: "2026-06-18T08:00:09.000Z", session: "sess-ECO", phase: "end",
    });

    // BOTH fires hit the SAME deterministic subject-scoped path (NOT a per-fire uuid).
    expect(r1.sent[0]).toBe("Threads/pm/pm--eco-civ");
    expect(r2.sent[0]).toBe("Threads/pm/pm--eco-civ");
    expect(patched.every((p) => p === "Threads/pm/pm--eco-civ")).toBe(true);
    const note = store.get("Threads/pm/pm--eco-civ")!;
    expect(note.metadata.turn_count).toBe("2"); // rolled across fires — per-thread continuity.
    expect(note.metadata.started_at).toBe("2026-06-18T07:00:00.000Z"); // first fire's, preserved.
    expect(note.metadata.session).toBe("sess-ECO"); // session carried across fires.
    expect(note.metadata.mode).toBe("multi-threaded");

    // A DIFFERENT subject of the same agent is a DISTINCT note (distinct leaf).
    const r3 = await t.writeThread({
      channel: "pm", name: "pm", subject: "ai-livelihood", mode: "multi-threaded", status: "ok",
      input: "other", output: "ok3", started_at: "2026-06-18T09:00:00.000Z",
      ended_at: "2026-06-18T09:00:03.000Z", phase: "end",
    });
    expect(r3.sent[0]).toBe("Threads/pm/pm--ai-livelihood");
    expect(store.get("Threads/pm/pm--ai-livelihood")!.metadata.turn_count).toBe("1"); // its own count.
    // The eco-civ note is untouched by the ai-livelihood fire (no cross-subject clobber).
    expect(store.get("Threads/pm/pm--eco-civ")!.metadata.turn_count).toBe("2");
  });

  test("MULTI-THREADED with NO subject stays a PER-FIRE uuid note (HEAD) — no read-back, turn_count 1", async () => {
    const patches: string[] = [];
    let gets = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = decodeURIComponent(String(url));
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") { gets++; return new Response("nf", { status: 404 }); }
      if (u.includes("/api/notes/") && method === "PATCH") {
        patches.push(u.split("/api/notes/")[1]!);
        return new Response(JSON.stringify({ id: "x" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("pm"));
    await t.writeThread({
      channel: "pm", name: "pm", mode: "multi-threaded", status: "ok", input: "q", output: "a",
      started_at: "2026-06-18T07:00:00.000Z", ended_at: "2026-06-18T07:00:01.000Z", threadId: "fire-xyz",
    });
    // Per-fire uuid leaf, NO read-back (HEAD multi-threaded behavior — byte-identical).
    expect(gets).toBe(0);
    expect(patches[0]).toBe("Threads/pm/fire-xyz");
  });

  test("SUBJECT continuity round-trip: readThreadSession(subject) reads the session written at the subject-scoped note", async () => {
    const store = new Map<string, { metadata: Record<string, string>; content: string }>();
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = decodeURIComponent(String(url));
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        const path = u.split("/api/notes/")[1]!;
        const hit = store.get(path);
        return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("nf", { status: 404 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { path: string; metadata: Record<string, string>; content: string };
        store.set(body.path, { metadata: body.metadata, content: body.content });
        return new Response(JSON.stringify({ id: body.path }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("pm"));

    // No subject note yet → undefined.
    expect(await t.readThreadSession("pm", "pm", "eco-civ")).toBeUndefined();
    // Write a subject thread carrying a session…
    await t.writeThread({
      channel: "pm", name: "pm", subject: "eco-civ", mode: "multi-threaded", status: "ok",
      input: "q", output: "a", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", session: "sess-SUBJECT", phase: "end",
    });
    // …readThreadSession(subject) reads it back off the SUBJECT-scoped path.
    expect(await t.readThreadSession("pm", "pm", "eco-civ")).toBe("sess-SUBJECT");
    // A different subject (no note) is independent → undefined (no cross-subject leak).
    expect(await t.readThreadSession("pm", "pm", "other")).toBeUndefined();
    // The NO-subject read targets the def-named note (different leaf) → undefined here.
    expect(await t.readThreadSession("pm", "pm")).toBeUndefined();
  });

  test("readThreadSession() round-trips the stored session (the pre-turn resume read)", async () => {
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    const gets: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        gets.push(decodeURIComponent(u));
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { metadata: Record<string, string>; content: string };
        stored = { metadata: body.metadata, content: body.content };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    // Before any turn: no note → undefined (the first-turn create path).
    expect(await t.readThreadSession("eng", "eng")).toBeUndefined();

    // Write a thread note carrying a session…
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "ok",
      input: "x", output: "y", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", phase: "end",
      session: "sess-ROUNDTRIP",
    });

    // …readThreadSession reads it back off the DETERMINISTIC single-threaded path.
    expect(await t.readThreadSession("eng", "eng")).toBe("sess-ROUNDTRIP");
    expect(gets.some((g) => g.includes("/api/notes/Threads/eng/eng"))).toBe(true);
  });

  test("clearThreadSession() wipes the session (PATCH session:\"\", force) → readThreadSession undefined (the per-agent reset)", async () => {
    // The vault: a stateful note whose metadata is replaced by each PATCH (mirrors the real
    // PATCH-merge for the fields we send). readThreadSession's truthy guard treats "" as none.
    let stored: { metadata: Record<string, string>; content: string } | undefined;
    const patches: { metadata: Record<string, unknown>; force?: boolean }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/api/notes/") && method === "GET") {
        if (!stored) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(stored), { status: 200 });
      }
      if (u.includes("/api/notes/") && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as {
          metadata: Record<string, string>;
          content?: string;
          force?: boolean;
        };
        patches.push({ metadata: body.metadata, force: body.force });
        // Merge the PATCHed metadata over the prior (the vault upserts field-by-field).
        stored = { metadata: { ...(stored?.metadata ?? {}), ...body.metadata }, content: body.content ?? stored?.content ?? "" };
        return new Response(JSON.stringify({ id: "thread-eng" }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));

    // Establish a session, then RESET it.
    await t.writeThread({
      channel: "eng", name: "eng", mode: "single-threaded", status: "ok",
      input: "x", output: "y", started_at: "2026-06-18T07:00:00.000Z",
      ended_at: "2026-06-18T07:00:05.000Z", phase: "end", session: "sess-TO-CLEAR",
    });
    expect(await t.readThreadSession("eng", "eng")).toBe("sess-TO-CLEAR");

    await t.clearThreadSession("eng", "eng");
    // The clear PATCH wrote session:"" with force (the vault mutation precondition).
    const clearPatch = patches[patches.length - 1]!;
    expect(clearPatch.metadata.session).toBe("");
    expect(clearPatch.force).toBe(true);
    // …and readThreadSession now reports NO session (the "" guard) → next turn starts fresh.
    expect(await t.readThreadSession("eng", "eng")).toBeUndefined();
  });

  test("clearThreadSession() is a no-op when no thread note exists yet (404)", async () => {
    let patched = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        patched = true;
        return new Response("not found", { status: 404 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    // Must NOT throw on a 404 (no thread yet = already fresh).
    await t.clearThreadSession("eng", "eng");
    expect(patched).toBe(true); // it tried (and tolerated the 404).
  });

  test("clearThreadSession() throws on a non-ok, non-404 vault response", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/notes/") && (init?.method ?? "GET") === "PATCH") {
        return new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    await expect(t.clearThreadSession("eng", "eng")).rejects.toThrow(/clear thread session failed/);
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
        // CONTRACT: a SINGLE `#agent/message` query (no interim/legacy union).
        if (u.includes("tag=agent%2Fmessage")) {
          // Return notes OUT of ts order (prove the ascending sort) + a note from a
          // DIFFERENT channel (prove the client-side channel filter excludes it).
          return new Response(
            JSON.stringify([
              {
                id: "n-out",
                content: "session reply",
                tags: ["agent/message", "agent/message/outbound"],
                metadata: { agent: "eng", direction: "outbound", sender: "session", ts: "2026-06-08T00:00:02Z", in_reply_to: "n-in" },
              },
              {
                id: "n-other",
                content: "different channel — must be excluded",
                tags: ["agent/message", "agent/message/inbound"],
                metadata: { agent: "other", direction: "inbound", sender: "x", ts: "2026-06-08T00:00:03Z" },
              },
              {
                id: "n-in",
                content: "hi session",
                tags: ["agent/message", "agent/message/inbound"],
                metadata: { agent: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:01Z" },
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      // ensureSchema PUTs
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const msgs = await t.loadTranscript();

    // CONTRACT: exactly ONE `#agent/message` query — the interim/legacy union is gone.
    // It carries the encoded parent tag + include_content, and DELIBERATELY no
    // `metadata=` operator filter (the routing-key field isn't indexed on a bare
    // vault; we filter client-side). Overfetches the tag so other channels don't
    // crowd us out.
    const agentGets = getUrls.filter((u) => u.includes("tag=agent%2Fmessage"));
    expect(agentGets).toHaveLength(1);
    // No interim/legacy queries are issued.
    expect(getUrls.some((u) => u.includes("tag=%23agent-message"))).toBe(false);
    expect(getUrls.some((u) => u.includes("tag=%23channel-message"))).toBe(false);
    const agentGet = agentGets[0]!;
    expect(agentGet.startsWith("http://127.0.0.1:1940/vault/default/api/notes?")).toBe(true);
    expect(agentGet).toContain("include_content=true");
    expect(agentGet).not.toContain("metadata=");
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

  test("caps the returned transcript to the requested limit (most-recent by ts)", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        if (u.includes("tag=agent%2Fmessage")) {
          return new Response(
            JSON.stringify([1, 2, 3, 4].map((i) => ({
              id: "n" + i,
              content: "m" + i,
              tags: ["agent/message", "agent/message/inbound"],
              metadata: { agent: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:0" + i + "Z" },
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

  test("falls back to the outbound child tag for direction when metadata.direction is absent", async () => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/notes") && (init?.method ?? "GET") === "GET") {
        if (u.includes("tag=agent%2Fmessage")) {
          return new Response(
            JSON.stringify([
              // Outbound child → direction inferred "outbound".
              { id: "a", content: "x", tags: ["agent/message", "agent/message/outbound"], metadata: { agent: "eng", ts: "2026-06-08T00:00:01Z" } },
              // No direction signal at all → defaults to "inbound".
              { id: "b", content: "y", tags: ["agent/message", "agent/message/inbound"], metadata: { agent: "eng", ts: "2026-06-08T00:00:02Z" } },
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
    expect(sent.tags).toEqual(["agent/message", "agent/message/inbound"]);
    expect(sent.tags).toContain("agent/message");
    expect(sent.tags).toContain("agent/message/inbound");
    // It must NOT carry the outbound tag (that would be a reply, never wake).
    expect(sent.tags).not.toContain("agent/message/outbound");
    // Write-discipline: the legacy tag family is gone (CONTRACT dropped it).
    expect(sent.tags).not.toContain("#channel-message");
    // CONTRACT: the routing key under `metadata.agent` ONLY — no `channel`. The vault
    // trigger keys on `has_metadata:["agent"]` to fire on this inbound note.
    expect(sent.metadata.agent).toBe("eng");
    expect(sent.metadata.channel).toBeUndefined();
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

describe("VaultTransport — writeCallback (agent-to-agent reply_to substrate)", () => {
  test("writes an INBOUND note carrying the callback metadata contract, NO reply_to, both inbound tags", async () => {
    let sent: { content: string; tags: string[]; metadata: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes") && init?.method === "POST") {
        sent = JSON.parse(String(init?.body));
      }
      return new Response(JSON.stringify({ id: "callback-note-1" }), { status: 201 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("orchestrator")); // the SENDER's channel.
    const result = await t.writeCallback("[callback] worker finished (ok) — see source_message.", {
      callback: "true",
      status: "ok",
      source_channel: "worker",
      source_thread: "thread-uuid-1",
      source_message: "reply-note-7",
      correlation_id: "corr-abc",
      delegation_depth: "3",
    });

    expect(result.sent).toEqual(["callback-note-1"]);
    // The callback is an INBOUND note (so it wakes the sender via the normal vault trigger).
    expect(sent!.tags).toEqual(["agent/message", "agent/message/inbound"]);
    expect(sent!.tags).not.toContain("agent/message/outbound");
    // The metadata contract — all present fields stamped.
    expect(sent!.metadata.callback).toBe("true");
    expect(sent!.metadata.status).toBe("ok");
    expect(sent!.metadata.source_channel).toBe("worker");
    expect(sent!.metadata.source_thread).toBe("thread-uuid-1");
    expect(sent!.metadata.source_message).toBe("reply-note-7");
    expect(sent!.metadata.correlation_id).toBe("corr-abc");
    expect(sent!.metadata.delegation_depth).toBe("3");
    // The channel it's routed to is THIS transport's channel (the sender's), direction inbound.
    // CONTRACT: routing key under `metadata.agent` ONLY — no `channel`.
    expect(sent!.metadata.agent).toBe("orchestrator");
    expect(sent!.metadata.channel).toBeUndefined();
    expect(sent!.metadata.direction).toBe("inbound");
    expect(sent!.metadata.sender).toBe("callback:worker");
    // LOOP GUARD: the callback note must NEVER carry a reply_to (terminal callback).
    expect(sent!.metadata.reply_to).toBeUndefined();
  });

  test("omits source_message + correlation_id when absent (error callback, no reply)", async () => {
    let sent: { metadata: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes") && init?.method === "POST") sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "n" }), { status: 201 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("orchestrator"));
    await t.writeCallback("[callback] worker finished with an error.", {
      callback: "true",
      status: "error",
      source_channel: "worker",
      source_thread: "thread-2",
      delegation_depth: "1",
    });
    expect(sent!.metadata.status).toBe("error");
    expect(sent!.metadata.source_message).toBeUndefined();
    expect(sent!.metadata.correlation_id).toBeUndefined();
  });

  test("a stray reply_to on the meta is STRIPPED (defense-in-depth loop guard)", async () => {
    let sent: { metadata: Record<string, string> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/notes") && init?.method === "POST") sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "n" }), { status: 201 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("orchestrator"));
    // Simulate a (mistaken) caller widening the shape with a reply_to — it must NOT survive.
    await t.writeCallback("x", {
      callback: "true",
      status: "ok",
      source_channel: "worker",
      source_thread: "t",
      delegation_depth: "1",
      // @ts-expect-error — intentionally passing an extra field the contract forbids.
      reply_to: "should-be-stripped",
    });
    expect(sent!.metadata.reply_to).toBeUndefined();
  });
});

describe("VaultTransport — ingestInbound", () => {
  test("emits the inbound content + meta onto its channel", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    // start synchronously enough for the test (start just stores ctx).
    void t.start(ctx);
    void t.ingestInbound({
      id: "note-in-1",
      content: "hello session",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "eng", direction: "inbound", sender: "aaron", ts: "2026-06-08T00:00:00Z" },
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
    // CONTRACT: the routing key on the in-memory event meta is stamped under `agent`
    // ONLY (the `channel` dual-write is dropped). The top-level InboundMessage.channel
    // TS field stays the channel name.
    expect(m.meta.agent).toBe("eng");
    expect(m.meta.channel).toBeUndefined();
  });

  test("IGNORES a #agent/message/outbound-tagged note (loop avoidance)", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    void t.ingestInbound({
      id: "our-own-reply",
      content: "I am awake",
      tags: ["agent/message", "agent/message/outbound"],
      metadata: { channel: "eng", direction: "outbound", sender: "session" },
    });
    expect(ctx.emitted).toHaveLength(0);
  });

  test("IGNORES a note with direction:outbound even if the outbound tag is absent", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    void t.ingestInbound({
      id: "x",
      content: "y",
      metadata: { channel: "eng", direction: "outbound" },
    });
    expect(ctx.emitted).toHaveLength(0);
  });

  test("SURFACES attachments on the emitted InboundMessage when the note carries them (Phase 1)", async () => {
    // The webhook payload carries `note.attachments` inline (the has-attachments signal);
    // ingestInbound then fetches the authoritative attachment list (REST) and surfaces the
    // refs on the emitted message so the programmatic backend can stage them.
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      // The attachment-list endpoint → a bare Attachment[] array (vault REST shape).
      return new Response(
        JSON.stringify([
          { id: "a1", noteId: "note-att-1", path: "2026-06-24/pic.png", mimeType: "image/png", createdAt: "x" },
          { id: "a2", noteId: "note-att-1", path: "2026-06-24/doc.pdf", mimeType: "application/pdf", createdAt: "x" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    await t.ingestInbound({
      id: "note-att-1",
      content: "look at these",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "eng", direction: "inbound", sender: "aaron" },
      // inline list from the trigger payload — the has-attachments SIGNAL.
      attachments: [{ id: "a1", path: "2026-06-24/pic.png", mimeType: "image/png" }],
    });

    // It fetched the attachment-list endpoint with the channel's vault token.
    expect(calls.some((u) => u.endsWith("/vault/default/api/notes/note-att-1/attachments"))).toBe(true);

    expect(ctx.emitted).toHaveLength(1);
    const m = ctx.emitted[0]!;
    expect(m.content).toBe("look at these");
    expect(m.attachments).toBeDefined();
    expect(m.attachments).toHaveLength(2);
    expect(m.attachments![0]).toEqual({ path: "2026-06-24/pic.png", mimeType: "image/png", filename: "pic.png" });
    expect(m.attachments![1]).toEqual({ path: "2026-06-24/doc.pdf", mimeType: "application/pdf", filename: "doc.pdf" });
  });

  test("attachment-list fetch FAILURE is best-effort — the message is still emitted with text, no attachments", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    await t.ingestInbound({
      id: "note-att-fail",
      content: "still delivered",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "eng", direction: "inbound" },
      attachments: [{ id: "a1", path: "2026-06-24/pic.png", mimeType: "image/png" }],
    });
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.content).toBe("still delivered");
    expect(ctx.emitted[0]!.attachments).toBeUndefined();
  });

  test("NO inline attachments → NO fetch, emits synchronously (today's behavior)", () => {
    // Any fetch here would throw — proving the no-attachment path never reaches out.
    globalThis.fetch = (async () => {
      throw new Error("must not fetch");
    }) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    // Not awaited — emit must be synchronous (before any await) when there are no attachments.
    void t.ingestInbound({
      id: "note-plain",
      content: "no files",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "eng", direction: "inbound" },
    });
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.attachments).toBeUndefined();
  });

  test("FLATTENS the agent-to-agent callback fields (reply_to/correlation_id/delegation_depth) into meta", () => {
    // The READ side of the callback round-trip: a SENDING agent stamps reply_to et al on the
    // inbound note's metadata; ingestInbound must surface them in `meta` so contextFor.emit's
    // callbackFieldsFromMeta can pick them up. (ingestInbound already flattens ALL metadata —
    // this pins the behavior the callback substrate depends on.)
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("worker");
    void t.start(ctx);
    void t.ingestInbound({
      id: "note-deleg-1",
      content: "do the sub-task",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: {
        channel: "worker",
        direction: "inbound",
        sender: "orchestrator",
        reply_to: "orchestrator",
        correlation_id: "corr-1",
        delegation_depth: "2",
      },
    });
    expect(ctx.emitted).toHaveLength(1);
    const m = ctx.emitted[0]!.meta;
    expect(m.reply_to).toBe("orchestrator");
    expect(m.correlation_id).toBe("corr-1");
    expect(m.delegation_depth).toBe("2"); // string-valued, as the vault stores it.
  });

  // ── roles×threads NOW slice: subject on the inbound carrier ──────────────────
  test("NULL-SUBJECT INVARIANT: a note with NO subject → emitted meta has NO `subject` key (byte-identical to HEAD)", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("eng");
    void t.start(ctx);
    void t.ingestInbound({
      id: "note-nosubj",
      content: "the weave digest please",
      tags: ["agent/message", "agent/message/inbound"],
      // The weave path: no subject anywhere.
      metadata: { agent: "eng", direction: "inbound", sender: "runner:weave", ts: "2026-06-28T00:00:00Z" },
    });
    expect(ctx.emitted).toHaveLength(1);
    const m = ctx.emitted[0]!.meta;
    expect("subject" in m).toBe(false);
    expect(m.subject).toBeUndefined();
  });

  test("a note WITH a subject → surfaces it on the emitted meta", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("pm");
    void t.start(ctx);
    void t.ingestInbound({
      id: "note-subj",
      content: "status on the launch",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "pm", direction: "inbound", sender: "aaron", subject: "launch-blockers" },
    });
    expect(ctx.emitted).toHaveLength(1);
    expect(ctx.emitted[0]!.meta.subject).toBe("launch-blockers");
  });

  test("an EMPTY / whitespace subject → NO `subject` key (absent and blank are indistinguishable downstream)", () => {
    const t = new VaultTransport(baseConfig());
    const ctx = fakeCtx("pm");
    void t.start(ctx);
    void t.ingestInbound({
      id: "note-blanksubj",
      content: "x",
      tags: ["agent/message", "agent/message/inbound"],
      metadata: { agent: "pm", direction: "inbound", subject: "   " },
    });
    expect(ctx.emitted).toHaveLength(1);
    expect("subject" in ctx.emitted[0]!.meta).toBe(false);
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

    // Namespace ROOT `agent` — no parent_names, just a description. A single bare
    // segment needs no percent-encoding.
    const root = calls[0]!;
    expect(root.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/agent",
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

    // Definition (NEW) — name carries `/`; rolls up to the namespace root.
    const def = calls[1]!;
    expect(def.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/agent%2Fdefinition",
    );
    expect(decodeURIComponent(def.url.split("/api/tags/")[1]!)).toBe("agent/definition");
    const defBody = JSON.parse(String(def.init.body)) as { parent_names?: string[] };
    expect(defBody.parent_names).toEqual(["agent"]);

    // Message parent (NEW) — rolls up to the namespace root.
    const parent = calls[2]!;
    expect(parent.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/agent%2Fmessage",
    );
    const parentBody = JSON.parse(String(parent.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(parentBody.description).toBe(
      "A message in a Parachute channel (parent of /inbound + /outbound).",
    );
    expect(parentBody.parent_names).toEqual(["agent"]);

    // Inbound child (NEW) — name carries `/`. The vault route matches a
    // single path segment (`[^/]+`) then decodeURIComponent's it, so the `/` MUST
    // be encoded as `%2F` (a bare slash would fail the single-segment match → 404).
    const inbound = calls[3]!;
    expect(inbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/agent%2Fmessage%2Finbound",
    );
    // Confirm the encoding decodes back to the literal tag name the vault stores.
    const encodedSegment = inbound.url.split("/api/tags/")[1]!;
    expect(decodeURIComponent(encodedSegment)).toBe("agent/message/inbound");
    const inboundBody = JSON.parse(String(inbound.init.body)) as {
      description?: string;
      parent_names?: string[];
    };
    expect(inboundBody.parent_names).toEqual(["agent/message"]);
    expect(inboundBody.description).toBe(
      "Human→session message; the vault trigger fires on this.",
    );

    // Outbound child (NEW) — same encoding, parent declared.
    const outbound = calls[4]!;
    expect(outbound.url).toBe(
      "http://127.0.0.1:1940/vault/default/api/tags/agent%2Fmessage%2Foutbound",
    );
    expect(decodeURIComponent(outbound.url.split("/api/tags/")[1]!)).toBe(
      "agent/message/outbound",
    );
    const outboundBody = JSON.parse(String(outbound.init.body)) as { parent_names?: string[] };
    expect(outboundBody.parent_names).toEqual(["agent/message"]);

    // Job (NEW) — rolls up to the namespace root.
    const job = calls[5]!;
    expect(decodeURIComponent(job.url.split("/api/tags/")[1]!)).toBe("agent/job");
    const jobBody = JSON.parse(String(job.init.body)) as { parent_names?: string[] };
    expect(jobBody.parent_names).toEqual(["agent"]);
  });

  test("schema declares ONLY the #agent/* namespace rollup (CONTRACT dropped interim + legacy, 7 entries)", async () => {
    // The `#agent/*` namespace (design 2026-06-17-vault-native-agents) rolls up
    // definitions, messages, jobs, AND threads to the `#agent` root. The channel→agent
    // CONTRACT dropped the interim flat `#agent-message*` AND legacy `#channel-message*`
    // schema entries — exactly 7 entries, all under `#agent/*`.
    const names = AGENT_VAULT_TAG_SCHEMA.map((e) => e.name);
    expect(names).toEqual([
      "agent",
      "agent/definition",
      "agent/message",
      "agent/message/inbound",
      "agent/message/outbound",
      "agent/job",
      "agent/thread",
    ]);
    // The interim/legacy families are gone entirely.
    expect(names).not.toContain("#agent-message");
    expect(names).not.toContain("#channel-message");
    // The namespace children all roll up to the `#agent` root (the human rollup).
    const byName = (n: string) => AGENT_VAULT_TAG_SCHEMA.find((e) => e.name === n)!;
    expect(byName("agent/definition").parent_names).toEqual(["agent"]);
    expect(byName("agent/message").parent_names).toEqual(["agent"]);
    expect(byName("agent/job").parent_names).toEqual(["agent"]);
    expect(byName("agent/thread").parent_names).toEqual(["agent"]);
    expect(byName("agent/message/inbound").parent_names).toEqual(["agent/message"]);
    expect(byName("agent/message/outbound").parent_names).toEqual(["agent/message"]);
    // `#agent/thread` declares INDEXED string fields so threads are operator-queryable —
    // "all failed threads" (status), "all threads of agent X" (definition), "all
    // multi-threaded threads" (mode). The three axes carry over from the run record VERBATIM.
    expect(byName("agent/thread").fields).toEqual({
      // The canonical `agent` routing-key alias is declared indexed.
      agent: { type: "string", indexed: true },
      status: { type: "string", indexed: true },
      definition: { type: "string", indexed: true },
      mode: { type: "string", indexed: true },
    });
    // `#agent/message` declares the indexed `agent` routing key.
    expect(byName("agent/message").fields).toEqual({
      agent: { type: "string", indexed: true },
    });
    // CONTRACT: `#agent/job` indexes the routing key under `agent` ONLY — no `channel`.
    expect(byName("agent/job").fields).toEqual({
      agent: { type: "string", indexed: true },
      enabled: { type: "string", indexed: true },
      lastStatus: { type: "string", indexed: true },
    });
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

  test("ensureSchema sends the indexed `fields` body for #agent/thread", async () => {
    let threadBody: { fields?: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const name = decodeURIComponent(String(url).split("/api/tags/")[1]!);
      if (name === AGENT_THREAD_TAG) threadBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(threadBody?.fields).toEqual({
      // Expand phase: the new `agent` routing-key alias is declared indexed (additive).
      agent: { type: "string", indexed: true },
      status: { type: "string", indexed: true },
      definition: { type: "string", indexed: true },
      mode: { type: "string", indexed: true },
    });
  });

  test("ensureSchema sends the indexed `fields` body for #agent/job (query by agent/enabled/lastStatus)", async () => {
    let jobBody: { fields?: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const name = decodeURIComponent(String(url).split("/api/tags/")[1]!);
      if (name === AGENT_JOB_TAG) jobBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.ensureSchema();

    expect(jobBody?.fields).toEqual({
      // CONTRACT: index the routing key under `agent` ONLY — no `channel`.
      agent: { type: "string", indexed: true },
      enabled: { type: "string", indexed: true },
      lastStatus: { type: "string", indexed: true },
    });
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

    // Override back to true — this test specifically exercises the
    // start()→ensureSchema fire-and-forget non-fatal path (#32).
    const t = new VaultTransport({ ...baseConfig(), declareSchemaOnStart: true });
    const ctx = fakeCtx("eng");
    await expect(t.start(ctx)).resolves.toBeUndefined();
    await flush(); // let the fire-and-forget ensureSchema settle (it must not reject globally)

    // Transport still delivers inbound after a failed schema declaration.
    void t.ingestInbound({
      id: "n1",
      content: "still works",
      tags: ["agent/message", "agent/message/inbound"],
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
    expect(body.tags).toEqual(["agent/message", "agent/message/inbound"]);
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
    expect(urls[0]).toContain("tag=agent%2Fjob");
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
    expect(body.tags).toEqual(["agent/job"]);
    expect(body.metadata.enabled).toBe("true");
    expect(body.metadata.jobId).toBe("m"); // slug persisted for stable display
    // CONTRACT: routing key under `metadata.agent` ONLY — no `channel`.
    expect(body.metadata.agent).toBe("eng");
    expect(body.metadata.channel).toBeUndefined();
    // NULL-SUBJECT INVARIANT: a job with no subject writes NO `subject` key (byte-identical to HEAD).
    expect("subject" in body.metadata).toBe(false);
  });

  test("upsertJobNote WITH a subject → persists metadata.subject; empty/whitespace → absent (roles×threads NOW slice)", async () => {
    const bodies: Array<{ metadata: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "x" }), { status: 201 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.upsertJobNote({ id: "s", message: "go", channel: "eng", cron: "0 9 * * *", enabled: true, createdAt: "t0", subject: "launch-blockers" });
    expect(bodies[0]!.metadata.subject).toBe("launch-blockers");
    await t.upsertJobNote({ id: "s2", message: "go", channel: "eng", cron: "0 9 * * *", enabled: true, createdAt: "t0", subject: "   " });
    expect("subject" in bodies[1]!.metadata).toBe(false);
  });

  test("listJobNotes reads metadata.subject back when present (roles×threads NOW slice)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: "n-subj", content: "go", metadata: { jobId: "withsubj", agent: "pm", cron: "0 9 * * *", enabled: "true", subject: "launch-blockers" } },
          { id: "n-nosubj", content: "go", metadata: { jobId: "nosubj", agent: "eng", cron: "0 9 * * *", enabled: "true" } },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const jobs = await t.listJobNotes();
    const withSubj = jobs.find((j) => j.id === "withsubj")!;
    const noSubj = jobs.find((j) => j.id === "nosubj")!;
    expect(withSubj.subject).toBe("launch-blockers");
    expect(noSubj.subject).toBeUndefined();
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
    const patchBody = JSON.parse(String(calls[0]!.init.body));
    expect(patchBody.metadata).toEqual({ lastRunAt: "t1", lastStatus: "ok" });
    // MUST carry the vault mutation precondition or the PATCH 428s (real-vault bug).
    expect(patchBody.force).toBe(true);
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

// ---------------------------------------------------------------------------
// Channel-queue inbound notes — FIX 3 (CAS claim) + FIX 6 (handled exclusion).
// ---------------------------------------------------------------------------

describe("VaultTransport — listInboundQueue", () => {
  test("FIX 6: EXCLUDES handled notes so pending is never crowded out past the cap", async () => {
    // The vault returns many `handled` notes plus one still-`pending` note. The handled
    // ones must be dropped client-side so the pending one is always in the returned queue.
    const handled = Array.from({ length: 50 }, (_, i) => ({
      id: `h${i}`,
      content: `handled ${i}`,
      metadata: { channel: "eng", direction: "inbound", sender: "operator", ts: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`, status: "handled" },
      updated_at: `2026-01-01T01:00:00Z`,
    }));
    const pending = {
      id: "p1",
      content: "still pending",
      metadata: { channel: "eng", direction: "inbound", sender: "operator", ts: "2026-01-02T00:00:00Z", status: "pending" },
      updated_at: "2026-01-02T00:00:00Z",
    };
    let listUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      // start() fires ensureSchema PUTs (.../api/tags/*); only capture the list GET.
      if (u.includes("/api/notes?")) {
        listUrl = u;
        return new Response(JSON.stringify([...handled, pending]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const queue = await t.listInboundQueue();
    // No handled notes survive; the pending one IS present.
    expect(queue.every((n) => n.status !== "handled")).toBe(true);
    expect(queue.map((n) => n.id)).toEqual(["p1"]);
    expect(queue[0]!.status).toBe("pending");
    // The list request asks the vault NEWEST-first (so a hard cap drops the oldest
    // handled notes, never a recent pending).
    expect(listUrl).toContain("sort=desc");
  });

  test("FIX 6: in-flight notes are KEPT (only handled is excluded)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: "a", content: "p", metadata: { channel: "eng", ts: "t1", status: "pending" }, updated_at: "u1" },
          { id: "b", content: "f", metadata: { channel: "eng", ts: "t2", status: "in-flight", claimedAt: "c2" }, updated_at: "u2" },
          { id: "c", content: "h", metadata: { channel: "eng", ts: "t3", status: "handled" }, updated_at: "u3" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const queue = await t.listInboundQueue();
    expect(queue.map((n) => n.id)).toEqual(["a", "b"]);
    expect(queue.find((n) => n.id === "b")!.status).toBe("in-flight");
  });

  test("FIX 3: threads the note's updated_at through as updatedAt (the CAS precondition)", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([
          { id: "n1", content: "hi", metadata: { channel: "eng", ts: "t1", status: "pending" }, updated_at: "2026-06-01T00:00:00Z" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.start(fakeCtx("eng"));
    const queue = await t.listInboundQueue();
    expect(queue[0]!.updatedAt).toBe("2026-06-01T00:00:00Z");
  });
});

describe("VaultTransport — setInboundStatus (FIX 3 compare-and-swap claim)", () => {
  test("with ifUpdatedAt: sends if_updated_at (NOT force) as the precondition", async () => {
    let body: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.setInboundStatus("n1", "in-flight", "2026-06-01T00:00:01Z", "2026-06-01T00:00:00Z");
    expect(body.if_updated_at).toBe("2026-06-01T00:00:00Z");
    expect(body.force).toBeUndefined();
    expect(body.metadata.status).toBe("in-flight");
    expect(body.metadata.claimedAt).toBe("2026-06-01T00:00:01Z");
  });

  test("without ifUpdatedAt: keeps the last-write-wins force:true (release/handled/sweep)", async () => {
    let body: any;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await t.setInboundStatus("n1", "handled", null);
    expect(body.force).toBe(true);
    expect(body.if_updated_at).toBeUndefined();
  });

  test("a 409 (stale precondition) on a CAS write throws InboundClaimConflictError", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error_type: "conflict" }), { status: 409 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await expect(
      t.setInboundStatus("n1", "in-flight", "now", "stale-updated-at"),
    ).rejects.toBeInstanceOf(InboundClaimConflictError);
  });

  test("a 428 (precondition required) on a CAS write also throws InboundClaimConflictError", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "precondition_required" }), { status: 428 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    await expect(
      t.setInboundStatus("n1", "in-flight", "now", "some-updated-at"),
    ).rejects.toBeInstanceOf(InboundClaimConflictError);
  });

  test("a 409 on a NON-CAS write (no ifUpdatedAt) throws a plain Error, not a conflict", async () => {
    globalThis.fetch = (async () =>
      new Response("conflict", { status: 409 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const err = await t.setInboundStatus("n1", "handled", null).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InboundClaimConflictError);
  });

  test("a 500 on a CAS write throws a plain Error (a real failure, not a lost race)", async () => {
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const t = new VaultTransport(baseConfig());
    const err = await t.setInboundStatus("n1", "in-flight", "now", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InboundClaimConflictError);
  });
});
