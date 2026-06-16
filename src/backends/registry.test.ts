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
import { ProgrammaticAgentRegistry, type WriteOutbound } from "./registry.ts";
import type { AgentBackend, AgentHandle, AgentStatus, DeliverResult } from "./types.ts";
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

  async start(spec: AgentSpec): Promise<AgentHandle> {
    return { backend: this.kind, channel: spec.channels[0] as string, name: spec.name, spec };
  }

  async deliver(handle: AgentHandle, message: string): Promise<DeliverResult> {
    this.calls.push({ channel: handle.channel, message });
    this.inFlight++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    try {
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
