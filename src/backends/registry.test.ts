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
  outboundThreadId,
  runFiredBy,
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
  InboundAttachment,
  InterimSink,
  LoadoutEntry,
  RunContext,
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
  readonly calls: {
    channel: string;
    message: string;
    session: TurnSession;
    runContext?: RunContext;
    /** roles×threads NEXT slice (#120, G): the thread subject the drain threaded in. */
    subject?: string;
    /** the resolved layer-③ EXTRA-CONTEXT (loadout) entries the drain threaded in. */
    loadout?: LoadoutEntry[];
    /** thread content (layer ②): the thread's own authored body the drain threaded in. */
    threadContent?: LoadoutEntry;
    /** roles (layer ①): the resolved ROLE content entries the drain threaded in (composed FIRST). */
    roles?: LoadoutEntry[];
    /** the loaded-ROLE grant keys the drain threaded in (capability source). */
    roleKeys?: string[];
    /** Phase 3: the EFFECTIVE model on the handle the drain handed deliver (thread-first / def fallback). */
    model?: string;
  }[] = [];
  /** Max concurrent in-flight turns observed (must stay ≤ 1 for serial — PER drain key). */
  maxConcurrent = 0;
  /**
   * Max concurrent in-flight turns observed PER (channel, subject) thread key — the
   * per-THREAD serial guarantee (roles×threads NEXT slice #120): two DIFFERENT subjects of
   * one agent MAY interleave (so the channel-wide max can exceed 1), but each (name, subject)
   * thread must stay ≤ 1. Keyed by `${channel}::${subject ?? ""}`.
   */
  readonly maxConcurrentByThread = new Map<string, number>();
  private readonly inFlightByThread = new Map<string, number>();
  private inFlight = 0;
  /** Whether `stop` was called, per channel. */
  readonly stopped = new Set<string>();
  /** A gate the next turn waits on (release to let it finish). Reset per use. */
  gate: { promise: Promise<void>; resolve: () => void } | null = null;
  /**
   * Per-SUBJECT gates (roles×threads NEXT slice #120) — a turn for subject S blocks on
   * `gateBySubject.get(S)` if present (else the shared `gate`, else not at all). Lets a test
   * hold subject A's turn while subject B's turn runs to completion, proving two subjects of
   * one agent INTERLEAVE while each subject stays serial. Keyed by the raw subject string.
   */
  readonly gateBySubject = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /**
   * The result function — given the message + the turn's session id, returns the
   * DeliverResult to resolve. The DEFAULT ECHOES `sessionId` (mirroring real claude, which
   * always echoes the `--session-id`/`--resume` id it was handed on a successful turn) so a
   * successful turn's thread note carries the established session — the FIX-2 invariant.
   * An override that omits `sessionId` models a turn that failed BEFORE establishing one.
   */
  resultFor: (message: string, sessionId: string) => DeliverResult = (m, sid) => ({
    ok: true,
    reply: "reply:" + m,
    sessionId: sid,
  });
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
    _attachments?: InboundAttachment[],
    runContext?: RunContext,
    loadout?: LoadoutEntry[],
    subject?: string,
    roleKeys?: string[],
    threadContent?: LoadoutEntry,
    roles?: LoadoutEntry[],
  ): Promise<DeliverResult> {
    this.calls.push({
      channel: handle.channel,
      message,
      session,
      ...(runContext ? { runContext } : {}),
      ...(subject ? { subject } : {}),
      ...(loadout ? { loadout } : {}),
      ...(threadContent ? { threadContent } : {}),
      // Record roles/roleKeys only when NON-EMPTY, so an unwired/no-roles turn (the drain
      // defaults both to `[]`) reads as absent — the no-roles invariant.
      ...(roles && roles.length ? { roles } : {}),
      ...(roleKeys && roleKeys.length ? { roleKeys } : {}),
      // Phase 3: the model on the handle deliver actually received — thread-first (effective)
      // when the drain resolved a thread config, the def's spec.model otherwise.
      ...(handle.spec?.model ? { model: handle.spec.model } : {}),
    });
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    // Per-THREAD concurrency: key by (channel, subject) so two subjects of one agent are
    // distinct threads (may interleave) but the SAME (name, subject) must stay serial.
    const threadKey = `${handle.channel}::${subject ?? ""}`;
    const cur = (this.inFlightByThread.get(threadKey) ?? 0) + 1;
    this.inFlightByThread.set(threadKey, cur);
    this.maxConcurrentByThread.set(
      threadKey,
      Math.max(this.maxConcurrentByThread.get(threadKey) ?? 0, cur),
    );
    try {
      // Emit any configured interim events (mirrors the real backend streaming text +
      // tool_use as the turn runs) so the registry's forwarding can be asserted.
      if (onInterim) for (const e of this.interimToEmit) onInterim(e);
      // A per-subject gate (if set for THIS turn's subject) takes precedence over the shared
      // gate — so a test can release subject B while subject A is still held.
      const subjectGate = subject !== undefined ? this.gateBySubject.get(subject) : undefined;
      if (subjectGate) await subjectGate.promise;
      else if (this.gate) await this.gate.promise;
      if (this.throwOnce) {
        const e = this.throwOnce;
        this.throwOnce = null;
        throw e;
      }
      return this.resultFor(message, session.id);
    } finally {
      this.inFlight--;
      this.inFlightByThread.set(threadKey, (this.inFlightByThread.get(threadKey) ?? 1) - 1);
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
 * A recorder WriteOutbound that ALSO captures the stamped `threadId` (the outbound note's
 * `metadata.thread`, agent#163) — kept separate from {@link recorder} so the existing
 * exact-`toEqual` reply assertions stay unaffected. Used to pin that a single-threaded
 * outbound carries the DETERMINISTIC thread-NOTE id and a multi-threaded one carries the
 * per-fire id.
 */
function recorderWithThreadId(): {
  calls: { channel: string; reply: string; inReplyTo?: string; threadId?: string }[];
  fn: WriteOutbound;
} {
  const calls: { channel: string; reply: string; inReplyTo?: string; threadId?: string }[] = [];
  const fn: WriteOutbound = async (channel, reply, inReplyTo, threadId) => {
    calls.push({ channel, reply, ...(inReplyTo ? { inReplyTo } : {}), ...(threadId ? { threadId } : {}) });
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
 *
 * This recorder returns VOID (no id) — so any callback test using it exercises the
 * per-turn-id FALLBACK for `source_thread`. The id-pinning tests (agent#124) use
 * {@link threadRecorderWithIds} instead. (Pre-existing callback tests don't assert on
 * `source_thread`, so the void return doesn't affect them.)
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

/**
 * A recorder WriteThread that RETURNS the written note id — FAITHFUL to the
 * VaultTransport's path-as-id logic (agent#124), so a test can assert the callback's
 * `source_thread` equals what `query-notes { id }` would resolve:
 *  - single-threaded → the DETERMINISTIC id `Threads/<safeChannel>/<safeName>` (NOT the
 *    per-turn correlation id — the pre-#124 bug).
 *  - multi-threaded → the per-fire id `Threads/<safeChannel>/<threadId>`.
 * The sanitization mirrors {@link VaultTransport.singleThreadedPath}. Captures every write
 * in order; `idFor(thread)` exposes the same derivation so a test can compute the expected id.
 */
function threadRecorderWithIds(): {
  threads: ThreadNote[];
  ends: () => ThreadNote[];
  idFor: (thread: ThreadNote) => string;
  fn: WriteThread;
} {
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-");
  const idFor = (thread: ThreadNote): string => {
    const safeChannel = slug(thread.channel);
    if (thread.mode === "single-threaded") {
      return `Threads/${safeChannel}/${slug(thread.name ?? thread.channel)}`;
    }
    return `Threads/${safeChannel}/${thread.threadId ?? "no-id"}`;
  };
  const threads: ThreadNote[] = [];
  const fn: WriteThread = async (thread) => {
    threads.push(thread);
    return { id: idFor(thread) };
  };
  return {
    threads,
    ends: () => threads.filter((t) => t.phase !== "start"),
    idFor,
    fn,
  };
}

/** A single-threaded spec (the DEFAULT mode — one upserting thread note per channel). */
const specSingleThreaded = (name: string, channel = name): AgentSpec => ({
  name,
  channels: [channel],
  mode: "single-threaded",
});

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

  test("deregister drops the indexes + tears down the backend handle (stop)", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    await reg.register(specFor("eng"));
    expect(await reg.deregister("eng")).toBe(true);
    expect(reg.hasChannel("eng")).toBe(false);
    expect(reg.hasName("eng")).toBe(false);
    // deregister calls backend.stop (a no-op for programmatic) — it does NOT clear the
    // thread-note session; re-registering should resume. Wiping continuity is resetSession.
    expect(backend.stopped.has("eng")).toBe(true);
    // A second deregister is a no-op false.
    expect(await reg.deregister("eng")).toBe(false);
  });

  test("resetSession CLEARS the thread-note session (via clearSession) WITHOUT deregistering", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    // Track the clearSession invocations + simulate the note's session being wiped: after a
    // clear, readSession returns undefined for that (channel, name).
    const cleared: { channel: string; name: string }[] = [];
    let priorSession: string | undefined = "sess-OLD";
    const clearSession = async (channel: string, name: string) => {
      cleared.push({ channel, name });
      priorSession = undefined; // the note's session is now empty.
    };
    const reader: { calls: { channel: string; name: string }[] } = { calls: [] };
    const readSession = async (channel: string, name: string) => {
      reader.calls.push({ channel, name });
      return priorSession;
    };
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: fn,
      writeThread: threads.fn,
      readSession,
      clearSession,
    });
    await reg.register(specFor("eng"));

    // RESET → invokes clearSession with the right (channel, name); does NOT deregister.
    expect(await reg.resetSession("eng")).toBe(true);
    expect(cleared).toEqual([{ channel: "eng", name: "eng" }]);
    expect(reg.hasName("eng")).toBe(true); // still registered.
    // reset() does NOT route through backend.stop anymore (the session lives on the note).
    expect(backend.stopped.has("eng")).toBe(false);

    // BONUS — after the reset, the next drain finds NO prior session → a fresh {resume:false}
    // create (self-heal), proving reset actually wiped continuity (not a dead no-op).
    reg.enqueue("eng", { content: "after reset" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);

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
  test("a completed MULTI-THREADED turn materializes an #agent/thread note (status ok) carrying definition/mode/name", async () => {
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
    // A user-facing failure note IS now written for a failed turn (carries the reason — the
    // reason lives in that note + the turn event, NOT the thread body the daemon no longer writes).
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
    // A user-facing failure note IS now written for a failed turn (carries the reason — the
    // reason lives in that note + the turn event, NOT the thread body the daemon no longer writes).
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.reply).toContain("mint refused");
  });

  test("a turn with an empty reply STILL materializes a thread note (status ok)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specMultiThreaded("digest"));

    reg.enqueue("digest", { content: "tool-only run" });
    await until(() => threads.ends().length === 1);
    // The working-ensure (phase:start) preceded the empty-reply final record.
    expect(threads.starts()).toHaveLength(1);
    expect(threads.ends()[0]!.status).toBe("ok");
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
    expect(threads.ends()[1]!.status).toBe("error");
    expect(threads.ends()[1]!.mode).toBe("single-threaded");
    // The re-record reuses the SAME per-turn threadId + sameTurn (no double-count, no dup).
    expect(threads.ends()[1]!.threadId).toBe(threads.ends()[0]!.threadId!);
    expect(threads.ends()[1]!.sameTurn).toBe(true);
    // Transient → the outbound was retried the full budget (1 initial + OUTBOUND_MAX_RETRIES).
    expect(outboundAttempts).toBe(1 + OUTBOUND_MAX_RETRIES);
  });
});

describe("ProgrammaticAgentRegistry — thread content as context (DESIGN-2026-06-29-thread-content-and-skills.md)", () => {
  test("the drain READS thread content (readThreadContent) + PASSES it to deliver (the threadContent param)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const seen: { channel: string; name: string; subject?: string }[] = [];
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readThreadContent: async (channel, name, subject) => {
        seen.push({ channel, name, ...(subject ? { subject } : {}) });
        return { path: `Threads/${channel}/${name}`, content: "this thread's standing mandate" };
      },
    });
    await reg.register(specFor("eng")); // single-threaded (default).

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);

    // The drain consulted readThreadContent with the channel + def name…
    expect(seen).toEqual([{ channel: "eng", name: "eng" }]);
    // …and passed the resolved entry to deliver as `threadContent` (composed into the prompt
    // BETWEEN the def and the loadout — the composition order is asserted in programmatic.test.ts).
    expect(backend.calls[0]!.threadContent).toEqual({
      path: "Threads/eng/eng",
      content: "this thread's standing mandate",
    });
  });

  test("UNWIRED readThreadContent → deliver receives no thread content (the no-thread-content invariant)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.threadContent).toBeUndefined();
  });

  test("a readThreadContent THROW is swallowed — the turn still runs (best-effort, no thread content)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readThreadContent: async () => {
        throw new Error("vault unreachable");
      },
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    // The turn ran (the read failure didn't strand it) with no thread content.
    expect(backend.calls[0]!.threadContent).toBeUndefined();
    expect(rec.calls).toHaveLength(1);
  });
});

