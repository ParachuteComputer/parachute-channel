/**
 * Tests for the daemon-level PROGRAMMATIC-AGENT registry + per-channel serial queue
 * (`src/backends/registry.ts`) — the wiring that drives the {@link ProgrammaticBackend}.
 *
 * A FAKE backend (implements {@link AgentBackend}) lets us control each turn's
 * outcome + timing without a real `claude -p`: a deferred-promise gate makes a turn
 * "run" until the test releases it, so the FIFO / never-concurrent invariant is
 * directly observable. The outbound writes go to a recorder array. No tmux, no
 * vault, no hub.
 */

import { describe, test, expect } from "bun:test";
import {
  ProgrammaticAgentRegistry,
  OUTBOUND_MAX_RETRIES,
  PENDING_INBOUND_CAP,
  MAX_DELEGATION_DEPTH,
  isTransientOutboundError,
  type WriteOutbound,
  type WriteThread,
  type WriteCallback,
  type CallbackMeta,
  type ThreadNote,
  type TurnEventSink,
  type TurnLifecycleEvent,
} from "./registry.ts";
import type {
  AgentBackend,
  AgentHandle,
  AgentStatus,
  DeliverResult,
  InterimSink,
  TurnSession,
} from "./types.ts";
import type { AgentSpec } from "../sandbox/types.ts";

/** A deferred promise — resolve it externally to release a gated turn. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A controllable fake backend. `deliver` records each (channel, message), tracks how
 * many turns are CONCURRENTLY in flight (the serial-queue invariant asserts this
 * never exceeds 1), and resolves with whatever `nextResult` says. When `gate` is set,
 * a turn blocks on it until the test releases it — so we can hold a turn "running"
 * while we enqueue more.
 */
class FakeBackend implements AgentBackend {
  readonly kind = "programmatic";
  /** Per-call records, in arrival order — including the caller-resolved {@link TurnSession}. */
  readonly calls: { channel: string; message: string; session: TurnSession }[] = [];
  /** Max concurrent in-flight turns observed (must stay ≤ 1 for serial). */
  maxConcurrent = 0;
  private inFlight = 0;
  /** Whether `stop` was called, per channel. */
  readonly stopped = new Set<string>();
  /** A gate the next turn waits on (release to let it finish). Reset per use. */
  gate: { promise: Promise<void>; resolve: () => void } | null = null;
  /** The result function — given the message, returns the DeliverResult to resolve. */
  resultFor: (message: string) => DeliverResult = (m) => ({ ok: true, reply: "reply:" + m });
  /** If set, `deliver` THROWS this (to test the defensive catch). */
  throwOnce: Error | null = null;
  /** Interim events to emit (via `onInterim`) during the next turn — set per test. */
  interimToEmit: Parameters<InterimSink>[0][] = [];

  async start(spec: AgentSpec): Promise<AgentHandle> {
    return { backend: this.kind, channel: spec.channels[0] as string, name: spec.name, spec };
  }

  async deliver(
    handle: AgentHandle,
    message: string,
    session: TurnSession,
    onInterim?: InterimSink,
  ): Promise<DeliverResult> {
    this.calls.push({ channel: handle.channel, message, session });
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
      // Emit any configured interim events (mirrors the real backend streaming text +
      // tool_use as the turn runs) so the registry's forwarding can be asserted.
      if (onInterim) for (const e of this.interimToEmit) onInterim(e);
      if (this.gate) await this.gate.promise;
      if (this.throwOnce) {
        const e = this.throwOnce;
        this.throwOnce = null;
        throw e;
      }
      return this.resultFor(message);
    } finally {
      this.inFlight--;
    }
  }

  async stop(handle: AgentHandle): Promise<void> {
    this.stopped.add(handle.channel);
  }

  async status(_handle: AgentHandle): Promise<AgentStatus> {
    return { live: true };
  }
}

/** A recorder WriteOutbound — captures every posted reply. */
function recorder(): { calls: { channel: string; reply: string; inReplyTo?: string }[]; fn: WriteOutbound } {
  const calls: { channel: string; reply: string; inReplyTo?: string }[] = [];
  const fn: WriteOutbound = async (channel, reply, inReplyTo) => {
    calls.push({ channel, reply, ...(inReplyTo ? { inReplyTo } : {}) });
  };
  return { calls, fn };
}

/**
 * A recorder WriteThread — captures every `#agent/thread` note the registry writes.
 *
 * The thread-as-container lifecycle writes TWO notes per turn: a `phase:"start"`
 * working-ensure BEFORE the turn, then a `phase:"end"` final record after. `threads`
 * holds ALL writes in order; `ends()` / `starts()` filter by phase so a test can assert
 * the FINAL records (the pre-thread-as-container assertions) without counting the
 * working-ensure, or assert the working-ensure specifically.
 */
function threadRecorder(): {
  threads: ThreadNote[];
  ends: () => ThreadNote[];
  starts: () => ThreadNote[];
  fn: WriteThread;
} {
  const threads: ThreadNote[] = [];
  const fn: WriteThread = async (thread) => {
    threads.push(thread);
  };
  return {
    threads,
    // `phase:"end"` is explicit on every registry-emitted final record; a write with no
    // phase would also be a final record (back-compat), so treat absent as end too.
    ends: () => threads.filter((t) => t.phase !== "start"),
    starts: () => threads.filter((t) => t.phase === "start"),
    fn,
  };
}

/** A multi-threaded spec (materializes one `#agent/thread` note per fire). */
const specMultiThreaded = (name: string, channel = name, definition?: string): AgentSpec => ({
  name,
  channels: [channel],
  mode: "multi-threaded",
  ...(definition ? { definition } : {}),
});

/** A recorder TurnEventSink — captures every (channel, event) the registry emits. */
function turnRecorder(): { events: { channel: string; event: TurnLifecycleEvent }[]; fn: TurnEventSink } {
  const events: { channel: string; event: TurnLifecycleEvent }[] = [];
  const fn: TurnEventSink = (channel, event) => {
    events.push({ channel, event });
  };
  return { events, fn };
}

const specFor = (name: string, channel = name): AgentSpec => ({ name, channels: [channel] });

/** Spin the microtask/timer queue until `pred()` is true or we give up. */
async function until(pred: () => boolean, tries = 200): Promise<void> {
  for (let i = 0; i < tries && !pred(); i++) {
    await new Promise<void>((r) => setTimeout(r, 1));
  }
}

