/**
 * In-page terminal tests — the WS↔pty relay (`createTerminalWsHandlers`,
 * `parseControlFrame`, src/terminal.ts) + the daemon-side terminal upgrade gate
 * (`authorizeTerminalUpgrade`, src/daemon.ts).
 *
 * The relay tests drive the handler set against a FAKE `ServerWebSocket` and the
 * injectable `spawnTerminal` seam — no real tmux, no real pty, no `Bun.serve`.
 * The fake socket exposes a settable `getBufferedAmount()` so we can simulate
 * the hub's send-buffer filling under a flood and assert the flow-control
 * contract (the load-bearing item): a flood PARKS in the daemon-side coalesce
 * queue, the socket is NOT closed, and output resumes (drains) once the client
 * catches up. The hub's blunt 8 MiB cap therefore never has to fire.
 *
 * The auth tests call the pure `authorizeTerminalUpgrade` directly, using the
 * same sentinel-token `mock.module("./hub-jwt.ts")` harness daemon-config-api.
 * test.ts uses — accept paths run without a live hub/JWKS; the no-token reject
 * still hits the real short-circuit.
 */
import { describe, test, expect, mock } from "bun:test";
import type { ServerWebSocket } from "bun";

// Sentinel tokens → fixed scope sets. Mirrors daemon-config-api.test.ts so this
// process-wide mock stays compatible. ADMIN_TOKEN carries channel:admin (==
// SCOPE_TERMINAL); READ_TOKEN is under-scoped; anything else throws (bad token).
const ADMIN_TOKEN = "test-admin-token"; // channel:admin (== SCOPE_TERMINAL)
const READ_TOKEN = "test-read-token"; // channel:read only (insufficient)
import { HubJwtError, looksLikeJwt } from "@openparachute/scope-guard";
mock.module("./hub-jwt.ts", () => ({
  CHANNEL_AUDIENCE: "channel",
  async validateHubJwt(token: string) {
    const base = { sub: "test", aud: "channel", jti: undefined, clientId: undefined, vaultScope: undefined };
    if (token === ADMIN_TOKEN) return { ...base, scopes: ["channel:read", "channel:send", "channel:admin"] };
    if (token === READ_TOKEN) return { ...base, scopes: ["channel:read"] };
    throw new HubJwtError("issuer", "invalid token");
  },
  HubJwtError,
  looksLikeJwt,
  resetJwksCache() {},
  resetRevocationCache() {},
}));

import {
  createTerminalWsHandlers,
  parseControlFrame,
  HUB_WS_CAP_BYTES,
  PAUSE_FRAC,
  RESUME_FRAC,
  type TerminalWsData,
  type SpawnTerminalFn,
  type SpawnedTerminal,
  type BunTerminal,
} from "./terminal.ts";
import { authorizeTerminalUpgrade } from "./daemon.ts";
import type { Channel } from "./registry.ts";

// ===========================================================================
// Fakes — a recording pty + a controllable ServerWebSocket.
// ===========================================================================

/** A fake pty that records writes/resizes and lets the test push pty output. */
class FakePty implements BunTerminal {
  writes: Uint8Array[] = [];
  writeStrings: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  closed = false;
  /** Captured callbacks from the spawn opts — the test drives pty output via these. */
  onData!: (bytes: Uint8Array) => void;
  onExit!: () => void;

  write(data: string | ArrayBufferView | ArrayBufferLike): number {
    if (typeof data === "string") {
      this.writeStrings.push(data);
      return data.length;
    }
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBufferLike);
    this.writes.push(u8);
    return u8.byteLength;
  }
  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }
  close(): void {
    this.closed = true;
  }
}

interface FakeProc {
  readonly exited: Promise<number>;
  killed: boolean;
  kill(signal?: number | string): void;
}