describe("ProgrammaticAgentRegistry — config THREAD-FIRST (Phase 3, DESIGN-2026-06-29-threads-roles-context.md)", () => {
  test("the thread's model WINS over the def — deliver receives the thread-first model", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const seen: { channel: string; name: string; subject?: string }[] = [];
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readThreadConfig: async (channel, name, subject) => {
        seen.push({ channel, name, ...(subject ? { subject } : {}) });
        return { model: "sonnet" }; // the thread says sonnet…
      },
    });
    await reg.register({ ...specFor("eng"), model: "opus" }); // …the def says opus.

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);

    // The drain consulted readThreadConfig with the channel + def name…
    expect(seen).toEqual([{ channel: "eng", name: "eng" }]);
    // …and handed deliver the THREAD's model (the thread wins; the def is the fallback).
    expect(backend.calls[0]!.model).toBe("sonnet");
  });

  test("DEF FALLBACK: no thread model → deliver receives the def's spec.model", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readThreadConfig: async () => ({}), // the thread carries no model.
    });
    await reg.register({ ...specFor("eng"), model: "opus" });

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.model).toBe("opus"); // def fallback, unchanged.
  });

  test("UNWIRED readThreadConfig → deliver receives the def's spec.model (byte-identical to pre-Phase-3)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register({ ...specFor("eng"), model: "opus" });

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.model).toBe("opus");
  });

  test("a readThreadConfig THROW is swallowed — the turn runs on the def config", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readThreadConfig: async () => {
        throw new Error("vault unreachable");
      },
    });
    await reg.register({ ...specFor("eng"), model: "opus" });

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.model).toBe("opus"); // fell back to the def config.
    expect(rec.calls).toHaveLength(1);
  });

  test("recordThread STAMPS the def's model/backend onto the thread note (so it self-carries config)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register({ ...specFor("eng"), model: "opus", backend: "programmatic" });

    reg.enqueue("eng", { content: "go" });
    await until(() => threads.ends().length === 1);
    // The thread note carries the resolved config (the transport stamps it write-if-absent).
    expect(threads.ends()[0]!.model).toBe("opus");
    expect(threads.ends()[0]!.backend).toBe("programmatic");
  });
});