describe("ProgrammaticAgentRegistry — registration + indexes", () => {
  test("register indexes by channel + name; has/get reflect it", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });

    expect(reg.hasChannel("eng")).toBe(false);
    const h = await reg.register(specFor("eng"));
    expect(h.name).toBe("eng");
    expect(h.channel).toBe("eng");
    expect(reg.hasChannel("eng")).toBe(true);
    expect(reg.hasName("eng")).toBe(true);
    expect(reg.getByChannel("eng")?.name).toBe("eng");
    expect(reg.getByName("eng")?.channel).toBe("eng");
    expect(reg.list().map((x) => x.name)).toEqual(["eng"]);
  });

  test("deregister drops the indexes + clears the backend session", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    await reg.register(specFor("eng"));
    expect(await reg.deregister("eng")).toBe(true);
    expect(reg.hasChannel("eng")).toBe(false);
    expect(reg.hasName("eng")).toBe(false);
    expect(backend.stopped.has("eng")).toBe(true);
    // A second deregister is a no-op false.
    expect(await reg.deregister("eng")).toBe(false);
  });

  test("resetSession clears the session WITHOUT deregistering", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    await reg.register(specFor("eng"));
    expect(await reg.resetSession("eng")).toBe(true);
    expect(backend.stopped.has("eng")).toBe(true);
    // Still registered.
    expect(reg.hasName("eng")).toBe(true);
    expect(await reg.resetSession("nope")).toBe(false);
  });
});

describe("ProgrammaticAgentRegistry — inbound enqueue + outbound", () => {
  test("a delivered turn writes a non-empty reply as an outbound note", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    expect(reg.enqueue("eng", { content: "hello", inReplyTo: "note-1" })).toBe(true);
    await until(() => rec.calls.length === 1);

    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]!.channel).toBe("eng");
    expect(backend.calls[0]!.message).toBe("hello");
    // No readSession wired → a single-threaded turn CREATES a fresh session (resume:false).
    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:hello", inReplyTo: "note-1" }]);
  });

  test("enqueue for an UNREGISTERED channel is a no-op false (caller falls back)", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    expect(reg.enqueue("ghost", { content: "x" })).toBe(false);
    expect(backend.calls).toHaveLength(0);
  });

  test("an EMPTY reply writes NO outbound note (reviewer contract)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "tool-only work" });
    await until(() => backend.calls.length === 1);
    // Give any erroneous outbound write a chance to land, then assert none did.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(backend.calls).toHaveLength(1);
    expect(rec.calls).toHaveLength(0);
  });

  test("an ok:false turn writes a user-facing FAILURE note + does not crash/loop", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "do it" });
    await until(() => rec.calls.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));
    // Exactly ONE turn ran (the backend owns turn-retry, not the drain), and the drain
    // posted a SINGLE user-facing failure note carrying the reason (no silent no-reply).
    expect(backend.calls).toHaveLength(1);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.reply).toContain("mint refused");
  });

  test("a deliver() that THROWS is caught — the worker survives + drains the rest", async () => {
    const backend = new FakeBackend();
    backend.throwOnce = new Error("surprise throw");
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "first (throws)" });
    reg.enqueue("eng", { content: "second (ok)" });
    await until(() => rec.calls.length === 2);
    // Both turns ran; the throw on the first didn't strand the second. The caught throw
    // posts a user-facing failure note (carrying the reason); the second succeeds normally.
    expect(backend.calls.map((c) => c.message)).toEqual(["first (throws)", "second (ok)"]);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]!.reply).toContain("surprise throw");
    expect(rec.calls[1]!).toEqual({ channel: "eng", reply: "reply:second (ok)" });
  });
});

