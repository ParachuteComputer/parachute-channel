/**
 * Tests for the ATTACHED-backend daemon wiring (design 2026-06-18-attached-backend.md,
 * phases 1-2) — the two load-bearing seams:
 *
 *   1. The DAEMON ROUTING FORK (`contextFor`): an inbound for a `backend:attached`
 *      agent must NOT enqueue to the ProgrammaticAgentRegistry (no `claude -p`) and
 *      lands as a durable queue note; an inbound for a programmatic agent still
 *      enqueues as before (no regression).
 *   2. The CHANNEL MCP SURFACE (`dispatchChannelTool`): pending / next-message /
 *      reply / release dispatch to the AttachedQueueRegistry; the outbound from `reply`
 *      goes through the channel transport's reply (the `#agent/message/outbound` path —
 *      loop-safe).
 *
 * Fakes throughout — no real vault / hub / tmux.
 */

import { describe, test, expect } from "bun:test";
import { contextFor } from "./daemon.ts";
import { ClientRegistry } from "./routing.ts";
import { DeliveryState } from "./delivery-state.ts";
import {
  ProgrammaticAgentRegistry,
  type WriteOutbound,
} from "./backends/registry.ts";
import {
  AttachedQueueRegistry,
  type AttachedQueueStore,
} from "./backends/attached-queue.ts";
import { dispatchChannelTool } from "./mcp-http.ts";
import { SCOPE_READ, SCOPE_WRITE } from "./auth.ts";
import type { AgentBackend, AgentHandle, AgentStatus, DeliverResult } from "./backends/types.ts";
import type { AgentSpec } from "./sandbox/types.ts";
import type { InboundQueueNote, InboundStatus } from "./transports/vault.ts";

// --- fakes -----------------------------------------------------------------

/** A programmatic backend whose `deliver` (the `claude -p` turn) records calls. */
class FakeProgrammaticBackend implements AgentBackend {
  readonly kind = "programmatic";
  readonly delivered: string[] = [];
  async start(spec: AgentSpec): Promise<AgentHandle> {
    return { backend: this.kind, channel: spec.channels[0] as string, name: spec.name, spec };
  }
  async deliver(_handle: AgentHandle, message: string): Promise<DeliverResult> {
    this.delivered.push(message);
    return { ok: true, reply: `auto:${message}` };
  }
  async stop(): Promise<void> {}
  async status(): Promise<AgentStatus> {
    return { live: true };
  }
}

function noopWriteOutbound(): WriteOutbound {
  return async () => {};
}

/** A fake attached-queue store: in-memory notes + recorded outbound. */
class FakeStore implements AttachedQueueStore {
  readonly notes = new Map<string, InboundQueueNote>();
  readonly outbound: Array<{ text: string; inReplyTo?: string }> = [];
  add(n: InboundQueueNote): void {
    this.notes.set(n.id, n);
  }
  async listInboundQueue(): Promise<InboundQueueNote[]> {
    return [...this.notes.values()].map((n) => ({ ...n })).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  }
  async setInboundStatus(id: string, status: InboundStatus, claimedAt?: string | null): Promise<void> {
    const n = this.notes.get(id)!;
    n.status = status;
    if (claimedAt === null) delete n.claimedAt;
    else if (claimedAt !== undefined) n.claimedAt = claimedAt;
  }
  async reply(args: { text: string; inReplyTo?: string }): Promise<{ sent: string[] }> {
    this.outbound.push({ text: args.text, ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}) });
    return { sent: ["out-1"] };
  }
}

const channelSpec = (name: string, systemPrompt?: string): AgentSpec => ({
  name,
  channels: [name],
  backend: "attached",
  ...(systemPrompt ? { systemPrompt } : {}),
});

// --- 1. the daemon routing fork --------------------------------------------

describe("daemon routing fork (contextFor) — attached vs programmatic", () => {
  test("an attached-backend inbound does NOT enqueue to the programmatic worker", async () => {
    const backend = new FakeProgrammaticBackend();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: noopWriteOutbound() });
    const channelQueue = new AttachedQueueRegistry();
    const store = new FakeStore();
    // Register an ATTACHED agent for "laptop" (its queue store is the fake).
    channelQueue.register(channelSpec("laptop"), store);

    const registry = new ClientRegistry();
    const ctx = contextFor(registry, "laptop", new DeliveryState(), programmatic, channelQueue);
    // Simulate the vault trigger delivering an inbound for the channel.
    ctx.emit({
      channel: "laptop",
      content: "handle this when you're around",
      meta: { note_id: "note-1", ts: "2026-06-18T10:00:00Z" },
      source: "vault",
    });

    // THE ASSERTION: the programmatic worker was NOT invoked (no `claude -p` turn).
    expect(backend.delivered).toEqual([]);
    // And the durable note is the queue item — it's pending (the trigger creates it as
    // status:pending; emit doesn't mutate it). The note already lives in the vault; the
    // channel registry reads it on the next pull.
    store.add({ id: "note-1", text: "handle this when you're around", sender: "operator", ts: "2026-06-18T10:00:00Z", status: "pending" });
    const view = await channelQueue.pending("laptop");
    expect(view.count).toBe(1);
  });

  test("a programmatic inbound STILL enqueues to the worker (no regression)", async () => {
    const backend = new FakeProgrammaticBackend();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: noopWriteOutbound() });
    await programmatic.register({ name: "eng", channels: ["eng"], backend: "programmatic" });
    const channelQueue = new AttachedQueueRegistry(); // no attached agent for "eng".

    const registry = new ClientRegistry();
    const ctx = contextFor(registry, "eng", new DeliveryState(), programmatic, channelQueue);
    ctx.emit({ channel: "eng", content: "do a task", meta: { note_id: "n-eng" }, source: "vault" });

    // The serial worker drains async — wait for the turn to run.
    for (let i = 0; i < 200 && backend.delivered.length === 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 1));
    }
    expect(backend.delivered).toEqual(["do a task"]); // the programmatic path is untouched.
  });

  test("the channel fork is checked FIRST — a name in BOTH registries routes to channel", async () => {
    // Defense-in-depth: even if a programmatic agent somehow shares the channel, the
    // channel check short-circuits (the fork is explicit + first), so no `claude -p`.
    const backend = new FakeProgrammaticBackend();
    const programmatic = new ProgrammaticAgentRegistry({ backend, writeOutbound: noopWriteOutbound() });
    await programmatic.register({ name: "dual", channels: ["dual"], backend: "programmatic" });
    const channelQueue = new AttachedQueueRegistry();
    channelQueue.register(channelSpec("dual"), new FakeStore());

    const ctx = contextFor(new ClientRegistry(), "dual", new DeliveryState(), programmatic, channelQueue);
    ctx.emit({ channel: "dual", content: "x", meta: {}, source: "vault" });
    await new Promise<void>((r) => setTimeout(r, 10));
    expect(backend.delivered).toEqual([]); // channel won the fork.
  });
});