describe("ProgrammaticAgentRegistry — roles as the capability layer (DESIGN-2026-06-29-threads-roles-context.md)", () => {
  test("the drain READS roles (readRoles) + PASSES content as `roles` (layer ①) AND keys as `roleKeys`", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const seen: { channel: string; name: string; subject?: string }[] = [];
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readRoles: async (channel, name, subject) => {
        seen.push({ channel, name, ...(subject ? { subject } : {}) });
        return {
          entries: [{ path: `Roles/PM`, content: "PM hat." }],
          grantKeys: ["role--Roles-PM"],
        };
      },
    });
    await reg.register(specFor("eng")); // single-threaded (default).

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);

    // The drain consulted readRoles with the channel + def name…
    expect(seen).toEqual([{ channel: "eng", name: "eng" }]);
    // …and threaded BOTH the content entries (layer ①, composed FIRST) AND the grant keys
    // (the capability source unioned with the def's own — proved in programmatic.test.ts).
    expect(backend.calls[0]!.roles).toEqual([{ path: "Roles/PM", content: "PM hat." }]);
    expect(backend.calls[0]!.roleKeys).toEqual(["role--Roles-PM"]);
  });

  test("UNWIRED readRoles → deliver receives no roles + no role keys (the no-roles invariant)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    // The fake records `roles`/`roleKeys` only when non-empty → both absent (the no-roles path).
    expect(backend.calls[0]!.roles).toBeUndefined();
    expect(backend.calls[0]!.roleKeys).toBeUndefined();
  });

  test("a readRoles THROW is swallowed — the turn still runs (best-effort, def body + grants alone)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      readRoles: async () => {
        throw new Error("vault unreachable");
      },
    });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "go" });
    await until(() => backend.calls.length === 1);
    // The turn ran (the read failure didn't strand it) with no roles + no role keys.
    expect(backend.calls[0]!.roles).toBeUndefined();
    expect(backend.calls[0]!.roleKeys).toBeUndefined();
    expect(rec.calls).toHaveLength(1);
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
    // The END record carries the session claude echoed (the persisted thread≡session record).
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.session).toBe("11111111-1111-4111-8111-111111111111");
    // The START-ensure carries NO session (FIX 2) — it runs before claude, so no session is
    // established yet; persisting one there would brick the next turn if claude never inited.
    // (Continuity for a single-threaded resume is preserved by the transport's prior-read.)
    expect(threads.starts()[0]!.session).toBeUndefined();
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

  test("FIX 2 — a failed turn that established NO session persists NONE → next turn self-heals (no brick)", async () => {
    const backend = new FakeBackend();
    // A turn that FAILS before claude ever creates a session: { ok:false } with NO sessionId
    // (claude exited before emitting an init/result session_id). The OLD code persisted the
    // passed uuid here → next turn `--resume`d a phantom id → "No conversation found" →
    // permanent brick. FIX 2: persist NOTHING when claude echoed no session.
    backend.resultFor = () => ({ ok: false, error: "claude exited 1 before init" });
    const rec = recorder();
    const threads = threadRecorder();
    // Simulate the note: readSession returns whatever the last persisted end-record carried.
    let stored: string | undefined; // no prior session.
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: async (t) => {
        threads.threads.push(t);
        // Mirror the transport's persistence: an end record with a session sets it; a start
        // or a sessionless end leaves the prior value (the transport preserves single-threaded).
        if (t.phase !== "start" && t.session) stored = t.session;
      },
      readSession: async () => stored,
    });
    await reg.register(specFor("eng")); // single-threaded (default).

    // Turn 1 — fails before establishing a session.
    reg.enqueue("eng", { content: "boom" });
    await until(() => threads.ends().length === 1);
    // The error end-record carries NO session (claude echoed none) — so the note stays clean.
    expect(threads.ends()[0]!.status).toBe("error");
    expect(threads.ends()[0]!.session).toBeUndefined();
    expect(stored).toBeUndefined(); // nothing persisted → no phantom to --resume.

    // Turn 2 — readSession finds no session → a FRESH {resume:false} create (self-heal,
    // NOT a brick). The next turn is a clean new conversation, not a doomed --resume.
    reg.enqueue("eng", { content: "again" });
    await until(() => backend.calls.length === 2);
    expect(backend.calls[1]!.session.resume).toBe(false);
    expect(backend.calls[1]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
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
    // error (status only — the daemon no longer writes the thread body). (A working-ensure preceded.)
    expect(threads.ends()).toHaveLength(2);
    expect(threads.ends()[1]!.status).toBe("error");
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

// ─────────────────────────────────────────────────────────────────────────────────────────
// roles×threads NEXT slice (#120) — F. subject routing + the PER-THREAD serial guarantee.
//
// The load-bearing invariant (registry.ts:13-20, generalized): a given (name, subject) thread
// is NEVER processed by two concurrent `claude -p` turns, BUT two DIFFERENT subjects of one
// multi-threaded agent MAY run concurrently. A single-threaded / no-subject agent maps to
// exactly ONE queue (the bare channel), byte-identical to HEAD.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("ProgrammaticAgentRegistry — F. per-thread serial guarantee (#120)", () => {
  test("two messages with the SAME (name, subject) are processed ONE AT A TIME, FIFO, never concurrent", async () => {
    const backend = new FakeBackend();
    // Hold subject "alpha" so the second alpha message must wait behind the first.
    const alphaGate = deferred<void>();
    backend.gateBySubject.set("alpha", { promise: alphaGate.promise, resolve: alphaGate.resolve });
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specMultiThreaded("digest", "digest"));

    reg.enqueue("digest", { content: "a1", subject: "alpha" });
    await until(() => backend.calls.length === 1);
    // A SECOND alpha message arrives while the first is held — it must QUEUE behind it.
    reg.enqueue("digest", { content: "a2", subject: "alpha" });
    // Still exactly one alpha turn STARTED (the gate holds the first; the second waits serially).
    expect(backend.calls).toHaveLength(1);

    alphaGate.resolve();
    await until(() => rec.calls.length === 2);
    // FIFO + strictly serial: a1 then a2, NEVER concurrent for the (digest, alpha) thread.
    expect(backend.calls.map((c) => c.message)).toEqual(["a1", "a2"]);
    expect(backend.maxConcurrentByThread.get("digest::alpha")).toBe(1);
  });

  test("two DIFFERENT subjects of one agent can run CONCURRENTLY (interleave), each serial", async () => {
    const backend = new FakeBackend();
    // Hold subject "alpha" indefinitely; leave "beta" ungated so it runs to completion while
    // alpha is still in flight — proving the two subject threads interleave.
    const alphaGate = deferred<void>();
    backend.gateBySubject.set("alpha", { promise: alphaGate.promise, resolve: alphaGate.resolve });
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specMultiThreaded("digest", "digest"));

    // Start alpha (held), then beta (free). If subjects shared one queue, beta would block
    // behind the held alpha and NEVER complete; concurrency lets beta finish first.
    reg.enqueue("digest", { content: "a1", subject: "alpha" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("digest", { content: "b1", subject: "beta" });
    // beta completes WHILE alpha is still held — only possible if the two run concurrently.
    await until(() => rec.calls.some((c) => c.reply === "reply:b1"));
    expect(rec.calls.map((c) => c.reply)).toContain("reply:b1");
    // alpha hasn't been delivered as an outbound yet (its turn is still gated).
    expect(rec.calls.some((c) => c.reply === "reply:a1")).toBe(false);

    // Release alpha; it now completes too.
    alphaGate.resolve();
    await until(() => rec.calls.some((c) => c.reply === "reply:a1"));
    // Each subject thread stayed serial (≤1 concurrent within a thread) even though the two
    // threads ran concurrently across the channel.
    expect(backend.maxConcurrentByThread.get("digest::alpha")).toBe(1);
    expect(backend.maxConcurrentByThread.get("digest::beta")).toBe(1);
    // The drain threaded the subject through to the backend (the per-thread workspace key, G).
    const alphaCall = backend.calls.find((c) => c.message === "a1");
    const betaCall = backend.calls.find((c) => c.message === "b1");
    expect(alphaCall?.subject).toBe("alpha");
    expect(betaCall?.subject).toBe("beta");
  });

  test("a SINGLE-threaded agent maps every message to ONE queue (the channel), subject ignored for routing", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng")); // single-threaded (default).

    // Even if messages carry DIFFERENT subjects, a single-threaded agent serializes them ALL
    // on the one channel queue (the subject is NOT a routing axis for single-threaded).
    reg.enqueue("eng", { content: "m1", subject: "alpha" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("eng", { content: "m2", subject: "beta" });
    // The second is QUEUED behind the first (one queue) — not started concurrently.
    expect(backend.calls).toHaveLength(1);
    expect(reg.statusOf("eng")).toEqual({ state: "queued", queued: 1 });

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(backend.calls.map((c) => c.message)).toEqual(["m1", "m2"]);
    // Never two concurrent turns for the single-threaded channel — the HEAD serial guarantee.
    expect(backend.maxConcurrent).toBe(1);
  });

  test("a multi-threaded agent with NO subject maps to ONE queue (the channel) — HEAD behavior", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specMultiThreaded("digest", "digest"));

    // No subject on either fire → both route to the bare channel queue (HEAD), strictly serial.
    reg.enqueue("digest", { content: "f1" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("digest", { content: "f2" });
    expect(backend.calls).toHaveLength(1);

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(backend.calls.map((c) => c.message)).toEqual(["f1", "f2"]);
    expect(backend.maxConcurrent).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// threads-only Phase B — thread registry (byThread) + drain-key-is-the-thread-id +
// resolve-or-create + status-driven teardown. DESIGN-2026-06-29-threads-only.md §5/§9.
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("ProgrammaticAgentRegistry — Phase B: byThread index + thread-id routing", () => {
  test("register indexes by thread-id; hasThread/channelForThread resolve it (thread-id ≡ name for the live cast)", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });

    expect(reg.hasThread("steward")).toBe(false);
    await reg.register(specFor("steward"));
    // thread-id ≡ name ≡ channel for the live cast: a metadata.thread:steward inbound resolves
    // the same live agent a metadata.agent:steward inbound does.
    expect(reg.hasThread("steward")).toBe(true);
    expect(reg.channelForThread("steward")).toBe("steward");

    // deregister drops the byThread entry too — a thread-addressed inbound stops resolving.
    await reg.deregister("steward");
    expect(reg.hasThread("steward")).toBe(false);
    expect(reg.channelForThread("steward")).toBeUndefined();
  });

  test("drain key = the thread-id directly: same thread → strictly serial (FIFO, never concurrent)", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>(); // hold ALL turns so we can observe what started.
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    // Two messages for the SAME thread-id on the channel → ONE drain key → strictly serial.
    reg.enqueue("eng", { content: "t1-a", thread: "t1" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("eng", { content: "t1-b", thread: "t1" });
    // The second waits behind the first (one queue for thread t1) — only one started.
    expect(backend.calls).toHaveLength(1);

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(backend.calls.map((c) => c.message)).toEqual(["t1-a", "t1-b"]);
    expect(backend.maxConcurrent).toBe(1); // never two concurrent for the same thread.
  });

  test("different thread-ids on ONE channel run CONCURRENTLY (distinct drain keys)", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>(); // hold both turns; if they shared a queue only 1 would start.
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    // Two DIFFERENT thread-ids → two distinct drain keys → two distinct drain promises → BOTH
    // start while the gate holds them (concurrent). A shared queue would start only one.
    reg.enqueue("eng", { content: "t1", thread: "t1" });
    reg.enqueue("eng", { content: "t2", thread: "t2" });
    await until(() => backend.calls.length === 2);
    expect(backend.calls).toHaveLength(2); // both in flight concurrently.
    expect(backend.maxConcurrent).toBe(2);

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(backend.calls.map((c) => c.message).sort()).toEqual(["t1", "t2"]);
  });

  test("a def-agent inbound with NO thread + NO subject still maps to ONE queue (the bare channel = HEAD)", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>();
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("steward")); // single-threaded def (the weave shape).

    // The live weave path: no thread, no subject → the bare-channel drain key, strictly serial.
    reg.enqueue("steward", { content: "weave-1" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("steward", { content: "weave-2" });
    expect(backend.calls).toHaveLength(1);
    expect(reg.statusOf("steward")).toEqual({ state: "queued", queued: 1 });

    gate.resolve();
    await until(() => rec.calls.length === 2);
    expect(backend.calls.map((c) => c.message)).toEqual(["weave-1", "weave-2"]);
    expect(backend.maxConcurrent).toBe(1);
  });
});

describe("ProgrammaticAgentRegistry — Phase B: resolve-or-create (own, don't 401-drop)", () => {
  test("a LIVE thread → 'live'; the caller routes to its channel", async () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    await reg.register(specFor("steward"));
    expect(reg.resolveOrCreateThread("steward", true)).toBe("live");
  });

  test("a NOT-YET-LIVE but RESOLVABLE thread → 'owned': marked expected so queuePending BUFFERS (then replays on register)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });

    // No agent live for "proj-thread" yet, but a thread note exists (resolvable=true).
    expect(reg.resolveOrCreateThread("proj-thread", true)).toBe("owned");
    expect(reg.isExpected("proj-thread")).toBe(true);

    // queuePending now OWNS the inbound (it's expected) instead of returning "unknown"/dropping.
    expect(reg.queuePending("proj-thread", { content: "hello", thread: "proj-thread" })).toBe("queued");
    expect(reg.pendingCount("proj-thread")).toBe(1);

    // When the thread agent finally registers, the buffered inbound REPLAYS (not lost).
    await reg.register(specFor("proj-thread"));
    await until(() => rec.calls.length === 1);
    expect(rec.calls[0]!.reply).toBe("reply:hello");
    expect(reg.pendingCount("proj-thread")).toBe(0);
  });

  test("a genuinely UNKNOWN thread (not live, not resolvable) → 'unknown' (today's 401 path; NOT marked expected)", () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    expect(reg.resolveOrCreateThread("ghost", false)).toBe("unknown");
    // NOT expected → queuePending would return "unknown" (the caller 401s, as today).
    expect(reg.isExpected("ghost")).toBe(false);
    expect(reg.queuePending("ghost", { content: "x" })).toBe("unknown");
  });
});

