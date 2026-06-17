/**
 * No-silent-loss tests — the delivery high-water-mark + backlog replay that fix
 * a connected channel session silently going deaf after a daemon restart
 * (messages that arrive while nobody is subscribed are lost from the live wake,
 * though they stay durable in the vault).
 *
 * Layers exercised here (delivery-state unit coverage lives in delivery-state.test.ts):
 *  - replayBacklog: inbound-since-mark delivered ASCENDING + capped at REPLAY_CAP;
 *    outbound excluded; mark advances to the newest replayed ts; a SECOND call
 *    returns empty; a non-vault channel is skipped (0); a load failure → 0 (the
 *    connect never fails); a missing-ts message is skipped.
 *  - emit (via the live daemon /api/vault/inbound webhook): 0 subscribers → mark
 *    NOT advanced (so it replays later); ≥1 subscriber → mark advanced to the note ts.
 *  - MCP connect → backlog replayed to THAT session only (the _registerSessionForTest
 *    seam fires the connect hook installed by createFetchHandler).
 *  - SSE /events connect → backlog replayed onto the new stream.
 *  - END-TO-END deaf window: an inbound arrives with no subscriber (mark stays) →
 *    a session connects → the missed message is delivered exactly once.
 *
 * Auth: the same sentinel-token hub-jwt mock the other daemon tests use — a
 * `Bearer test-rw-token` validates with channel:read + write + send WITHOUT a live
 * hub/JWKS. The vault I/O is a REAL VaultTransport whose loadTranscript is
 * monkeypatched on the instance (the daemon branches on `instanceof VaultTransport`),
 * so NO real vault is touched.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

const RW_TOKEN = "test-rw-token"; // channel:read + write + send
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === RW_TOKEN) {
      // All scopes — the config-API hot-add (used to start a channel through the
      // daemon's OWN contextFor, so emit advances the mark) needs channel:admin.
      return { ...base, scopes: ["channel:read", "channel:write", "channel:send", "channel:admin"] };
    }
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import { createFetchHandler, replayBacklog, REPLAY_CAP, type ReplayMessage } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { DeliveryState } from "./delivery-state.ts";
import { VaultTransport, type ChannelMessage } from "./transports/vault.ts";
import { HttpUiTransport } from "./transports/http-ui.ts";
import type { Channel } from "./registry.ts";
import {
  _resetSessionsForTest,
  _registerSessionForTest,
  mcpSessionCount,
} from "./mcp-http.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const auth = { authorization: `Bearer ${RW_TOKEN}` };

/** A VaultTransport whose loadTranscript is stubbed on the instance (instanceof holds). */
function stubVault(channel: string, transcript: ChannelMessage[], loadThrows?: Error): VaultTransport {
  const t = new VaultTransport({ vault: "default", vaultUrl: "http://127.0.0.1:59999", token: "x" });
  (t as unknown as { ctx: { channel: string } }).ctx = { channel };
  t.loadTranscript = async () => {
    if (loadThrows) throw loadThrows;
    return transcript;
  };
  return t;
}

function vaultChannels(channel: string, transport: VaultTransport): Map<string, Channel> {
  return new Map([[channel, { name: channel, transport, entry: { name: channel, transport: "vault" } }]]);
}