describe("ProgrammaticAgentRegistry — #agent/thread notes (unified lifecycle, BOTH modes)", () => {
  test("a completed MULTI-THREADED turn materializes an #agent/thread note (status ok) carrying input/output/definition/mode/name", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest", "digest", "Agents/digest"));

    reg.enqueue("digest", { content: "run the digest" });
    await until(() => threads.ends().length === 1);

    // Thread-as-container: ONE working-ensure (phase:start, status:working) BEFORE the turn,
    // then ONE final record (phase:end, status:ok) after — for the same per-fire note.
    expect(threads.starts()).toHaveLength(1);
    expect(threads.starts()[0]!.status).toBe("working");
    expect(threads.ends()).toHaveLength(1);
    const thread = threads.ends()[0]!;
    expect(thread.channel).toBe("digest");
    expect(thread.name).toBe("digest");
    expect(thread.status).toBe("ok");
    expect(thread.mode).toBe("multi-threaded");
    expect(thread.definition).toBe("Agents/digest");
    expect(thread.input).toBe("run the digest");
    expect(thread.output).toBe("reply:run the digest");
    expect(typeof thread.started_at).toBe("string");
    expect(typeof thread.ended_at).toBe("string");
    // The start + end target the SAME per-fire note (same threadId) — no duplicate minted.
    expect(threads.starts()[0]!.threadId).toBe(thread.threadId!);
    // The dual-write is ADDITIVE: a non-empty reply writes EXACTLY one outbound
    // (the chat delivery) AND exactly one FINAL thread note (the primary record).
    await until(() => rec.calls.length === 1);
    expect(rec.calls.length).toBe(1);
    expect(threads.ends().length).toBe(1);
  });

  test("a SINGLE-THREADED turn ALSO materializes ONE #agent/thread note (the unified model — named after the def)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    // specFor → no mode → single-threaded (the default).
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hello" });
    await until(() => threads.ends().length === 1);

    // BOTH modes materialize a thread note now (the structural unification): a
    // single-threaded turn writes ONE FINAL record, mode single-threaded, NAMED AFTER THE
    // DEF (the deterministic upsert key the transport derives the stable path from).
    // Thread-as-container: a working-ensure (phase:start) preceded it (same upsert key).
    expect(threads.starts()).toHaveLength(1);
    expect(threads.starts()[0]!.name).toBe("eng");
    expect(threads.ends()).toHaveLength(1);
    expect(threads.ends()[0]!.mode).toBe("single-threaded");
    expect(threads.ends()[0]!.name).toBe("eng");
    expect(threads.ends()[0]!.channel).toBe("eng");
    expect(threads.ends()[0]!.input).toBe("hello");
    expect(threads.ends()[0]!.output).toBe("reply:hello");
    // The single-threaded outbound reply was still written (no regression).
    expect(rec.calls).toHaveLength(1);
  });

  test("a single-threaded agent over TWO turns records ONE thread (same name/channel — the upsert key) both turns, status carries forward", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng")); // single-threaded (default).

    // Two turns on the same channel — drained serially, FIFO.
    reg.enqueue("eng", { content: "turn one" });
    reg.enqueue("eng", { content: "turn two" });
    await until(() => threads.ends().length === 2);

    // recordThread (the FINAL record) is called for BOTH turns (the registry seam can't
    // simulate the transport's read-existing upsert, so we assert the UPSERT KEY is stable
    // across turns — same channel + same name + same mode — which the transport maps to the
    // SAME deterministic path `Threads/<channel>/<name>`, overwriting in place. The per-turn
    // turn_count/usage aggregation — incl. the start-ensure NOT double-counting — is covered
    // at the vault-transport layer). Each turn ALSO emits its own working-ensure (phase:start).
    expect(threads.starts()).toHaveLength(2);
    expect(threads.ends()).toHaveLength(2);
    const [t1, t2] = threads.ends();
    expect(t1!.mode).toBe("single-threaded");
    expect(t2!.mode).toBe("single-threaded");
    expect(t1!.name).toBe("eng");
    expect(t2!.name).toBe("eng"); // SAME upsert key → same note, upserted.
    expect(t1!.channel).toBe("eng");
    expect(t2!.channel).toBe("eng");
    expect(t1!.input).toBe("turn one");
    expect(t2!.input).toBe("turn two");
  });

  test("a multi-threaded fire writes a thread note per fire (each carries this fire's turn — distinct records)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest"));

    reg.enqueue("digest", { content: "fire A" });
    reg.enqueue("digest", { content: "fire B" });
    await until(() => threads.ends().length === 2);

    // One FINAL thread note PER FIRE (today one fire = one thread = one note; the transport
    // assigns each a fresh uuid path, so they're distinct records). Each fire's start-ensure
    // shares that fire's threadId (so start + end target the SAME per-fire note).
    expect(threads.ends()).toHaveLength(2);
    expect(threads.ends().map((t) => t.input)).toEqual(["fire A", "fire B"]);
    expect(threads.ends().every((t) => t.mode === "multi-threaded")).toBe(true);
    expect(threads.starts()).toHaveLength(2);
    // Per fire the working-ensure + final record share a threadId (distinct across fires).
    expect(threads.starts()[0]!.threadId).toBe(threads.ends()[0]!.threadId!);
    expect(threads.starts()[1]!.threadId).toBe(threads.ends()[1]!.threadId!);
    expect(threads.ends()[0]!.threadId).not.toBe(threads.ends()[1]!.threadId);
  });

  test("a FAILED MULTI-THREADED turn still materializes an #agent/thread note with status:error + the reason", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest"));

    reg.enqueue("digest", { content: "do it" });
    await until(() => threads.ends().length === 1);

    // The working-ensure (phase:start) still ran BEFORE the turn; the FINAL record is error.
    expect(threads.starts()).toHaveLength(1);
    expect(threads.ends()).toHaveLength(1);
    expect(threads.ends()[0]!.mode).toBe("multi-threaded");
    expect(threads.ends()[0]!.status).toBe("error");
    expect(threads.ends()[0]!.output).toBe("mint refused");
    // A user-facing failure note IS now written for a failed turn (carries the reason).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.reply).toContain("mint refused");
  });

  test("a FAILED SINGLE-THREADED turn ALSO materializes an #agent/thread note with status:error (substantiates BOTH modes)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    // specFor → no mode → single-threaded (the default).
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "do it" });
    await until(() => threads.ends().length === 1);

    // The working-ensure (phase:start) still ran BEFORE the turn; the FINAL record is error.
    expect(threads.starts()).toHaveLength(1);
    expect(threads.ends()).toHaveLength(1);
    expect(threads.ends()[0]!.mode).toBe("single-threaded");
    expect(threads.ends()[0]!.name).toBe("eng");
    expect(threads.ends()[0]!.status).toBe("error");
    expect(threads.ends()[0]!.output).toBe("mint refused");
    // A user-facing failure note IS now written for a failed turn (carries the reason).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.reply).toContain("mint refused");
  });

  test("a turn with an empty reply STILL materializes a thread note (status ok, empty output)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest"));

    reg.enqueue("digest", { content: "tool-only run" });
    await until(() => threads.ends().length === 1);
    // The working-ensure (phase:start, no fake reply) preceded the empty-reply final record.
    expect(threads.starts()).toHaveLength(1);
    expect(threads.starts()[0]!.output).toBe("");
    expect(threads.ends()[0]!.status).toBe("ok");
    expect(threads.ends()[0]!.output).toBe("");
    // Empty reply → no outbound message note (the thread note IS the record).
    expect(rec.calls).toHaveLength(0);
  });

  test("REGRESSION (c34db03, now BOTH modes): a turn whose outbound write THROWS still leaves a primary #agent/thread note (now re-recorded as error — FIX 1)", async () => {
    const backend = new FakeBackend();
    const threads = threadRecorder();
    // A THROWING WriteOutbound — the thread note is written BEFORE the additive outbound
    // (c34db03, now applied uniformly to BOTH modes), so the failed transcript write must
    // NOT cost us the primary record. Use a SINGLE-THREADED spec to prove the c34db03
    // ordering now protects single-threaded too. (`recorder()` can't throw; inline variant.)
    // The error message carries NO HTTP status → classified TRANSIENT → it RETRIES the
    // bounded budget (FIX 1, PR #3) before giving up, then re-records the thread as error.
    let outboundAttempts = 0;
    const throwingWriteOutbound: WriteOutbound = async () => {
      outboundAttempts++;
      throw new Error("vault write boom"); // no (NNN) status → transient → retried.
    };
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: throwingWriteOutbound,
      writeThread: threads.fn,
      outboundRetryBaseMs: 0,
    });
    await reg.register(specFor("eng")); // single-threaded (default) — the ordering applies here now.

    reg.enqueue("eng", { content: "fire it" });
    // Thread-as-container + FIX 1: a working-ensure (phase:start) is written first, then the
    // primary `ok` FINAL record, then after retries exhaust a `error` FINAL record re-records
    // the UN-DELIVERED reply — so `ends()` (the final records) is exactly [ok, error].
    await until(() => threads.ends().length === 2);

    // The working-ensure preceded everything (status:working, no fake reply).
    expect(threads.starts()).toHaveLength(1);
    expect(threads.starts()[0]!.status).toBe("working");
    // First FINAL (optimistic) record was `ok`; the second re-records the failure so the
    // durable thread record does NOT falsely claim the reply landed.
    expect(threads.ends()[0]!.status).toBe("ok");
    expect(threads.ends()[0]!.output).toBe("reply:fire it");
    expect(threads.ends()[1]!.status).toBe("error");
    expect(threads.ends()[1]!.mode).toBe("single-threaded");
    // The undelivered reply text is preserved in the error record for recovery.
    expect(threads.ends()[1]!.output).toContain("reply:fire it");
    // The re-record reuses the SAME per-turn threadId + sameTurn (no double-count, no dup).
    expect(threads.ends()[1]!.threadId).toBe(threads.ends()[0]!.threadId!);
    expect(threads.ends()[1]!.sameTurn).toBe(true);
    // Transient → the outbound was retried the full budget (1 initial + OUTBOUND_MAX_RETRIES).
    expect(outboundAttempts).toBe(1 + OUTBOUND_MAX_RETRIES);
  });
});