describe("ProgrammaticAgentRegistry — Phase B: status-driven teardown (archiveThread)", () => {
  test("archiveThread clears a thread's queues + indexes (the def-set-diff teardown replacement)", async () => {
    const backend = new FakeBackend();
    const gate = deferred<void>(); // hold the turn so a second message sits in the queue.
    backend.gate = { promise: gate.promise, resolve: gate.resolve };
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });
    await reg.register(specFor("eng"));

    // Build up queue state for thread "t1": one in flight (held), one queued behind it.
    reg.enqueue("eng", { content: "t1-a", thread: "t1" });
    await until(() => backend.calls.length === 1);
    reg.enqueue("eng", { content: "t1-b", thread: "t1" });
    expect(reg.statusOf("t1")).toEqual({ state: "queued", queued: 1 });
    expect(reg.hasThread("eng")).toBe(true); // the registered agent's thread-id (eng) resolves.

    // Status transition → archive: tear the thread down. The QUEUED message is dropped, the
    // byThread entry for the registered agent is cleared.
    expect(reg.archiveThread("t1")).toBe(true); // had queue state.
    expect(reg.statusOf("t1")).toEqual({ state: "idle", queued: 0 }); // queue cleared.

    // Tearing down the registered agent's own thread-id stops thread-routing to it.
    expect(reg.archiveThread("eng")).toBe(true);
    expect(reg.hasThread("eng")).toBe(false);

    gate.resolve(); // release the in-flight turn (it self-completes; nothing left queued).
    // A second archive of an unknown thread is a clean no-op false.
    expect(reg.archiveThread("never-existed")).toBe(false);
  });

  test("archiveThread drops an EXPECTED-but-not-live thread's pending buffer (owned message can't strand)", () => {
    const backend = new FakeBackend();
    const { fn } = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: fn });

    reg.resolveOrCreateThread("proj-thread", true); // expected.
    reg.queuePending("proj-thread", { content: "buffered", thread: "proj-thread" });
    expect(reg.pendingCount("proj-thread")).toBe(1);
    expect(reg.isExpected("proj-thread")).toBe(true);

    expect(reg.archiveThread("proj-thread")).toBe(true);
    expect(reg.pendingCount("proj-thread")).toBe(0);
    expect(reg.isExpected("proj-thread")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// roles×threads NEXT slice (#120) — F. per-thread session CONTINUITY.
//
// A multi-threaded SUBJECT thread reads/writes its session at the SUBJECT-scoped thread note
// and `--resume`s it (turning "fresh thread per fire" into "resume the named thread"); a
// multi-threaded agent with NO subject still never resumes (HEAD), and a single-threaded agent
// resumes its def-named note (HEAD).
// ─────────────────────────────────────────────────────────────────────────────────────────
describe("ProgrammaticAgentRegistry — F. per-thread session continuity (#120)", () => {
  function subjectSessionReader(priorBySubject: Record<string, string | undefined> = {}): {
    calls: { channel: string; name: string; subject?: string }[];
    fn: (channel: string, name: string, subject?: string) => Promise<string | undefined>;
  } {
    const calls: { channel: string; name: string; subject?: string }[] = [];
    const fn = async (channel: string, name: string, subject?: string) => {
      calls.push({ channel, name, ...(subject ? { subject } : {}) });
      return priorBySubject[subject ?? ""];
    };
    return { calls, fn };
  }

  test("a multi-threaded SUBJECT thread RESUMES the session persisted on its subject-scoped note", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    // A PRIOR session exists for subject "alpha" only.
    const reader = subjectSessionReader({ alpha: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specMultiThreaded("digest", "digest"));

    reg.enqueue("digest", { content: "second fire", subject: "alpha" });
    await until(() => backend.calls.length === 1);

    // readSession was consulted with the channel, the DEF NAME, and the SUBJECT (subject-scoped).
    expect(reader.calls).toEqual([{ channel: "digest", name: "digest", subject: "alpha" }]);
    // A prior session for this subject → RESUME it (NOT a fresh uuid) — per-thread continuity.
    expect(backend.calls[0]!.session).toEqual({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      resume: true,
    });
    // The thread note carries the SUBJECT so the transport upserts the subject-scoped note.
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.subject).toBe("alpha");
    expect(threads.ends()[0]!.session).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  test("a multi-threaded subject with NO prior session CREATES a fresh one (first fire of the named thread)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = subjectSessionReader({}); // no prior for any subject.
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specMultiThreaded("digest", "digest"));

    reg.enqueue("digest", { content: "first fire", subject: "alpha" });
    await until(() => backend.calls.length === 1);

    expect(reader.calls).toEqual([{ channel: "digest", name: "digest", subject: "alpha" }]);
    // No prior → CREATE (resume:false) with a fresh uuid, persisted onto the subject note.
    expect(backend.calls[0]!.session.resume).toBe(false);
    expect(backend.calls[0]!.session.id).toMatch(/^[0-9a-f-]{36}$/);
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.subject).toBe("alpha");
    expect(threads.ends()[0]!.session).toBe(backend.calls[0]!.session.id);
  });

  test("a multi-threaded agent with NO subject NEVER consults readSession (fresh per fire — HEAD)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = subjectSessionReader({ "": "should-never-be-used" });
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specMultiThreaded("digest", "digest"));

    reg.enqueue("digest", { content: "no-subject fire" });
    await until(() => backend.calls.length === 1);

    // No subject on a multi-threaded agent → readSession is NEVER consulted (HEAD: each fire
    // is a fresh thread), and the session is created fresh.
    expect(reader.calls).toHaveLength(0);
    expect(backend.calls[0]!.session.resume).toBe(false);
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.subject).toBeUndefined();
  });

  test("NULL-SUBJECT INVARIANT — a single-threaded agent's path is byte-identical to HEAD (the steward weave)", async () => {
    // The live steward weave is single-threaded + carries NO subject. This pins that nothing
    // in F changes its drain: readSession is keyed on (channel, def-name, undefined), the
    // session resumes the def-named note, the thread note carries NO subject, and the backend
    // sees NO subject. A regression here breaks the 4am weave.
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reader = subjectSessionReader({ "": "55555555-5555-4555-8555-555555555555" });
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
      readSession: reader.fn,
    });
    await reg.register(specFor("steward")); // single-threaded, no subject.

    reg.enqueue("steward", { content: "weave digest" }); // no subject — the runner fire.
    await until(() => backend.calls.length === 1);

    // readSession consulted with the def name and NO subject (the deterministic def-named note).
    expect(reader.calls).toEqual([{ channel: "steward", name: "steward" }]);
    // Resumes the def-named note's session (HEAD single-threaded behavior).
    expect(backend.calls[0]!.session).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      resume: true,
    });
    // The backend sees NO subject (no per-thread workspace re-key — sessions/<name>/ unchanged).
    expect(backend.calls[0]!.subject).toBeUndefined();
    // The thread note carries NO subject (the deterministic def-named upsert, unchanged).
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.subject).toBeUndefined();
    expect(threads.ends()[0]!.name).toBe("steward");
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
    // The turn is in flight but hasn't produced its end record yet (gated).
    expect(backend.calls).toHaveLength(1);
    expect(threads.ends()).toHaveLength(0);

    // Release the turn → it completes → the FINAL (ok) record lands, same threadId.
    gate.resolve();
    await until(() => threads.ends().length === 1);
    expect(threads.ends()[0]!.status).toBe("ok");
    expect(threads.ends()[0]!.threadId).toBe(threads.starts()[0]!.threadId!);
  });

  test("the start-ensure is status:working and the end is status:ok (the daemon never writes the thread body)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const threads = threadRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeThread: threads.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => threads.ends().length === 1);
    // The working-ensure carries status:working; the end carries status:ok. Neither carries a
    // body — the daemon writes metadata only (the reply lives in the outbound transcript note).
    expect(threads.starts()[0]!.status).toBe("working");
    expect(threads.ends()[0]!.status).toBe("ok");
    expect(rec.calls[0]!.reply).toBe("reply:hi");
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

  // ── source_thread is a RESOLVABLE thread-note id for BOTH modes (agent#124) ──────────────
  // The callback's `source_thread` must be the actual written thread-note id (what
  // `query-notes { id }` resolves), not the per-turn correlation UUID. The faithful
  // `threadRecorderWithIds` returns the SAME id the VaultTransport would (single-threaded:
  // the deterministic name path; multi-threaded: the per-fire uuid path), so these tests pin
  // the end-to-end contract: the id the seam wrote is the id the orchestrator gets back.

  test("source_thread = the WRITTEN single-threaded thread-note id (deterministic path, NOT the per-turn id)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId("reply-note-1");
    const threads = threadRecorderWithIds();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeThread: threads.fn,
      writeCallback: cb.fn,
    });
    // DEFAULT mode is single-threaded; be explicit here.
    await reg.register(specSingleThreaded("worker"));

    reg.enqueue("worker", { content: "sub-task", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);

    const endRecord = threads.ends().at(-1)!;
    const expectedId = threads.idFor(endRecord); // "Threads/worker/worker" (det. name path).
    const { meta } = cb.calls[0]!;
    expect(meta.source_thread).toBe(expectedId); // RESOLVABLE — the written note id.
    expect(meta.source_thread).toBe("Threads/worker/worker"); // the deterministic leaf,
    // …and CRUCIALLY not a bare per-turn correlation UUID (the pre-#124 bug).
    expect(meta.source_thread).not.toMatch(/^[0-9a-f-]{36}$/);
    // The single-threaded + reply common case still also carries source_message.
    expect(meta.source_message).toBe("reply-note-1");
  });

  test("source_thread = the WRITTEN multi-threaded per-fire thread-note id", async () => {
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId("reply-note-2");
    const threads = threadRecorderWithIds();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeThread: threads.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specMultiThreaded("worker"));

    reg.enqueue("worker", { content: "sub-task", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);

    const endRecord = threads.ends().at(-1)!;
    const expectedId = threads.idFor(endRecord); // "Threads/worker/<per-fire uuid>".
    const { meta } = cb.calls[0]!;
    expect(meta.source_thread).toBe(expectedId); // RESOLVABLE — the per-fire note id.
    expect(meta.source_thread).toMatch(/^Threads\/worker\/[0-9a-f-]{36}$/);
    // Concrete cross-check (not just the regex): the per-fire leaf IS the recorded threadId,
    // so a formula bug in idFor's multi-threaded branch can't be masked.
    expect(meta.source_thread).toBe(`Threads/worker/${endRecord.threadId}`);
    expect(meta.source_message).toBe("reply-note-2");
  });

  test("single-threaded ERROR turn: source_thread is STILL the resolvable thread-note id (no source_message)", async () => {
    // The narrow edge the issue targets: a single-threaded recipient whose turn produced NO
    // reply (an error). `source_message` is absent — pre-#124 the orchestrator had only an
    // unresolvable per-turn UUID. Now `source_thread` is the written (error) thread note id.
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const out = recorderWithId();
    const threads = threadRecorderWithIds();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeThread: threads.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specSingleThreaded("worker"));

    reg.enqueue("worker", { content: "do it", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);

    const endRecord = threads.ends().at(-1)!;
    expect(endRecord.status).toBe("error"); // the recorded turn failed,
    const { meta } = cb.calls[0]!;
    expect(meta.status).toBe("error");
    expect(meta.source_message).toBeUndefined(); // no delivered reply note on an error turn,
    // …yet source_thread is the RESOLVABLE written thread-note id (the agent#124 fix).
    expect(meta.source_thread).toBe(threads.idFor(endRecord));
    expect(meta.source_thread).toBe("Threads/worker/worker");
    expect(meta.source_thread).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  test("single-threaded EMPTY/tool-only turn (no reply): source_thread is the resolvable thread-note id, no source_message", async () => {
    // A success turn that produced NO text (tool-only work) → no outbound note → no
    // source_message. The callback still fires (status:ok) and carries the resolvable
    // source_thread so the orchestrator can pull the recipient's thread.
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" }); // empty reply → no outbound note.
    const out = recorderWithId();
    const threads = threadRecorderWithIds();
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeThread: threads.fn,
      writeCallback: cb.fn,
    });
    await reg.register(specSingleThreaded("worker"));

    reg.enqueue("worker", { content: "tool-only", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);

    expect(out.calls).toHaveLength(0); // no reply text → no outbound note written.
    const endRecord = threads.ends().at(-1)!;
    const { meta } = cb.calls[0]!;
    expect(meta.status).toBe("ok");
    expect(meta.source_message).toBeUndefined(); // no reply note to point at,
    expect(meta.source_thread).toBe(threads.idFor(endRecord)); // but the thread is resolvable.
    expect(meta.source_thread).toBe("Threads/worker/worker");
  });

  test("single-threaded OUTBOUND-FAILURE re-record: source_thread is the re-recorded (sameTurn) thread-note id", async () => {
    // The reply was produced but the outbound write failed after retries → the drain
    // re-records the SAME turn as status:error (sameTurn upsert) and calls back error. The
    // callback's source_thread must be the (resolvable) re-recorded thread-note id — pinning
    // the `?? threadNoteId` precedence leg on the outbound-failure terminal path.
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const threads = threadRecorderWithIds();
    // Always-fail outbound (a permanent 4xx → no retry); the reply was produced but lost.
    const alwaysFail: WriteOutbound = async () => {
      throw new Error("vault transport: write reply failed (400) bad request");
    };
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: alwaysFail,
      writeThread: threads.fn,
      writeCallback: cb.fn,
      outboundRetryBaseMs: 1,
    });
    await reg.register(specSingleThreaded("worker"));

    reg.enqueue("worker", { content: "x", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);

    const endRecord = threads.ends().at(-1)!; // the sameTurn error re-record.
    expect(endRecord.status).toBe("error");
    expect(endRecord.sameTurn).toBe(true);
    const { meta } = cb.calls[0]!;
    expect(meta.status).toBe("error");
    expect(meta.source_message).toBeUndefined(); // the outbound note never landed,
    // …but source_thread is the resolvable re-recorded thread-note id (agent#124).
    expect(meta.source_thread).toBe(threads.idFor(endRecord));
    expect(meta.source_thread).toBe("Threads/worker/worker");
  });

  test("falls back to the per-turn id when the WriteThread seam surfaces no id (e.g. no durable store)", async () => {
    // Defensive: a transport with no durable store (telegram) returns void from the seam.
    // The callback still fires with a source_thread — the per-turn id (a stable provenance
    // token, just not a pullable note). Never undefined.
    const backend = new FakeBackend();
    backend.resultFor = (m) => ({ ok: true, reply: "done:" + m });
    const out = recorderWithId();
    const voidThread: WriteThread = async () => {}; // returns void — no id.
    const cb = callbackRecorder();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: out.fn,
      writeThread: voidThread,
      writeCallback: cb.fn,
    });
    await reg.register(specSingleThreaded("worker"));

    reg.enqueue("worker", { content: "x", replyTo: "orchestrator" });
    await until(() => cb.calls.length === 1);
    const { meta } = cb.calls[0]!;
    // A bare per-turn UUID fallback — present (never undefined), just not a thread-note path.
    expect(meta.source_thread).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ProgrammaticAgentRegistry — run context injection (agent#162)", () => {
  test("a turn carries run context: a REAL now (ISO), session=new for a fresh turn", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => backend.calls.length === 1);

    const rc = backend.calls[0]!.runContext;
    expect(rc).toBeDefined();
    // A REAL wall-clock timestamp the headless turn would otherwise lack (parseable ISO).
    expect(typeof rc!.now).toBe("string");
    expect(Number.isFinite(Date.parse(rc!.now))).toBe(true);
    // No prior session (no readSession wired) → a fresh create → session=new.
    expect(rc!.session).toBe("new");
  });

  test("session=resumed when the single-threaded turn resumes a prior session", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const readSession = async () => "sess-PRIOR"; // a persisted single-threaded session.
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, readSession });
    await reg.register(specFor("uni-weaver"));

    reg.enqueue("uni-weaver", { content: "next turn" });
    await until(() => backend.calls.length === 1);

    expect(backend.calls[0]!.session.resume).toBe(true);
    expect(backend.calls[0]!.runContext!.session).toBe("resumed");
  });

  test("fired-by = scheduled-job:<id> for a runner fire; interactive otherwise; absent when no sender", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    // A SCHEDULED job fire (the runner stamps sender = runner:<jobId>).
    reg.enqueue("eng", { content: "cron tick", sender: "runner:morning-weave" });
    await until(() => backend.calls.length === 1);
    expect(backend.calls[0]!.runContext!.firedBy).toBe("scheduled-job:morning-weave");

    // An interactive / human message (a non-runner sender) → interactive.
    reg.enqueue("eng", { content: "hello", sender: "aaron" });
    await until(() => backend.calls.length === 2);
    expect(backend.calls[1]!.runContext!.firedBy).toBe("interactive");

    // No sender → fired-by OMITTED (the run context still carries now + session).
    reg.enqueue("eng", { content: "no sender" });
    await until(() => backend.calls.length === 3);
    expect(backend.calls[2]!.runContext!.firedBy).toBeUndefined();
  });
});