let stateDir: string;
let prevStateDirEnv: string | undefined;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "channel-backlog-"));
  // Point the config-API hot-add's channels.json write (defaultStateDir reads the
  // env at request time) at the temp dir, so tests NEVER touch the real
  // ~/.parachute/channel/. The DeliveryState instances are also constructed with
  // this stateDir explicitly.
  prevStateDirEnv = process.env.PARACHUTE_CHANNEL_STATE_DIR;
  process.env.PARACHUTE_CHANNEL_STATE_DIR = stateDir;
  _resetSessionsForTest();
});
afterEach(() => {
  _resetSessionsForTest();
  if (prevStateDirEnv === undefined) delete process.env.PARACHUTE_CHANNEL_STATE_DIR;
  else process.env.PARACHUTE_CHANNEL_STATE_DIR = prevStateDirEnv;
  rmSync(stateDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// replayBacklog — the pure recovery primitive.
// ---------------------------------------------------------------------------

describe("replayBacklog", () => {
  const MARK = "2026-06-16T10:00:00.000Z";

  function dsAt(mark: string): DeliveryState {
    // A boot default OLDER than the messages so nothing is filtered by the default;
    // the per-channel mark we set drives the cut.
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("eng", mark);
    return ds;
  }

  test("delivers inbound-since-mark ascending; excludes outbound + at-or-before-mark; advances the mark", async () => {
    const transcript: ChannelMessage[] = [
      { id: "old", text: "before the mark", direction: "inbound", sender: "a", ts: "2026-06-16T09:59:00.000Z" },
      { id: "at", text: "exactly at the mark", direction: "inbound", sender: "a", ts: MARK },
      { id: "in1", text: "missed 1", direction: "inbound", sender: "a", ts: "2026-06-16T10:01:00.000Z" },
      { id: "out", text: "a reply", direction: "outbound", sender: "session", ts: "2026-06-16T10:02:00.000Z" },
      { id: "in2", text: "missed 2", direction: "inbound", sender: "a", ts: "2026-06-16T10:03:00.000Z" },
    ];
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);

    const got: ReplayMessage[] = [];
    const n = await replayBacklog(channels, ds, "eng", (m) => got.push(m));

    expect(n).toBe(2);
    // Ascending, inbound-only, strictly after the mark.
    expect(got.map((m) => m.content)).toEqual(["missed 1", "missed 2"]);
    // Replay carries the original ts + a replay marker + inbound direction.
    expect(got[0]!.meta.ts).toBe("2026-06-16T10:01:00.000Z");
    expect(got[0]!.meta.direction).toBe("inbound");
    expect(got[0]!.meta.replay).toBe("true");
    expect(got[0]!.meta.note_id).toBe("in1");
    // The mark advanced to the newest replayed ts.
    expect(ds.getLastDelivered("eng")).toBe("2026-06-16T10:03:00.000Z");
  });

  test("a SECOND replay (mark now caught up) returns empty", async () => {
    const transcript: ChannelMessage[] = [
      { id: "in1", text: "missed", direction: "inbound", sender: "a", ts: "2026-06-16T10:01:00.000Z" },
    ];
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);

    const first: ReplayMessage[] = [];
    expect(await replayBacklog(channels, ds, "eng", (m) => first.push(m))).toBe(1);
    const second: ReplayMessage[] = [];
    expect(await replayBacklog(channels, ds, "eng", (m) => second.push(m))).toBe(0);
    expect(second).toHaveLength(0);
  });

  test("caps at REPLAY_CAP, keeping the NEWEST", async () => {
    const transcript: ChannelMessage[] = [];
    const total = REPLAY_CAP + 10;
    for (let i = 0; i < total; i++) {
      // ts strictly increasing + all after the mark.
      const ts = `2026-06-16T11:00:${String(i).padStart(2, "0")}.000Z`;
      transcript.push({ id: `n${i}`, text: `m${i}`, direction: "inbound", sender: "a", ts });
    }
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);

    const got: ReplayMessage[] = [];
    const n = await replayBacklog(channels, ds, "eng", (m) => got.push(m));
    expect(n).toBe(REPLAY_CAP);
    // The NEWEST REPLAY_CAP were kept (the first 10 dropped).
    expect(got[0]!.content).toBe("m10");
    expect(got[got.length - 1]!.content).toBe(`m${total - 1}`);
    // The mark advanced to the very newest, so the dropped older ones never replay.
    expect(ds.getLastDelivered("eng")).toBe(`2026-06-16T11:00:${String(total - 1).padStart(2, "0")}.000Z`);
  });

  test("a non-vault channel is skipped (0, no throw)", async () => {
    const httpUi = new HttpUiTransport({ channel: "ui1" });
    const channels = new Map<string, Channel>([
      ["ui1", { name: "ui1", transport: httpUi, entry: { name: "ui1", transport: "http-ui" } }],
    ]);
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    let delivered = 0;
    expect(await replayBacklog(channels, ds, "ui1", () => { delivered++; })).toBe(0);
    expect(delivered).toBe(0);
  });

  test("a missing channel is skipped (0)", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    expect(await replayBacklog(new Map(), ds, "nope", () => {})).toBe(0);
  });

  test("a transcript load failure → 0 (the connect never fails); the mark is untouched", async () => {
    const t = stubVault("eng", [], new Error("vault unreachable"));
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);
    expect(await replayBacklog(channels, ds, "eng", () => {})).toBe(0);
    expect(ds.getLastDelivered("eng")).toBe(MARK); // unchanged — retried next connect
  });

  test("a missing-ts inbound message is skipped (can't be tracked by the mark)", async () => {
    const transcript: ChannelMessage[] = [
      { id: "no-ts", text: "no timestamp", direction: "inbound", sender: "a", ts: "" },
      { id: "in1", text: "good", direction: "inbound", sender: "a", ts: "2026-06-16T10:01:00.000Z" },
    ];
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);
    const got: ReplayMessage[] = [];
    expect(await replayBacklog(channels, ds, "eng", (m) => got.push(m))).toBe(1);
    expect(got.map((m) => m.content)).toEqual(["good"]);
  });

  test("if deliverOne throws mid-loop, the mark stops at the last DELIVERED ts (no false-mark)", async () => {
    // The advance-after-deliverOne ordering: a throw on the 2nd message must leave
    // the mark at the 1st message's ts, so the 2nd + 3rd replay on the next connect.
    const transcript: ChannelMessage[] = [
      { id: "in1", text: "first", direction: "inbound", sender: "a", ts: "2026-06-16T10:01:00.000Z" },
      { id: "in2", text: "second", direction: "inbound", sender: "a", ts: "2026-06-16T10:02:00.000Z" },
      { id: "in3", text: "third", direction: "inbound", sender: "a", ts: "2026-06-16T10:03:00.000Z" },
    ];
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const ds = dsAt(MARK);
    let count = 0;
    await expect(
      replayBacklog(channels, ds, "eng", () => {
        count++;
        if (count === 2) throw new Error("dead subscriber");
      }),
    ).rejects.toThrow("dead subscriber");
    // The 1st was delivered + marked; the throw on the 2nd aborted before its advance.
    expect(ds.getLastDelivered("eng")).toBe("2026-06-16T10:01:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// emit — the mark advances ONLY on a real delivery (via the live webhook).
// ---------------------------------------------------------------------------

describe("emit advances the mark only on real delivery (via /api/vault/inbound)", () => {
  test("≥1 SSE subscriber → mark advances to the note ts; 0 subscribers → mark stays", async () => {
    // We exercise the real emit by standing up the daemon, opening (or not) an SSE
    // subscriber, and POSTing the inbound webhook. The transport is started by the
    // daemon's hot-add so its ctx is the daemon's contextFor (the one that advances
    // the mark). loadTranscript is stubbed AFTER the hot-add.
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    const channels = new Map<string, Channel>();
    const registry = new ClientRegistry();
    const handler = createFetchHandler(channels, registry, { deliveryState: ds });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handler });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // Hot-add a vault channel through the config API so the daemon starts its
      // transport with ITS contextFor (the emit that advances the mark). We then
      // stub loadTranscript on the live instance + neutralize the network write.
      const addRes = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          name: "eng",
          transport: "vault",
          config: { vault: "default", vaultUrl: "http://127.0.0.1:59999", token: "x" },
        }),
      });
      expect([200, 201]).toContain(addRes.status);
      const live = channels.get("eng")!.transport as VaultTransport;
      live.loadTranscript = async () => [];

      // --- 0 subscribers: post the inbound webhook; the mark must NOT advance. ---
      const ts0 = "2026-06-16T10:00:00.000Z";
      const r0 = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          note: { id: "note-0", content: "deaf", tags: ["#channel-message/inbound"], metadata: { channel: "eng", ts: ts0, direction: "inbound" } },
        }),
      });
      expect(r0.status).toBe(200);
      // No subscriber → emit delivered to 0 → mark stayed at the boot default.
      expect(ds.getLastDelivered("eng")).toBe("2026-01-01T00:00:00.000Z");

      // --- ≥1 subscriber: open an SSE stream, then post a newer inbound. ---
      const evRes = await fetch(`${base}/events?channel=eng&token=${RW_TOKEN}`, { headers: auth });
      expect(evRes.status).toBe(200);
      const reader = evRes.body!.getReader();
      // Drain the ": connected" preamble so the registry add has happened.
      await reader.read();

      const ts1 = "2026-06-16T10:05:00.000Z";
      const r1 = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          note: { id: "note-1", content: "heard", tags: ["#channel-message/inbound"], metadata: { channel: "eng", ts: ts1, direction: "inbound" } },
        }),
      });
      expect(r1.status).toBe(200);
      // Delivered to ≥1 subscriber → mark advanced to the note ts.
      expect(ds.getLastDelivered("eng")).toBe(ts1);

      await reader.cancel();
    } finally {
      srv.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// MCP connect hook → replay to THAT session only.
// ---------------------------------------------------------------------------

describe("MCP connect replays the backlog to the new session only", () => {
  function capture() {
    const notes: Array<{ method: string; params: unknown }> = [];
    const server = { notification: (n: unknown) => notes.push(n as { method: string; params: unknown }) };
    const wakes = () => notes.filter((n) => n.method === "notifications/claude/channel");
    return { server, notes, wakes };
  }

  test("a newly-registered MCP session is pushed its missed backlog; an EXISTING session is not re-woken", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("eng", "2026-06-16T10:00:00.000Z");
    const t = stubVault("eng", []);
    const channels = vaultChannels("eng", t);
    const registry = new ClientRegistry();
    // Building the handler installs setOnSessionConnect → replayBacklog (fire-and-forget).
    createFetchHandler(channels, registry, { deliveryState: ds });

    // Phase 1: an existing session connects with NO pending backlog (transcript
    // empty) — its connect-replay delivers nothing and leaves the mark at 10:00.
    const existing = capture();
    _registerSessionForTest("eng", "sid-existing", existing.server as never, ["channel:read"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(existing.wakes()).toHaveLength(0); // nothing pending at its connect

    // Phase 2: a NEW inbound is now pending in the vault (mark still 10:00).
    t.loadTranscript = async () => [
      { id: "in-new", text: "newly missed", direction: "inbound", sender: "a", ts: "2026-06-16T10:05:00.000Z" },
    ];

    // A FRESH session connects → its connect-replay pushes the pending message to IT.
    const fresh = capture();
    _registerSessionForTest("eng", "sid-fresh", fresh.server as never, ["channel:read"]);
    await new Promise((r) => setTimeout(r, 20));

    expect(mcpSessionCount("eng")).toBe(2);
    // The fresh session received exactly the pending message.
    expect(fresh.wakes()).toHaveLength(1);
    expect((fresh.wakes()[0]!.params as { content: string }).content).toBe("newly missed");
    // The existing session was NOT re-woken — replay targets the connector only.
    expect(existing.wakes()).toHaveLength(0);
    // Mark advanced past the replayed message → a third connect replays nothing.
    expect(ds.getLastDelivered("eng")).toBe("2026-06-16T10:05:00.000Z");
  });

  test("a STREAMLESS session does not replay or advance the mark (it waits for its GET stream)", async () => {
    // A session that registered but never opened its GET push stream is not
    // deliverable; replay must NOT fire for it (firing would push into the void and
    // advance the mark past a message nobody received — the silent-loss bug). The
    // backlog stays pending until the session opens its stream.
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("eng", "2026-06-16T10:00:00.000Z");
    const t = stubVault("eng", [
      { id: "in-pending", text: "still here?", direction: "inbound", sender: "a", ts: "2026-06-16T10:05:00.000Z" },
    ]);
    const channels = vaultChannels("eng", t);
    const registry = new ClientRegistry();
    createFetchHandler(channels, registry, { deliveryState: ds });

    const streamless = capture();
    _registerSessionForTest("eng", "sid-streamless", streamless.server as never, ["channel:read"], {
      streamless: true,
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(mcpSessionCount("eng")).toBe(1); // registered…
    expect(streamless.wakes()).toHaveLength(0); // …but got no replay
    expect(ds.getLastDelivered("eng")).toBe("2026-06-16T10:00:00.000Z"); // mark held — message still pending
  });
});

// ---------------------------------------------------------------------------
// SSE connect hook → replay onto the new stream.
// ---------------------------------------------------------------------------

describe("SSE /events connect replays the backlog onto the new stream", () => {
  test("a reconnecting bridge gets its missed inbound as message frames", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    ds.advance("eng", "2026-06-16T10:00:00.000Z");
    const transcript: ChannelMessage[] = [
      { id: "in1", text: "missed A", direction: "inbound", sender: "a", ts: "2026-06-16T10:01:00.000Z" },
      { id: "in2", text: "missed B", direction: "inbound", sender: "a", ts: "2026-06-16T10:02:00.000Z" },
    ];
    const t = stubVault("eng", transcript);
    const channels = vaultChannels("eng", t);
    const registry = new ClientRegistry();
    const handler = createFetchHandler(channels, registry, { deliveryState: ds });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handler });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(`${base}/events?channel=eng&token=${RW_TOKEN}`, { headers: auth });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Read until we've seen both replayed frames (or a couple of chunks).
      for (let i = 0; i < 5 && !(buf.includes("missed A") && buf.includes("missed B")); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(buf).toContain("event: message");
      expect(buf).toContain("missed A");
      expect(buf).toContain("missed B");
      // The mark advanced to the newest replayed ts.
      expect(ds.getLastDelivered("eng")).toBe("2026-06-16T10:02:00.000Z");
      await reader.cancel();
    } finally {
      srv.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// END-TO-END deaf window — the headline scenario.
// ---------------------------------------------------------------------------

describe("end-to-end deaf window", () => {
  test("inbound with no subscriber (mark stays) → session connects → the missed message is delivered once", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-06-16T09:00:00.000Z" });
    const channels = new Map<string, Channel>();
    const registry = new ClientRegistry();
    const handler = createFetchHandler(channels, registry, { deliveryState: ds });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handler });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // Bring up a vault channel through the daemon's own hot-add (so emit uses the
      // daemon's contextFor). The vault's transcript is what a later connect replays.
      const addRes = await fetch(`${base}/api/channels`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          name: "eng",
          transport: "vault",
          config: { vault: "default", vaultUrl: "http://127.0.0.1:59999", token: "x" },
        }),
      });
      expect([200, 201]).toContain(addRes.status);
      const live = channels.get("eng")!.transport as VaultTransport;

      // The missed message — durable in the "vault" (our stubbed transcript), and
      // arriving via the webhook with NO subscriber present.
      const missedTs = "2026-06-16T10:00:00.000Z";
      live.loadTranscript = async () => [
        { id: "note-deaf", text: "are you there?", direction: "inbound", sender: "aaron", ts: missedTs },
      ];

      // Inbound arrives while nobody is subscribed → emit delivers to 0 → mark stays.
      const wh = await fetch(`${base}/api/vault/inbound`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          note: { id: "note-deaf", content: "are you there?", tags: ["#channel-message/inbound"], metadata: { channel: "eng", ts: missedTs, sender: "aaron", direction: "inbound" } },
        }),
      });
      expect(wh.status).toBe(200);
      expect(ds.getLastDelivered("eng")).toBe("2026-06-16T09:00:00.000Z"); // mark held — message is pending

      // Now a session connects (SSE) → it replays the missed message.
      const res = await fetch(`${base}/events?channel=eng&token=${RW_TOKEN}`, { headers: auth });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (let i = 0; i < 5 && !buf.includes("are you there?"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      expect(buf).toContain("are you there?");
      // Mark caught up → a SECOND connect replays nothing (delivered exactly once).
      expect(ds.getLastDelivered("eng")).toBe(missedTs);
      await reader.cancel();

      const res2 = await fetch(`${base}/events?channel=eng&token=${RW_TOKEN}`, { headers: auth });
      const reader2 = res2.body!.getReader();
      const first = await reader2.read(); // just the ": connected" preamble
      const text = decoder.decode(first.value);
      expect(text).not.toContain("are you there?");
      await reader2.cancel();
    } finally {
      srv.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// turn-events SSE auth — a browser EventSource cannot send an Authorization
// header, so the live-streaming SSE MUST authenticate via ?token=. Regression
// guard for the allowQueryParam bug: the handler defaulted to header-only, which
// 401'd every browser EventSource connection → the live view never opened.
// ---------------------------------------------------------------------------

describe("turn-events SSE authenticates via ?token= (browser EventSource has no Bearer)", () => {
  test("GET /api/channels/<ch>/turn-events?token= with NO Authorization header → 200 text/event-stream", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    const t = stubVault("eng", []);
    const channels = vaultChannels("eng", t);
    const handler = createFetchHandler(channels, new ClientRegistry(), { deliveryState: ds });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handler });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // NO `headers: auth` — only the query-param token, exactly as a browser
      // EventSource sends it. Without allowQueryParam=true on the handler this 401s.
      const res = await fetch(`${base}/api/channels/eng/turn-events?token=${RW_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(": connected");
      await reader.cancel();
    } finally {
      srv.stop(true);
    }
  });

  test("turn-events with neither Authorization header nor ?token= → 401", async () => {
    const ds = new DeliveryState({ stateDir, defaultMark: "2026-01-01T00:00:00.000Z" });
    const channels = vaultChannels("eng", stubVault("eng", []));
    const handler = createFetchHandler(channels, new ClientRegistry(), { deliveryState: ds });
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: handler });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const res = await fetch(`${base}/api/channels/eng/turn-events`);
      expect(res.status).toBe(401);
    } finally {
      srv.stop(true);
    }
  });
});