describe("ProgrammaticAgentRegistry — thread≡session (the daemon owns the uuid)", () => {
  /** A recorder readSession — captures every (channel, name) consulted; returns `prior`. */
  function sessionReader(prior?: string): {
    calls: { channel: string; name: string }[];
    fn: (channel: string, name: string) => Promise<string | undefined>;
  } {
    const calls: { channel: string; name: string }[] = [];
    const fn = async (channel: string, name: string) => {
      calls.push({ channel, name });
      return prior;
    };
    return { calls, fn };
  }

  test("single-threaded with a PRIOR session: consults readSession + passes {resume:true} to deliver", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = sessionReader("11111111-1111-4111-8111-111111111111");
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specFor("eng")); // single-threaded (default).

    reg.enqueue("eng", { content: "hello" });
    await until(() => backend.calls.length === 1);

    // readSession was consulted with the channel + the def name (the deterministic key).
    expect(reader.calls).toEqual([{ channel: "eng", name: "eng" }]);
    // A prior session → RESUME it (continue the conversation), with that exact id.
    expect(backend.calls[0]!.session).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      resume: true,
    });
    // The thread note carries the session (the persisted thread≡session record).
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.session).toBe("11111111-1111-4111-8111-111111111111");
    // The start-ensure also carried it (so a turn that never completes is still resumable).
    expect(threads.starts()[0]!.session).toBe("11111111-1111-4111-8111-111111111111");
  });

  test("single-threaded with NO prior session: consults readSession + passes {resume:false} + a fresh uuid", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = sessionReader(undefined); // no prior — first turn.
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hello" });
    await until(() => backend.calls.length === 1);

    expect(reader.calls).toEqual([{ channel: "eng", name: "eng" }]);
    // No prior → CREATE a fresh session with a generated uuid (--session-id, not --resume).
    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    // The fresh uuid is the one persisted onto the thread note (so turn 2 can resume it).
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.session).toBe(backend.calls[0]!.session.id);
  });

  test("multi-threaded NEVER consults readSession + ALWAYS passes {resume:false} with a fresh uuid", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = sessionReader("should-never-be-used");
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specMultiThreaded("digest", "digest"));

    // Two fires — each must mint its OWN fresh session, never resume.
    reg.enqueue("digest", { content: "fire one" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("digest", { content: "fire two" });
    await until(() => backend.calls.length === 2);

    // readSession is NEVER consulted for a multi-threaded agent (each fire is a fresh thread).
    expect(reader.calls).toHaveLength(0);
    // Both fires CREATE fresh sessions (resume:false), with DISTINCT uuids.
    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[1]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(backend.calls[1]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(backend.calls[0]!.session.id).not.toBe(backend.calls[1]!.session.id);
    // Each per-fire thread note carries its own fire's session.
    await until(() => threads.ends().length === 2);
    expect(threads.ends()[0]!.session).toBe(backend.calls[0]!.session.id);
    expect(threads.ends()[1]!.session).toBe(backend.calls[1]!.session.id);
  });

  test("no readSession wired: a single-threaded turn still CREATES a fresh session", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hello" });
    await until(() => backend.calls.length === 1);

    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.session).toBe(backend.calls[0]!.session.id);
  });

  test("the captured backend sessionId (Claude's echoed id) is what lands on the thread note", async () => {
    const backend = new FakeBackend();
    // The backend echoes a DIFFERENT id than the one we passed (Claude's authoritative id).
    backend.resultFor = (m) => ({ ok: true, reply: "reply:" + m, sessionId: "echoed-by-claude-id" });
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hello" });
    await until(() => threads.ends().length === 1);

    // The END record prefers Claude's echoed id (result.sessionId) over the uuid we passed.
    expect(threads.ends()[0]!.session).toBe("echoed-by-claude-id");
  });
});