describe("runFiredBy — run-context provenance (agent#162)", () => {
  test("maps runner:<id> → scheduled-job:<id>, other senders → interactive, absent → undefined", () => {
    expect(runFiredBy("runner:morning-weave")).toBe("scheduled-job:morning-weave");
    expect(runFiredBy("aaron")).toBe("interactive");
    expect(runFiredBy("session")).toBe("interactive");
    expect(runFiredBy(undefined)).toBeUndefined();
    expect(runFiredBy("")).toBeUndefined();
  });
});

describe("outboundThreadId — mode-correct, resolvable thread id (agent#163)", () => {
  test("single-threaded → the resolvable thread-NOTE id; multi-threaded → the per-fire id", () => {
    // single-threaded: prefer the resolvable note id (the deterministic thread-NOTE path).
    expect(outboundThreadId(false, "turn-uuid", "Threads/eng/eng")).toBe("Threads/eng/eng");
    // multi-threaded: ALWAYS the per-fire turn id (which IS that fire's note leaf).
    expect(outboundThreadId(true, "turn-uuid", "Threads/eng/turn-uuid")).toBe("turn-uuid");
  });

  test("falls back to the per-turn id when no resolvable note id surfaced (never undefined)", () => {
    // single-threaded with no durable store / failed thread write → the per-turn id, never undefined.
    expect(outboundThreadId(false, "turn-uuid", undefined)).toBe("turn-uuid");
    expect(outboundThreadId(true, "turn-uuid", undefined)).toBe("turn-uuid");
  });
});