/** A fake ServerWebSocket: records sends/close, settable buffered depth. */
class FakeWs {
  data: TerminalWsData;
  sent: Uint8Array[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  /** Test sets this to simulate the hub send-buffer depth. */
  buffered = 0;

  constructor(data: TerminalWsData) {
    this.data = data;
  }
  send(bytes: Uint8Array | string): number {
    if (typeof bytes === "string") {
      this.sent.push(new TextEncoder().encode(bytes));
      return bytes.length;
    }
    this.sent.push(bytes);
    return bytes.byteLength;
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
  get totalSentBytes(): number {
    return this.sent.reduce((n, b) => n + b.byteLength, 0);
  }
}

/** Build a fake-pty spawn seam; returns the seam + a handle on the created pty. */
function makeSpawn(): { spawn: SpawnTerminalFn; ptyRef: { current?: FakePty }; procRef: { current?: FakeProc } } {
  const ptyRef: { current?: FakePty } = {};
  const procRef: { current?: FakeProc } = {};
  const spawn: SpawnTerminalFn = (_session, opts) => {
    const pty = new FakePty();
    pty.onData = opts.onData;
    pty.onExit = opts.onExit;
    const proc: FakeProc = { exited: Promise.resolve(0), killed: false, kill() { this.killed = true; } };
    ptyRef.current = pty;
    procRef.current = proc;
    return { terminal: pty, proc } as unknown as SpawnedTerminal;
  };
  return { spawn, ptyRef, procRef };
}

function wsData(over: Partial<TerminalWsData> = {}): TerminalWsData {
  return { session: "eng-agent", channel: "eng", cols: 80, rows: 24, ...over };
}

/** Open a handler set + fake ws + fake pty, returning the lot for a test. */
function setup(opts: { capBytes?: number } = {}) {
  const { spawn, ptyRef, procRef } = makeSpawn();
  const warnings: string[] = [];
  const handlers = createTerminalWsHandlers({
    spawnTerminal: spawn,
    capBytes: opts.capBytes,
    logger: { warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")) },
  });
  const ws = new FakeWs(wsData());
  handlers.open(ws as unknown as ServerWebSocket<TerminalWsData>);
  return { handlers, ws, pty: () => ptyRef.current!, proc: () => procRef.current!, warnings };
}

// Cast helper — drive a handler with the fake ws.
const asWs = (ws: FakeWs) => ws as unknown as ServerWebSocket<TerminalWsData>;

// ===========================================================================
// parseControlFrame — unit cases
// ===========================================================================
describe("parseControlFrame", () => {
  test("a valid resize frame parses + clamps", () => {
    expect(parseControlFrame(JSON.stringify({ type: "resize", cols: 120, rows: 40 }))).toEqual({
      type: "resize",
      cols: 120,
      rows: 40,
    });
  });

  test("out-of-range dims clamp to [1, 9999]", () => {
    expect(parseControlFrame(JSON.stringify({ type: "resize", cols: 0, rows: 999999 }))).toEqual({
      type: "resize",
      cols: 1,
      rows: 9999,
    });
  });

  test("malformed JSON → null (forwarded as input by the caller)", () => {
    expect(parseControlFrame("{not json")).toBeNull();
  });

  test("a non-resize control type → null", () => {
    expect(parseControlFrame(JSON.stringify({ type: "evil", cmd: "rm -rf /" }))).toBeNull();
  });

  test("resize with non-finite dims → null", () => {
    expect(parseControlFrame(JSON.stringify({ type: "resize", cols: "80", rows: NaN }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ type: "resize" }))).toBeNull();
  });

  test("a bare JSON scalar / array (not an object) → null", () => {
    expect(parseControlFrame("42")).toBeNull();
    expect(parseControlFrame("null")).toBeNull();
    expect(parseControlFrame("[1,2,3]")).toBeNull();
  });
});

// ===========================================================================
// Relay — both directions
// ===========================================================================
describe("relay — pty ↔ ws", () => {
  test("pty output → ws.send (binary), bytes preserved", () => {
    const { ws, pty } = setup();
    const chunk = new Uint8Array([0x68, 0x69]); // "hi"
    pty().onData(chunk);
    expect(ws.sent).toHaveLength(1);
    expect(Array.from(ws.sent[0]!)).toEqual([0x68, 0x69]);
  });

  test("ws binary message → terminal.write (keystrokes to the pty)", () => {
    const { handlers, ws, pty } = setup();
    const keys = Buffer.from("ls\n");
    handlers.message(asWs(ws), keys);
    expect(pty().writes).toHaveLength(1);
    expect(Buffer.from(pty().writes[0]!).toString()).toBe("ls\n");
  });

  test("a text frame that ISN'T a control frame is forwarded to the pty as input (fail-safe)", () => {
    const { handlers, ws, pty } = setup();
    handlers.message(asWs(ws), "plain text");
    expect(pty().writeStrings).toEqual(["plain text"]);
    expect(pty().resizes).toHaveLength(0);
  });
});

// ===========================================================================
// Control frame — resize
// ===========================================================================
describe("control frame — resize", () => {
  test("a {type:resize} text frame → terminal.resize(cols, rows), NOT written as input", () => {
    const { handlers, ws, pty } = setup();
    handlers.message(asWs(ws), JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(pty().resizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(pty().writes).toHaveLength(0);
    expect(pty().writeStrings).toHaveLength(0);
  });
});

// ===========================================================================
// THE load-bearing test — backpressure flood stays alive
// ===========================================================================
describe("backpressure — a flood parks in the queue, never closes the socket", () => {
  // A tiny cap so the test floods it cheaply. pause @ 50% (500), resume @ 25% (250).
  const CAP = 1000;

  test("a huge burst while the socket buffer is high → paused + coalesced, socket NOT closed, hub cap never approached", () => {
    const { ws, pty, proc } = setup({ capBytes: CAP });

    // Simulate the hub's send buffer already full (over the pause mark) and never
    // draining during the burst — exactly the "a build log floods xterm" case.
    ws.buffered = CAP; // 1000 ≥ pauseAt(500)

    // First chunk goes out, then the post-send buffered check trips pause.
    pty().onData(new Uint8Array(64));
    // Subsequent chunks while paused MUST queue, not send.
    const FLOOD_CHUNK = new Uint8Array(64 * 1024); // 64 KiB each
    for (let i = 0; i < 200; i++) pty().onData(FLOOD_CHUNK); // ~12.8 MiB of pty output

    // The socket is ALIVE — no close (no 1011, no 1013), pty alive, proc alive.
    expect(ws.closeCalls).toHaveLength(0);
    expect(pty().closed).toBe(false);
    expect(proc().killed).toBe(false);

    // Our OWN buffered bytes (what the hub sees) never grew past the one chunk we
    // sent before pausing — the flood parked daemon-side, NOT in the hub buffer.
    // i.e. we never let the socket approach the 8 MiB hub cap.
    expect(ws.totalSentBytes).toBeLessThanOrEqual(64);
    expect(ws.totalSentBytes).toBeLessThan(HUB_WS_CAP_BYTES);
  });

  test("when the client drains, the queued flood is eventually delivered (resume)", () => {
    const { handlers, ws, pty } = setup({ capBytes: CAP });

    ws.buffered = CAP; // over pause mark
    pty().onData(new Uint8Array(64)); // sent → then pause
    // Queue a bounded flood (well under MAX_QUEUE_BYTES so it parks, not closes).
    const N = 50;
    const CHUNK = 64; // bytes
    for (let i = 0; i < N; i++) pty().onData(new Uint8Array(CHUNK).fill(i));
    expect(ws.closeCalls).toHaveLength(0);
    const sentBeforeDrain = ws.sent.length;

    // Client catches up: buffer empties. Bun fires drain repeatedly as it clears;
    // drain flushes the queue while buffered stays under the pause mark.
    ws.buffered = 0;
    // A few drain cycles to flush the whole queue (flushQueue drains until empty
    // or the pause mark; with buffered=0 it empties in one pass, but loop to be safe).
    for (let i = 0; i < 5 && ws.sent.length < sentBeforeDrain + N; i++) {
      handlers.drain(asWs(ws));
    }

    // Everything queued got delivered — the flood was buffered, not dropped.
    expect(ws.sent.length).toBe(sentBeforeDrain + N);
    expect(ws.closeCalls).toHaveLength(0);
    // And the very last queued chunk arrived intact (content preserved through the queue).
    const last = ws.sent[ws.sent.length - 1]!;
    expect(last.byteLength).toBe(CHUNK);
    expect(last[0]).toBe(N - 1);
  });
});

// ===========================================================================
// Hysteresis — pause @ 50%, resume only under 25%
// ===========================================================================
describe("hysteresis — pause @ PAUSE_FRAC, resume only under RESUME_FRAC", () => {
  const CAP = 1000; // pauseAt = 500, resumeAt = 250

  test("constants are 0.5 / 0.25 (the documented margins)", () => {
    expect(PAUSE_FRAC).toBe(0.5);
    expect(RESUME_FRAC).toBe(0.25);
  });

  test("does NOT pause while buffered stays under the pause mark", () => {
    const { ws, pty } = setup({ capBytes: CAP });
    ws.buffered = 400; // < pauseAt(500)
    pty().onData(new Uint8Array(10));
    pty().onData(new Uint8Array(10)); // still forwarded, not queued
    expect(ws.sent).toHaveLength(2);
    expect(ws.closeCalls).toHaveLength(0);
  });

  test("pauses at the 50% mark; a drain to BETWEEN resume(25%) and pause(50%) does NOT resume", () => {
    const { handlers, ws, pty } = setup({ capBytes: CAP });
    ws.buffered = 500; // == pauseAt → pause after the send
    pty().onData(new Uint8Array(10));
    // Now paused: a new pty chunk queues rather than sends.
    pty().onData(new Uint8Array(10));
    expect(ws.sent).toHaveLength(1); // only the first went out

    // Drain partway — buffer at 300 (still > resumeAt 250). Queue flushes only if
    // under the pause mark (300 < 500 so it flushes), but we stay PAUSED for live
    // forwarding because we're not yet under the resume mark.
    ws.buffered = 300;
    handlers.drain(asWs(ws));
    // A fresh live chunk should STILL queue (paused), proving no premature resume.
    const sentAfterDrain = ws.sent.length;
    pty().onData(new Uint8Array(10));
    expect(ws.sent.length).toBe(sentAfterDrain); // still paused → queued, not sent
  });

  test("resumes only once buffered falls under the 25% mark (and the queue is empty)", () => {
    const { handlers, ws, pty } = setup({ capBytes: CAP });
    ws.buffered = 600; // pause
    pty().onData(new Uint8Array(10));
    pty().onData(new Uint8Array(10)); // queued

    // Drain fully under the resume mark → drain flushes the queue + resumes.
    ws.buffered = 100; // < resumeAt(250)
    handlers.drain(asWs(ws));
    // Now resumed: a new live chunk forwards immediately.
    const before = ws.sent.length;
    pty().onData(new Uint8Array(10));
    expect(ws.sent.length).toBe(before + 1);
  });
});

// ===========================================================================
// 1013 — a hopelessly-stuck client is shed
// ===========================================================================
describe("stuck client — closed 1013 when the queue blows past MAX_QUEUE_BYTES", () => {
  // Keep the hub cap tiny so we pause immediately; the queue cap (16 MiB) is the
  // line under test. Flood past 16 MiB while the socket never drains.
  const CAP = 1000;

  test(">16 MiB queued while the socket stays full → close(1013), pty + viewer torn down", () => {
    const { ws, pty, proc, warnings } = setup({ capBytes: CAP });
    ws.buffered = CAP; // perpetually over the pause mark → everything queues
    pty().onData(new Uint8Array(64)); // first send trips pause

    // 17 MiB in 1 MiB chunks — crosses the 16 MiB MAX_QUEUE_BYTES line.
    const MiB = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 17; i++) pty().onData(MiB);

    const closed1013 = ws.closeCalls.find((c) => c.code === 1013);
    expect(closed1013).toBeDefined();
    expect(pty().closed).toBe(true); // pty closed
    expect(proc().killed).toBe(true); // viewer process killed
    expect(warnings.some((w) => w.includes("too far behind") || w.includes("too slow"))).toBe(true);
  });
});

// ===========================================================================
// Lifecycle — pty exit + client close tear down the viewer (session lives on)
// ===========================================================================
describe("lifecycle — teardown", () => {
  test("pty exit closes the socket with a clean 1000 (session ended)", () => {
    const { ws, pty, proc } = setup();
    pty().onExit();
    expect(ws.closeCalls.some((c) => c.code === 1000)).toBe(true);
    expect(pty().closed).toBe(true);
    expect(proc().killed).toBe(true);
  });

  test("client close releases the pty + kills the viewer proc (idempotent)", () => {
    const { handlers, ws, pty, proc } = setup();
    handlers.close(asWs(ws));
    expect(pty().closed).toBe(true);
    expect(proc().killed).toBe(true);
    // Idempotent — a second close is a no-op (no throw, no double behavior change).
    expect(() => handlers.close(asWs(ws))).not.toThrow();
  });
});

// ===========================================================================
// Daemon-side terminal auth — authorizeTerminalUpgrade (pure fn)
// ===========================================================================
describe("authorizeTerminalUpgrade — operator-gated channel:admin", () => {
  function channels(names: string[] = ["eng"]): Map<string, Channel> {
    const m = new Map<string, Channel>();
    for (const name of names) {
      m.set(name, { name, transport: {} as Channel["transport"], entry: { name, transport: "vault" } });
    }
    return m;
  }
  function req(query = ""): { req: Request; url: URL } {
    const url = new URL(`http://127.0.0.1/terminal/eng${query}`);
    return { req: new Request(url, { headers: { upgrade: "websocket" } }), url };
  }

  test("missing token → reject (401), no session leaked", async () => {
    const { req: r, url } = req();
    const d = await authorizeTerminalUpgrade(r, url, channels(), "eng");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.response.status).toBe(401);
  });

  test("bad/expired token → reject (401)", async () => {
    const { req: r, url } = req("?token=garbage-not-a-real-jwt");
    const d = await authorizeTerminalUpgrade(r, url, channels(), "eng");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.response.status).toBe(401);
  });

  test("under-scoped token (channel:read, not channel:admin) → reject (403)", async () => {
    const { req: r, url } = req(`?token=${READ_TOKEN}`);
    const d = await authorizeTerminalUpgrade(r, url, channels(), "eng");
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.response.status).toBe(403);
  });

  test("valid channel:admin token → ok, with the right tmux session + geometry", async () => {
    const { req: r, url } = req(`?token=${ADMIN_TOKEN}&cols=120&rows=40`);
    const d = await authorizeTerminalUpgrade(r, url, channels(), "eng");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.channel).toBe("eng");
      expect(d.session).toBe("eng-agent"); // <name>-agent (launch-session.sh:38)
      expect(d.cols).toBe(120);
      expect(d.rows).toBe(40);
    }
  });

  test("geometry defaults (80×24) when cols/rows absent or out-of-range", async () => {
    const { req: r, url } = req(`?token=${ADMIN_TOKEN}&cols=0&rows=abc`);
    const d = await authorizeTerminalUpgrade(r, url, channels(), "eng");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.cols).toBe(80);
      expect(d.rows).toBe(24);
    }
  });

  test("an agent name that isn't a configured channel is ACCEPTED → its session (agents have own names)", async () => {
    // The terminal attaches to an AGENT (tmux <name>-agent), not a channel — so a
    // valid-slug name that isn't in the channel map is accepted (a non-existent
    // session just fails to attach downstream with a clean 1000, no 404 here).
    const url = new URL(`http://127.0.0.1/terminal/weaver?token=${ADMIN_TOKEN}`);
    const r = new Request(url, { headers: { upgrade: "websocket" } });
    const d = await authorizeTerminalUpgrade(r, url, channels(["eng"]), "weaver");
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.session).toBe("weaver-agent");
  });

  test("a path-traversal-shaped name is rejected by the slug guard → 400 (no escape into tmux -t)", async () => {
    const weird = "../../etc";
    const url = new URL(`http://127.0.0.1/terminal/${encodeURIComponent(weird)}?token=${ADMIN_TOKEN}`);
    const r = new Request(url, { headers: { upgrade: "websocket" } });
    const d = await authorizeTerminalUpgrade(r, url, channels(["eng"]), weird);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.response.status).toBe(400);
  });
});

// Touch HUB_WS_CAP_BYTES so the import is load-bearing if the relationship to the
// hub cap ever drifts (the constant mirrors the hub's DEFAULT_MAX_BUFFERED_BYTES).
test("HUB_WS_CAP_BYTES mirrors the hub's 8 MiB cap", () => {
  expect(HUB_WS_CAP_BYTES).toBe(8 * 1024 * 1024);
});