describe("ProgrammaticAgentRegistry — outbound retry on transient failure (FIX 1, PR #3)", () => {
  test("isTransientOutboundError: 5xx + network = transient; 4xx = permanent", () => {
    expect(isTransientOutboundError(new Error("write reply failed (502) boom"))).toBe(true);
    expect(isTransientOutboundError(new Error("write reply failed (503)"))).toBe(true);
    expect(isTransientOutboundError(new Error("ECONNREFUSED"))).toBe(true); // no status → network.
    expect(isTransientOutboundError(new Error("fetch failed"))).toBe(true);
    expect(isTransientOutboundError(new Error("write reply failed (400) bad"))).toBe(false);
    expect(isTransientOutboundError(new Error("write reply failed (401)"))).toBe(false);
    expect(isTransientOutboundError(new Error("write reply failed (409)"))).toBe(false);
  });

  test("a transient-then-success outbound RETRIES and the reply LANDS (no loss, turn not re-run)", async () => {
    const backend = new FakeBackend();
    const threads = threadRecorder();
    // Fail twice with a transient (5xx) error, then succeed — the retry must land the reply.
    let attempts = 0;
    const recorded: { reply: string }[] = [];
    const flakyWriteOutbound: WriteOutbound = async (_channel, reply) => {
      attempts++;
      if (attempts <= 2) throw new Error("vault transport: write reply failed (502) blip");
      recorded.push({ reply });
    };
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: flakyWriteOutbound,
      writeThread: threads.fn,
      outboundRetryBaseMs: 0,
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "important" });
    await until(() => recorded.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));

    // The reply landed on the 3rd attempt (1 initial + 2 retries == OUTBOUND_MAX_RETRIES).
    expect(attempts).toBe(1 + OUTBOUND_MAX_RETRIES);
    expect(recorded).toEqual([{ reply: "reply:important" }]);
    // The backend ran the turn EXACTLY ONCE (no re-run / fork on the retry).
    expect(backend.calls).toHaveLength(1);
    // The FINAL thread note is the single `ok` record (the reply was ultimately delivered) —
    // no error re-record because delivery succeeded. (A working-ensure preceded it.)
    expect(threads.starts()).toHaveLength(1);
    expect(threads.ends()).toHaveLength(1);
    expect(threads.ends()[0]!.status).toBe("ok");
  });

  test("a PERSISTENT failure surfaces an error event + re-records the thread as error + does NOT claim success", async () => {
    const backend = new FakeBackend();
    const threads = threadRecorder();
    const turn = turnRecorder();
    let attempts = 0;
    const alwaysFail: WriteOutbound = async () => {
      attempts++;
      throw new Error("vault transport: write reply failed (503) down");
    };
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: alwaysFail,
      writeThread: threads.fn,
      onTurnEvent: turn.fn,
      outboundRetryBaseMs: 0,
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "doomed" });
    await until(() => threads.ends().length === 2);
    await new Promise<void>((r) => setTimeout(r, 5));

    // Retried the full budget then gave up (1 + OUTBOUND_MAX_RETRIES).
    expect(attempts).toBe(1 + OUTBOUND_MAX_RETRIES);
    // The live view resolved to ERROR (not `done`) — no silently-vanished reply.
    const errorEvents = turn.events.filter((e) => e.event.kind === "error");
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
    expect(turn.events.some((e) => e.event.kind === "done")).toBe(false);
    // The FINAL thread record does NOT falsely claim a clean ok: the second final record is
    // error, carrying the un-delivered reply text for recovery. (A working-ensure preceded.)
    expect(threads.ends()).toHaveLength(2);
    expect(threads.ends()[1]!.status).toBe("error");
    expect(threads.ends()[1]!.output).toContain("reply:doomed");
  });

  test("a PERMANENT (4xx) outbound failure does NOT retry — gives up immediately", async () => {
    const backend = new FakeBackend();
    const threads = threadRecorder();
    let attempts = 0;
    const reject4xx: WriteOutbound = async () => {
      attempts++;
      throw new Error("vault transport: write reply failed (400) bad request");
    };
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: reject4xx,
      writeThread: threads.fn,
      outboundRetryBaseMs: 0,
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "rejected" });
    await until(() => threads.ends().length === 2);
    await new Promise<void>((r) => setTimeout(r, 5));

    // A 4xx is a real rejection → exactly ONE attempt, no retry.
    expect(attempts).toBe(1);
    // The second FINAL record re-records the turn as error (the un-delivered reply).
    expect(threads.ends()).toHaveLength(2);
    expect(threads.ends()[1]!.status).toBe("error");
  });
});

describe("ProgrammaticAgentRegistry — serial queue (the hard invariant)", () => {
  test("two inbounds during a running turn are processed ONE AT A TIME, FIFO, never concurrent", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    // First enqueue starts a turn that blocks on the gate.
    reg.enqueue("eng", { content: "m1" });
    await until(() => backend.calls.length === 1);
    expect(reg.statusOf("eng").state).toBe("working");

    // Two more arrive WHILE the first turn is in flight — they queue.
    reg.enqueue("eng", { content: "m2" });
    reg.enqueue("eng", { content: "m3" });
    // Still exactly one call has STARTED (the gate holds the first; the others wait).
    expect(backend.calls).toHaveLength(1);
    expect(reg.statusOf("eng")).toEqual({ state: "queued", queued: 2 });

    // Release the gate: the worker drains m1, then m2, then m3 in order. Because the
    // gate's promise is already resolved, subsequent turns don't block.
    gate.resolve();
    await until(() => rec.calls.length === 3);

    expect(backend.calls.map((c) => c.message)).toEqual(["m1", "m2", "m3"]);
    expect(rec.calls.map((c) => c.reply)).toEqual(["reply:m1", "reply:m2", "reply:m3"]);
    // The invariant: never two concurrent turns for the same channel.
    expect(backend.maxConcurrent).toBe(1);
    // Queue fully drained → idle.
    expect(reg.statusOf("eng").state).toBe("idle");
  });

  test("statusOf — idle with no work, working with one in flight, queued:N with a backlog", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));
    expect(reg.statusOf("eng")).toEqual({ state: "idle", queued: 0 });

    reg.enqueue("eng", { content: "a" });
    await until(() => backend.calls.length === 1);
    expect(reg.statusOf("eng")).toEqual({ state: "working", queued: 0 });

    reg.enqueue("eng", { content: "b" });
    expect(reg.statusOf("eng")).toEqual({ state: "queued", queued: 1 });

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(reg.statusOf("eng")).toEqual({ state: "idle", queued: 0 });
  });
});