describe("ProgrammaticAgentRegistry — outbound metadata.thread is the resolvable thread id (agent#163)", () => {
  test("a SINGLE-THREADED outbound carries the DETERMINISTIC thread-NOTE id (NOT a per-turn UUID)", async () => {
    const backend = new FakeBackend();
    const rec = recorderWithThreadId();
    const threads = threadRecorderWithIds();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
    });
    // specFor → no mode → single-threaded (the default).
    await reg.register(specFor("uni-weaver"));

    reg.enqueue("uni-weaver", { content: "hello" });
    await until(() => rec.calls.length === 1);

    // The stamped `metadata.thread` is the agent's ONE deterministic thread-note id — the
    // SAME `query-notes { id }` resolves it across every turn (the stable resumed session),
    // NOT the per-turn correlation UUID that misled an observer into "a fresh session each run".
    const expected = `Threads/uni-weaver/uni-weaver`;
    expect(rec.calls[0]!.threadId).toBe(expected);
    expect(rec.calls[0]!.threadId).not.toMatch(/^[0-9a-f-]{36}$/); // it's a path, not a UUID.
    // It matches the actual written thread-note's id (faithful to VaultTransport's path-as-id).
    expect(rec.calls[0]!.threadId).toBe(threads.idFor(threads.ends()[0]!));
  });

  test("a single-threaded outbound carries the SAME thread id across turns (stable, not per-turn)", async () => {
    const backend = new FakeBackend();
    const rec = recorderWithThreadId();
    const threads = threadRecorderWithIds();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
    });
    await reg.register(specFor("uni-weaver"));

    reg.enqueue("uni-weaver", { content: "turn 1" });
    reg.enqueue("uni-weaver", { content: "turn 2" });
    await until(() => rec.calls.length === 2);

    // The whole point of #163: the stamped thread id is STABLE across turns (the resumed
    // single-threaded session), unlike the per-turn UUID that changed every run.
    expect(rec.calls[0]!.threadId).toBe(`Threads/uni-weaver/uni-weaver`);
    expect(rec.calls[1]!.threadId).toBe(rec.calls[0]!.threadId);
  });

  test("a MULTI-THREADED outbound carries the PER-FIRE id (distinct per fire — correct there)", async () => {
    const backend = new FakeBackend();
    const rec = recorderWithThreadId();
    const threads = threadRecorderWithIds();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
    });
    await reg.register(specMultiThreaded("digest", "digest", "Agents/digest"));

    reg.enqueue("digest", { content: "fire 1" });
    reg.enqueue("digest", { content: "fire 2" });
    await until(() => rec.calls.length === 2);

    // Multi-threaded: each fire is its own thread, so the per-fire id (the note leaf) is the
    // right link — and the two fires carry DIFFERENT ids (not collapsed to one).
    expect(rec.calls[0]!.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.calls[1]!.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.calls[0]!.threadId).not.toBe(rec.calls[1]!.threadId);
    // The stamped per-fire id is the leaf of that fire's written thread note (FIFO drain →
    // ends()[0] is fire 1).
    const end0 = threads.ends()[0]!;
    expect(threads.idFor(end0)).toBe(`Threads/digest/${rec.calls[0]!.threadId}`);
  });

  test("a single-threaded FAILURE note also carries the deterministic thread-note id (agent#163)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" }); // a failed turn → failure note.
    const rec = recorderWithThreadId();
    const threads = threadRecorderWithIds();
    const reg = new ProgrammaticAgentRegistry({
      backend,
      writeOutbound: rec.fn,
      writeThread: threads.fn,
    });
    await reg.register(specFor("uni-weaver"));

    reg.enqueue("uni-weaver", { content: "do it" });
    await until(() => rec.calls.length === 1);

    // The user-facing failure note (the only outbound on a failed turn) carries the SAME
    // resolvable, deterministic thread-note id — not a per-turn UUID.
    expect(rec.calls[0]!.reply).toContain("mint refused");
    expect(rec.calls[0]!.threadId).toBe(`Threads/uni-weaver/uni-weaver`);
    expect(rec.calls[0]!.threadId).not.toMatch(/^[0-9a-f-]{36}$/);
  });

  test("with NO durable thread store wired, a single-threaded outbound falls back to a per-turn id (never undefined)", async () => {
    const backend = new FakeBackend();
    const rec = recorderWithThreadId();
    // No writeThread → no resolvable note id → fall back to the per-turn UUID (still stamped).
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hi" });
    await until(() => rec.calls.length === 1);

    expect(rec.calls[0]!.threadId).toMatch(/^[0-9a-f-]{36}$/); // present, the fallback.
  });
});
