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
  type WriteOutbound,
  type WriteRun,
  type RunNote,
  type TurnEventSink,
  type TurnLifecycleEvent,
} from "./registry.ts";
import type { AgentBackend, AgentHandle, AgentStatus, DeliverResult, InterimSink } from "./types.ts";
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
  /** Per-call records, in arrival order. */
  readonly calls: { channel: string; message: string }[] = [];
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

  async deliver(handle: AgentHandle, message: string, onInterim?: InterimSink): Promise<DeliverResult> {
    this.calls.push({ channel: handle.channel, message });
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

/** A recorder WriteRun — captures every `#agent/run` note the registry writes. */
function runRecorder(): { runs: RunNote[]; fn: WriteRun } {
  const runs: RunNote[] = [];
  const fn: WriteRun = async (run) => {
    runs.push(run);
  };
  return { runs, fn };
}

/** A one-shot spec (writes an `#agent/run` note per fire). */
const specOneShot = (name: string, channel = name, definition?: string): AgentSpec => ({
  name,
  channels: [channel],
  mode: "one-shot",
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

    expect(backend.calls).toEqual([{ channel: "eng", message: "hello" }]);
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

  test("an ok:false turn writes NO note + does not crash/loop", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "do it" });
    await until(() => backend.calls.length === 1);
    await new Promise<void>((r) => setTimeout(r, 5));
    // Exactly ONE turn ran (no retry loop), and no note was written.
    expect(backend.calls).toHaveLength(1);
    expect(rec.calls).toHaveLength(0);
  });

  test("a deliver() that THROWS is caught — the worker survives + drains the rest", async () => {
    const backend = new FakeBackend();
    backend.throwOnce = new Error("surprise throw");
    const rec = recorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn });
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "first (throws)" });
    reg.enqueue("eng", { content: "second (ok)" });
    await until(() => rec.calls.length === 1);
    // Both turns ran; the throw on the first didn't strand the second.
    expect(backend.calls.map((c) => c.message)).toEqual(["first (throws)", "second (ok)"]);
    expect(rec.calls).toEqual([{ channel: "eng", reply: "reply:second (ok)" }]);
  });
});

describe("ProgrammaticAgentRegistry — #agent/run notes (one-shot lifecycle)", () => {
  test("a completed ONE-SHOT turn writes an #agent/run note (status ok) carrying input/output/definition/mode", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const runs = runRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeRun: runs.fn });
    await reg.register(specOneShot("digest", "digest", "Agents/digest"));

    reg.enqueue("digest", { content: "run the digest" });
    await until(() => runs.runs.length === 1);

    expect(runs.runs).toHaveLength(1);
    const run = runs.runs[0]!;
    expect(run.channel).toBe("digest");
    expect(run.status).toBe("ok");
    expect(run.mode).toBe("one-shot");
    expect(run.definition).toBe("Agents/digest");
    expect(run.input).toBe("run the digest");
    expect(run.output).toBe("reply:run the digest");
    expect(typeof run.started_at).toBe("string");
    expect(typeof run.ended_at).toBe("string");
  });

  test("a RESIDENT turn writes NO #agent/run note (the channel transcript is its record)", async () => {
    const backend = new FakeBackend();
    const rec = recorder();
    const runs = runRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeRun: runs.fn });
    // specFor → no mode → resident (the default).
    await reg.register(specFor("eng"));

    reg.enqueue("eng", { content: "hello" });
    await until(() => rec.calls.length === 1);
    // Let any erroneous run-note write land, then assert none did.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(runs.runs).toHaveLength(0);
    // The resident outbound reply was still written (no regression).
    expect(rec.calls).toHaveLength(1);
  });

  test("a FAILED one-shot turn still writes an #agent/run note with status:error + the reason", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: false, error: "mint refused" });
    const rec = recorder();
    const runs = runRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeRun: runs.fn });
    await reg.register(specOneShot("digest"));

    reg.enqueue("digest", { content: "do it" });
    await until(() => runs.runs.length === 1);

    expect(runs.runs).toHaveLength(1);
    expect(runs.runs[0]!.status).toBe("error");
    expect(runs.runs[0]!.output).toBe("mint refused");
    // No outbound note for a failed turn (unchanged behavior).
    expect(rec.calls).toHaveLength(0);
  });

  test("a one-shot turn with an empty reply STILL writes a run note (status ok, empty output)", async () => {
    const backend = new FakeBackend();
    backend.resultFor = () => ({ ok: true, reply: "" });
    const rec = recorder();
    const runs = runRecorder();
    const reg = new ProgrammaticAgentRegistry({ backend, writeOutbound: rec.fn, writeRun: runs.fn });
    await reg.register(specOneShot("digest"));

    reg.enqueue("digest", { content: "tool-only run" });
    await until(() => runs.runs.length === 1);
    expect(runs.runs[0]!.status).toBe("ok");
    expect(runs.runs[0]!.output).toBe("");
    // Empty reply → no outbound message note (the run note IS the record).
    expect(rec.calls).toHaveLength(0);
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
    await until(() => turns.events.some((e) => e.event.kind === "error"));

    expect(turns.events).toEqual([{ channel: "eng", event: { kind: "error", error: "mint refused" } }]);
    // No outbound note for a failed turn.
    expect(rec.calls).toHaveLength(0);
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