describe("ProgrammaticAgentRegistry — streaming turn view (onTurnEvent)", () => {
  test("forwards the backend's interim events + a final 'done' (keyed by channel)", async () => {
    const backend = new FakeBackend();
    backend.interimToEmit = [
      { kind: "init", sessionId: "s-1" },
      { kind: "text", text: "thinking…" },
      { kind: "tool", tool: "Read" },
    ];
    backend.resultFor = () => ({ ok: true, reply: "final answer" });
    const rec = recorder();
    const turns = turnRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, onTurnEvent: turns.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => rec.calls.length === 1);
    // Let the trailing 'done' (emitted after the outbound write) land.
    await until(() => turns.events.some((e) => e.event.kind === "done"));

    expect(turns.events.map((e) => e.channel)).toEqual(["eng", "eng", "eng", "eng"]);
    expect(turns.events.map((e) => e.event)).toEqual([
      { kind: "init", sessionId: "s-1" },
      { kind: "text", text: "thinking…" },
      { kind: "tool", tool: "Read" },
      { kind: "done", reply: "final answer" },
    ]);
    // The durable outbound write is unchanged by the live view.
    expect(rec.calls).toEqual([{ channel: "eng", reply: "final answer" }]);
  });

  test("an ok:false turn emits a 'error' lifecycle event (no stuck working state)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const turns = turnRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, onTurnEvent: turns.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "x" });
    await until(() => rec.calls.length === 1);

    expect(turns.events).toEqual([{ channel: "eng", event: { kind: "error", error: "mint refused" } }]);
    // The failed turn ALSO posts a user-facing failure note (carrying the reason).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.reply).toContain("mint refused");
  });

  test("a backend THROW also emits 'error' (the defensive catch resolves the live view)", async () => {
    const backend = new FakeBackend();
    backend.throwOnce = new Error("boom");
    const rec = recorder();
    const turns = turnRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, onTurnEvent: turns.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "x" });
    await until(() => turns.events.some((e) => e.event.kind === "error"));

    expect(turns.events).toEqual([{ channel: "eng", event: { kind: "error", error: "boom" } }]);
  });

  test("an empty reply still emits 'done' (with reply '') so the live view finalizes", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const turns = turnRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, onTurnEvent: turns.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "tool-only" });
    await until(() => turns.events.some((e) => e.event.kind === "done"));

    expect(turns.events).toEqual([{ channel: "eng", event: { kind: "done", reply: "" } }]);
    // No durable note for an empty reply (the existing contract), but the view finalizes.
    expect(rec.calls).toHaveLength(0);
  });

  test("a throwing sink can't break the worker (the durable write still lands)", async () => {
    const backend = new FakeBackend();
    backend.interimToEmit = [{ kind: "text", text: "hi" }];
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      onTurnEvent: () => {
        throw new Error("dead stream");
      },
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => rec.calls.length === 1);
    expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:hi" }]);
  });

  test("with NO sink wired, turns run exactly as before (no throw, durable write lands)", async () => {
    const backend = new FakeBackend();
    backend.interimToEmit = [{ kind: "text", text: "ignored" }];
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => rec.calls.length === 1);
    expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:hi" }]);
  });
});

describe("ProgrammaticAgentRegistry — pending-inbound queue + replay-on-register (agent#121)", () => {
  test("an inbound for an EXPECTED-but-not-yet-registered channel is QUEUED pending (not dropped)", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    // No live agent yet — but the channel is EXPECTED (the def-instantiation path marked it
    // before bringing the agent up). enqueue() would no-op false here; queuePending OWNS it.
    reg.expectChannel("eng");
    expect(reg.hasChannel("eng")).toBe(false);
    expect(reg.enqueue("eng", { content: "early" })).toBe(false); // not live → enqueue declines.
    expect(reg.queuePending("eng", { content: "early" })).toBe("queued");
    expect(reg.pendingCount("eng")).toBe(1);
    // Nothing ran yet (no live agent), but nothing was lost either.
    expect(backend.calls).toHaveLength(0);
  });

  test("queuePending for a genuinely UNKNOWN channel (not expected) returns 'unknown' (caller logs+drops)", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    // Never expected, never registered → nothing maps to it.
    expect(reg.queuePending("ghost", { content: "x" })).toBe("unknown");
    expect(reg.pendingCount("ghost")).toBe(0);
  });

  test("on register() the channel's pending queue DRAINS into the serial worker, in arrival order (FIFO)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    // Three inbound arrive BEFORE the agent is live — all buffered pending.
    reg.expectChannel("eng");
    expect(reg.queuePending("eng", { content: "first" })).toBe("queued");
    expect(reg.queuePending("eng", { content: "second" })).toBe("queued");
    expect(reg.queuePending("eng", { content: "third" })).toBe("queued");
    expect(reg.pendingCount("eng")).toBe(3);

    // The agent registers → the buffer replays through the normal serial path, FIFO.
    await reg.register(specFor("eng"));
    await until(() => rec.calls.length === 3);

    // The buffer is drained + the EXPECTED mark cleared (the live index is the truth now).
    expect(reg.pendingCount("eng")).toBe(0);
    expect(reg.isExpected("eng")).toBe(false);
    // Turns ran in arrival order (the serial worker drains FIFO).
    expect(backend.calls.map((c) => c.message)).toEqual(["first", "second", "third"]);
    expect(rec.calls.map((c) => c.reply)).toEqual(["reply:first", "reply:second", "reply:third"]);
  });

  test("the pending buffer is CAPPED — past the cap the OLDEST is evicted (FIFO), newest kept", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    reg.expectChannel("eng");
    // Fill to the cap, then push one MORE — the oldest ("m0") is evicted.
    for (let i = 0; i < PENDING_INBOUND_CAP; i++) {
      expect(reg.queuePending("eng", { content: `m${i}` })).toBe("queued");
    }
    expect(reg.pendingCount("eng")).toBe(PENDING_INBOUND_CAP);
    expect(reg.queuePending("eng", { content: "overflow" })).toBe("queued");
    // Still capped (didn't grow past the cap).
    expect(reg.pendingCount("eng")).toBe(PENDING_INBOUND_CAP);
  });

  test("an UNKNOWN channel queuePending does NOT crash + leaves the registry usable", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    expect(() => reg.queuePending("ghost", { content: "x" })).not.toThrow();
    // The registry still works for a real registration afterward.
    expect(reg.queuePending("ghost", { content: "y" })).toBe("unknown");
  });

  test("register() clears the EXPECTED mark even with an EMPTY pending buffer", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    reg.expectChannel("eng");
    expect(reg.isExpected("eng")).toBe(true);
    await reg.register(specFor("eng"));
    expect(reg.isExpected("eng")).toBe(false);
    expect(reg.pendingCount("eng")).toBe(0);
  });

  test("unexpectChannel drops a stale EXPECTED mark + its buffered pending (teardown)", () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    reg.expectChannel("eng");
    reg.queuePending("eng", { content: "stranded" });
    expect(reg.pendingCount("eng")).toBe(1);
    reg.unexpectChannel("eng");
    expect(reg.isExpected("eng")).toBe(false);
    expect(reg.pendingCount("eng")).toBe(0);
    // A subsequent inbound for the now-unexpected channel is 'unknown' (correctly dropped).
    expect(reg.queuePending("eng", { content: "after" })).toBe("unknown");
  });

  test("a channel-move re-register clears the OLD channel's expected mark + pending buffer (no leak)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    // Register the agent on channel "old", then buffer a pending inbound for "old".
    await reg.register({ name: "mover", channels: ["old"] });
    reg.expectChannel("old");
    reg.queuePending("old", { content: "stranded" });
    expect(reg.pendingCount("old")).toBe(1);

    // Re-register the SAME name onto a DIFFERENT wake channel — the old channel's indexes,
    // expected mark, and pending buffer must all be dropped (nothing routes to "old" now).
    await reg.register({ name: "mover", channels: ["new"] });
    expect(reg.hasChannel("old")).toBe(false);
    expect(reg.isExpected("old")).toBe(false);
    expect(reg.pendingCount("old")).toBe(0);
    expect(reg.hasChannel("new")).toBe(true);
  });

  test("a pending inbound that arrives DURING a drain (after register) still replays in order", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    // Two pending before register.
    reg.expectChannel("eng");
    reg.queuePending("eng", { content: "p1" });
    reg.queuePending("eng", { content: "p2" });

    await reg.register(specFor("eng"));
    // After register the channel is LIVE — a further inbound goes through enqueue directly.
    await until(() => rec.calls.length === 2);
    expect(reg.enqueue("eng", { content: "p3" })).toBe(true);
    await until(() => rec.calls.length === 3);

    expect(backend.calls.map((c) => c.message)).toEqual(["p1", "p2", "p3"]);
  });
});