// --- 2. the channel MCP surface --------------------------------------------

const RW = [SCOPE_READ, SCOPE_WRITE];

function parse(result: { content: Array<{ type: "text"; text: string }> }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("channel MCP surface (dispatchChannelTool)", () => {
  test("pending → { count, items }", async () => {
    const reg = new AttachedQueueRegistry();
    const store = new FakeStore();
    store.add({ id: "a", text: "hi", sender: "operator", ts: "2026-06-18T10:00:00Z", status: "pending" });
    reg.register(channelSpec("laptop"), store);

    const r = await dispatchChannelTool("laptop", reg, RW, "pending", {});
    expect(r.isError).toBeUndefined();
    expect(parse(r)).toEqual({ count: 1, items: [{ id: "a", preview: "hi" }] });
  });

  test("next-message claims + returns id/text/inReplyTo/systemPrompt", async () => {
    const reg = new AttachedQueueRegistry();
    const store = new FakeStore();
    store.add({ id: "a", text: "the question", sender: "operator", ts: "2026-06-18T10:00:00Z", status: "pending" });
    reg.register(channelSpec("laptop", "You are laptop."), store);

    const r = await dispatchChannelTool("laptop", reg, RW, "next-message", {});
    const claimed = parse(r) as { id: string; text: string; inReplyTo: string; systemPrompt: string };
    expect(claimed.id).toBe("a");
    expect(claimed.text).toBe("the question");
    expect(claimed.inReplyTo).toBe("a");
    expect(claimed.systemPrompt).toBe("You are laptop.");
    expect(store.notes.get("a")!.status).toBe("in-flight");
  });

  test("next-message returns a null-message sentinel when the queue is empty", async () => {
    const reg = new AttachedQueueRegistry();
    reg.register(channelSpec("laptop"), new FakeStore());
    const r = await dispatchChannelTool("laptop", reg, RW, "next-message", {});
    expect(parse(r)).toEqual({ message: null, note: "no pending messages" });
  });

  test("reply writes the outbound (loop-safe path) + marks handled", async () => {
    const reg = new AttachedQueueRegistry();
    const store = new FakeStore();
    store.add({ id: "a", text: "q", sender: "operator", ts: "2026-06-18T10:00:00Z", status: "in-flight", claimedAt: "2026-06-18T10:01:00Z" });
    reg.register(channelSpec("laptop"), store);

    const r = await dispatchChannelTool("laptop", reg, RW, "reply", { inReplyTo: "a", text: "the answer" });
    expect(r.isError).toBeUndefined();
    // The outbound went through the channel transport's reply seam — which writes a
    // `#agent/message/outbound` note (loop-safe; the inbound trigger never fires on it).
    expect(store.outbound).toEqual([{ text: "the answer", inReplyTo: "a" }]);
    expect(store.notes.get("a")!.status).toBe("handled");
  });

  test("release un-claims back to pending", async () => {
    const reg = new AttachedQueueRegistry();
    const store = new FakeStore();
    store.add({ id: "a", text: "q", sender: "operator", ts: "t", status: "in-flight", claimedAt: "2026-06-18T10:00:00Z" });
    reg.register(channelSpec("laptop"), store);

    const r = await dispatchChannelTool("laptop", reg, RW, "release", { id: "a" });
    expect(r.isError).toBeUndefined();
    expect(store.notes.get("a")!.status).toBe("pending");
  });

  test("write tools require agent:write; a read-only token is refused", async () => {
    const reg = new AttachedQueueRegistry();
    reg.register(channelSpec("laptop"), new FakeStore());
    for (const tool of ["next-message", "reply", "release"]) {
      const r = await dispatchChannelTool("laptop", reg, [SCOPE_READ], tool, { id: "a", text: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain(SCOPE_WRITE);
    }
    // pending is read-only — works with a read token.
    const ok = await dispatchChannelTool("laptop", reg, [SCOPE_READ], "pending", {});
    expect(ok.isError).toBeUndefined();
  });

  test("a non-attached channel gates cleanly (tool error, not a crash)", async () => {
    const reg = new AttachedQueueRegistry(); // nothing registered.
    const r = await dispatchChannelTool("nope", reg, RW, "pending", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("no attached-backend agent");
  });
});