describe("ProgrammaticAgentRegistry — thread-as-container working-ensure (Part B)", () => {
  test("the working-ensure (phase:start, status:working) is written BEFORE deliver() runs", async () => {
    const backend = new FakeBackend();
    // Gate the turn so we can observe the working-ensure write WHILE the turn is in flight.
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "do work" });
    // Wait until deliver() is in flight (the turn was handed the message + is blocked on the
    // gate). The start-ensure is `await`ed BEFORE deliver() in the drain, so by the time
    // deliver() has been called the working-ensure MUST already be written — and the FINAL
    // (end) record must NOT be (the turn hasn't completed). This proves the ordering:
    // working-ensure strictly precedes the turn.
    await until(() => backend.calls.length === 1);
    expect(threads.starts()).toHaveLength(1);
    expect(threads.starts()[0]!.status).toBe("working");
    expect(threads.starts()[0]!.output).toBe(""); // NO fake reply while working.
    expect(threads.starts()[0]!.input).toBe("do work");
    // The turn is in flight but hasn't produced its end record yet (gated).
    expect(backend.calls).toHaveLength(1);
    expect(threads.ends()).toHaveLength(0);

    // Release the turn → it completes → the FINAL (ok) record lands, same threadId.
    gate.resolve();
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.status).toBe("ok");
    expect(threads.ends()[0]!.threadId).toBe(threads.starts()[0]!.threadId!);
  });

  test("the start-ensure does NOT write a fake reply even though the turn ultimately replies", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => threads.ends().length === 1);
    // The working-ensure carries status:working + empty output; the end carries the reply.
    expect(threads.starts()[0]!.status).toBe("working");
    expect(threads.starts()[0]!.output).toBe("");
    expect(threads.ends()[0]!.output).toBe("reply:hi");
  });

  test("the OUTBOUND reply is stamped with the turn's thread id (definition→thread→message link); multi-threaded → the per-fire note leaf", async () => {
    const backend = new FakeBackend();
    const threads = threadRecorder();
    // A recorder that ALSO captures the threadId the worker passes to writeOutbound.
    const outbound: { reply: string; threadId?: string }[] = [];
    const writeOutbound: WriteOutbound = async (_channel, reply, _inReplyTo, threadId) => {
      outbound.push({ reply, ...(threadId ? { threadId } : {}) });
    };
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest"));

    reg.enqueue("digest", { content: "go" });
    await until(() => outbound.length === 1);
    // The outbound carries the per-turn thread id, which for multi-threaded equals the
    // per-fire thread note's leaf — the explicit message↔thread link.
    expect(outbound[0]!.threadId).toBeDefined();
    expect(outbound[0]!.threadId).toBe(threads.ends()[0]!.threadId!);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// AGENT-TO-AGENT CALLBACK ROUTING ("reply_to") — design 2026-06-20-agent-callbacks.md.
// A FAKE WriteCallback recorder captures every callback the drain delivers (its target
// channel + content + the metadata contract), so we can assert: a reply_to message gets
// exactly one callback w/ the right metadata; a no-reply_to message gets none; ok AND error
// both fire; the depth guard suppresses; and N callbacks to one channel drain FIFO + none
// is lost (the orchestrator-resume concurrency story).
// ───────────────────────────────────────────────────────────────────────────────

/** A recorder WriteCallback — captures every callback the registry delivers, in order. */
function callbackRecorder(): {
  calls: { channel: string; content: string; meta: CallbackMeta }[];
  fn: WriteCallback;
} {
  const calls: { channel: string; content: string; meta: CallbackMeta }[] = [];
  const fn: WriteCallback = async (channel, content, meta) => {
    calls.push({ channel, content, meta });
  };
  return { calls, fn };
}

/** A WriteOutbound that returns a deterministic note id, so source_message is assertable. */
function recorderWithId(noteId = "outbound-note-1"): {
  calls: { channel: string; reply: string }[];
  fn: WriteOutbound;
} {
  const calls: { channel: string; reply: string }[] = [];
  const fn: WriteOutbound = async (channel, reply) => {
    calls.push({ channel, reply });
    return { id: noteId };
  };
  return { calls, fn };
}

describe("ProgrammaticAgentRegistry — agent-to-agent callbacks (reply_to)", () => {
  test("an inbound WITH reply_to → exactly ONE callback to the reply_to channel with the full metadata contract (ok)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId("reply-note-42");
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", {
      content: "sub-task",
      inReplyTo: "inbound-note-7",
      replyTo: "orchestrator",
      correlationId: "corr-abc",
      delegationDepth: 2,
    });
    await until(() => cb.calls.length === 1);
    // Let any erroneous SECOND callback land, then assert there was exactly one.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(cb.calls).toHaveLength(1);

    const { channel, content, meta } = cb.calls[0]!;
    expect(channel).toBe("orchestrator"); // delivered to the SENDER's channel.
    expect(content).toContain("[callback]");
    expect(content).not.toContain("done:sub-task"); // summary + link, NOT the full reply.
    expect(meta.callback).toBe("true");
    expect(meta.status).toBe("ok");
    expect(meta.source_channel).toBe("worker");
    expect(meta.source_message).toBe("reply-note-42"); // the delivered outbound note id.
    expect(meta.source_thread).toBeDefined(); // the per-turn thread id (pull link).
    expect(meta.correlation_id).toBe("corr-abc"); // echoed verbatim.
    expect(meta.delegation_depth).toBe("3"); // incoming 2 + 1 hop.
    // The callback note must NOT itself carry a reply_to (terminal — the loop guard).
    expect((meta as unknown as Record<string, unknown>).reply_to).toBeUndefined();
  });

  test("an inbound WITHOUT reply_to → NO callback (a normal turn never emits one)", async () => {
    const backend = new FakeBackend();
    const out = recorderWithId();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", { content: "plain message" });
    await until(() => out.calls.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(out.calls).toHaveLength(1); // the turn ran + replied normally,
    expect(cb.calls).toHaveLength(0); // but no callback fired.
  });

  test("the callback fires on an ERROR turn too (status:error, no source_message)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const out = recorderWithId();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", { content: "do it", replyTo: "orchestrator", delegationDepth: 0 });
    await until(() => cb.calls.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(cb.calls).toHaveLength(1);
    // An error turn now posts a user-facing failure note to the worker's own channel
    // (in addition to the orchestrator callback) — carrying the reason.
    expect(out.calls).toHaveLength(1);
    expect(out.calls[0]!.reply).toContain("mint refused");
    const { meta, content } = cb.calls[0]!;
    expect(meta.status).toBe("error"); // but the orchestrator still learns it failed.
    expect(content).toContain("error");
    expect(meta.source_message).toBeUndefined(); // no delivered reply note.
    expect(meta.delegation_depth).toBe("1"); // 0 + 1.
  });

  test("the callback fires when deliver() THROWS (defensive catch → status:error)", async () => {
    const backend = new FakeBackend();
    backend.throwOnce = new Error("surprise throw");
    const out = recorderWithId();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", { content: "boom", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);
    expect(cb.calls[0]!.meta.status).toBe("error");
  });

  test("the callback fires status:error when the outbound write FAILS after retries (reply produced but not delivered)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    // Always-fail outbound (a permanent 4xx → no retry); the reply was produced but lost.
    const alwaysFail: WriteOutbound = async () => {
      throw new Error("vault transport: write reply failed (400) bad request");
    };
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: alwaysFail,
      writeCallback: cb.fn,
      outboundRetryBaseMs: 1,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", { content: "x", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);
    // The orchestrator learns the turn did NOT truly succeed (the reply never landed).
    expect(cb.calls[0]!.meta.status).toBe("error");
    expect(cb.calls[0]!.meta.source_message).toBeUndefined(); // the note never landed.
  });

  test("delegation_depth >= MAX → NO callback (the depth loop guard), turn still runs", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    // An incoming message already AT the ceiling: a callback would push it over, so suppress.
    reg.enqueue("worker", {
      content: "deep",
      replyTo: "orchestrator",
      delegationDepth: MAX_DELEGATION_DEPTH,
    });
    await until(() => out.calls.length === 1); // the turn STILL ran + replied,
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(out.calls).toHaveLength(1);
    expect(cb.calls).toHaveLength(0); // but the callback was suppressed by the depth guard.
  });

  test("a message just UNDER the ceiling still gets a callback (boundary)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", {
      content: "near-edge",
      replyTo: "orchestrator",
      delegationDepth: MAX_DELEGATION_DEPTH - 1,
    });
    await until(() => cb.calls.length === 1);
    expect(cb.calls).toHaveLength(1);
    expect(cb.calls[0]!.meta.delegation_depth).toBe(String(MAX_DELEGATION_DEPTH)); // the last hop.
  });

  test("no WriteCallback wired → reply_to is inert (the turn runs normally, no crash)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId();
    // NOTE: writeCallback intentionally NOT passed.
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: out.fn });
    await reg.register(specFor("worker"));

    reg.enqueue("worker", { content: "x", replyTo: "orchestrator" });
    await until(() => out.calls.length === 1);
    expect(out.calls).toHaveLength(1); // the turn ran fine despite reply_to + no sink.
  });

  test("a WriteCallback that THROWS does not strand the drain (best-effort, logged)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId();
    const throwingCb: WriteCallback = async () => {
      throw new Error("callback delivery boom");
    };
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeCallback: throwingCb,
    });
    await reg.register(specFor("worker"));

    // Two reply_to messages; the first callback throws — the second turn must still drain.
    reg.enqueue("worker", { content: "first", replyTo: "orchestrator" });
    reg.enqueue("worker", { content: "second", replyTo: "orchestrator" });
    await until(() => out.calls.length === 2);
    expect(out.calls.map((c) => c.reply)).toEqual(["done:first", "done:second"]);
  });

  test("CONCURRENCY: N callbacks returning to ONE orchestrator channel drain FIFO, none lost or clobbered", async () => {
    // The orchestrator-resume story: an orchestrator fires N sub-tasks; each worker's turn
    // completes and delivers a callback BACK to the orchestrator's channel. Those callbacks
    // arrive as inbound on the orchestrator's channel and are handled by ITS per-channel
    // serial drain — one at a time, FIFO, never concurrent (its --resume session carries
    // state across them). We exercise the DRAIN-SIDE FIFO property directly here (enqueue N
    // callback-shaped inbound messages on one channel + assert they drain in order, none
    // lost, the backend never ran two concurrently) — NOT the real vault-IPC delivery path
    // (callback note → trigger → /api/vault/inbound → emit), which the wiring + vault suites
    // cover. The serial drain is the same machinery either way, so this pins the invariant.
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "ack:" + m });
    const out = recorderWithId();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: out.fn });
    await reg.register(specFor("orchestrator"));

    const N = 6;
    for (let i = 0; i < N; i++) {
      // A callback inbound carries NO reply_to (terminal) — exactly the shape the daemon
      // writes. The orchestrator processes each as "a sub-task finished" message.
      reg.enqueue("orchestrator", { content: `callback-${i}` });
    }
    await until(() => backend.calls.length === N);
    // FIFO: arrival order preserved, NONE lost or duplicated.
    expect(backend.calls.map((c) => c.message)).toEqual(
      Array.from({ length: N }, (_, i) => `callback-${i}`),
    );
    // The per-channel serial worker never ran two turns at once (the --resume invariant).
    expect(backend.maxConcurrent).toBe(1);
    expect(out.calls.map((c) => c.reply)).toEqual(
      Array.from({ length: N }, (_, i) => `ack:callback-${i}`),
    );
  });
});
