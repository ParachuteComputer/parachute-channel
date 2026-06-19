/**
 * Tests for the CHANNEL-backend queue registry (`src/backends/channel-queue.ts`) —
 * the parallel-to-ProgrammaticAgentRegistry registry a `backend:channel` agent's
 * connected Claude Code session pulls from (design 2026-06-18-channel-backend.md).
 *
 * A FAKE store (implements {@link ChannelQueueStore}) stands in for the channel's
 * VaultTransport: it holds inbound notes in memory with a mutable `status`/`claimedAt`
 * (the vault IS the queue + source of truth), and records outbound replies. So the
 * claim/reply/release/sweep semantics + the restart-safety (re-read from the store)
 * are asserted with no real vault.
 */

import { describe, test, expect } from "bun:test";
import {
  ChannelQueueRegistry,
  type ChannelQueueStore,
} from "./channel-queue.ts";
import type { AgentSpec } from "../sandbox/types.ts";
import { InboundClaimConflictError } from "../transports/vault.ts";
import type { InboundQueueNote, InboundStatus } from "../transports/vault.ts";

/**
 * A fake durable inbound-note store. Notes live in a Map (id → note); `reply` records
 * outbound writes. Mirrors the VaultTransport methods the registry calls. The status
 * mutations persist in the Map, so re-reading models the vault's restart-safety.
 */
class FakeStore implements ChannelQueueStore {
  readonly notes = new Map<string, InboundQueueNote>();
  readonly outbound: Array<{ text: string; inReplyTo?: string }> = [];
  /** If set, the NEXT `setInboundStatus` throws this (to test claim-fail safety). */
  throwOnNextSetStatus: Error | null = null;
  /** If set, `reply` throws this (to test reply-before-handled ordering). */
  throwOnReply: Error | null = null;

  add(note: InboundQueueNote): void {
    this.notes.set(note.id, note);
  }

  async listInboundQueue(): Promise<InboundQueueNote[]> {
    // Ascending by ts (the real transport sorts this way), returning COPIES so the
    // registry can't mutate the store except through setInboundStatus (models the
    // vault round-trip — the registry reads values, then PATCHes).
    return [...this.notes.values()]
      .map((n) => ({ ...n }))
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  async setInboundStatus(
    id: string,
    status: InboundStatus,
    claimedAt?: string | null,
    ifUpdatedAt?: string,
  ): Promise<void> {
    if (this.throwOnNextSetStatus) {
      const e = this.throwOnNextSetStatus;
      this.throwOnNextSetStatus = null;
      throw e;
    }
    const note = this.notes.get(id);
    if (!note) throw new Error(`fake store: no note ${id}`);
    // CAS (FIX 3): when a precondition is supplied, the claim only lands if the note's
    // `updatedAt` still matches what the caller last saw — else the race is lost (the
    // real vault returns 409 → InboundClaimConflictError). On a successful CAS write we
    // ADVANCE `updatedAt` (the vault bumps it on every write) so a second concurrent
    // claimer with the now-stale precondition fails, modelling the real round-trip.
    if (ifUpdatedAt !== undefined) {
      if (note.updatedAt !== ifUpdatedAt) {
        throw new InboundClaimConflictError(id, 409);
      }
      note.updatedAt = `${ifUpdatedAt}::bumped`;
    }
    note.status = status;
    if (claimedAt === null) delete note.claimedAt;
    else if (claimedAt !== undefined) note.claimedAt = claimedAt;
  }

  async reply(args: { text: string; inReplyTo?: string }): Promise<{ sent: string[] }> {
    if (this.throwOnReply) throw this.throwOnReply;
    this.outbound.push({ text: args.text, ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}) });
    return { sent: [`outbound-${this.outbound.length}`] };
  }
}

const specFor = (name: string, systemPrompt?: string): AgentSpec => ({
  name,
  channels: [name],
  backend: "channel",
  ...(systemPrompt ? { systemPrompt } : {}),
});

const inbound = (id: string, text: string, ts: string, status: InboundStatus = "pending"): InboundQueueNote => ({
  id,
  text,
  sender: "operator",
  ts,
  status,
});

describe("ChannelQueueRegistry — registration", () => {
  test("register indexes by channel + name; deregister drops it", () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    expect(reg.hasChannel("laptop")).toBe(false);
    reg.register(specFor("laptop"), store);
    expect(reg.hasChannel("laptop")).toBe(true);
    expect(reg.hasName("laptop")).toBe(true);
    expect(reg.channels()).toEqual(["laptop"]);
    expect(reg.deregister("laptop")).toBe(true);
    expect(reg.hasChannel("laptop")).toBe(false);
    expect(reg.deregister("laptop")).toBe(false); // already gone.
  });

  test("register throws for a spec with no channel", () => {
    const reg = new ChannelQueueRegistry();
    expect(() => reg.register({ name: "x", channels: [], backend: "channel" }, new FakeStore())).toThrow(/no channel/);
  });
});

describe("ChannelQueueRegistry — pending peek", () => {
  test("counts only pending; previews the oldest-first", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "first message", "2026-06-18T10:00:00Z"));
    store.add(inbound("b", "second message", "2026-06-18T10:01:00Z"));
    store.add(inbound("c", "already handled", "2026-06-18T09:00:00Z", "handled"));
    reg.register(specFor("laptop"), store);

    const view = await reg.pending("laptop");
    expect(view.count).toBe(2); // c is handled, excluded.
    expect(view.items.map((i) => i.id)).toEqual(["a", "b"]); // oldest-first.
    expect(view.items[0]!.preview).toBe("first message");
  });

  test("a non-channel channel yields an empty no-op view", async () => {
    const reg = new ChannelQueueRegistry();
    const view = await reg.pending("unknown");
    expect(view).toEqual({ count: 0, items: [] });
  });
});

describe("ChannelQueueRegistry — claimNext (single-claim)", () => {
  test("claims the OLDEST pending, sets in-flight + claimedAt, returns text + systemPrompt", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("b", "newer", "2026-06-18T10:05:00Z"));
    store.add(inbound("a", "older", "2026-06-18T10:00:00Z"));
    reg.register(specFor("laptop", "You are the laptop agent."), store);

    const claimed = await reg.claimNext("laptop", () => new Date("2026-06-18T11:00:00Z"));
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("a"); // oldest.
    expect(claimed!.text).toBe("older");
    expect(claimed!.inReplyTo).toBe("a");
    expect(claimed!.systemPrompt).toBe("You are the laptop agent."); // the def body → persona.
    // The store note flipped to in-flight + got a claimedAt (the durable claim).
    expect(store.notes.get("a")!.status).toBe("in-flight");
    expect(store.notes.get("a")!.claimedAt).toBe("2026-06-18T11:00:00.000Z");
  });

  test("a SECOND claimNext does not return the same message (single-claim)", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "older", "2026-06-18T10:00:00Z"));
    store.add(inbound("b", "newer", "2026-06-18T10:05:00Z"));
    reg.register(specFor("laptop"), store);

    const first = await reg.claimNext("laptop");
    const second = await reg.claimNext("laptop");
    expect(first!.id).toBe("a");
    expect(second!.id).toBe("b"); // a is now in-flight → not re-presented; b is next.
    const third = await reg.claimNext("laptop");
    expect(third).toBeNull(); // nothing pending left.
  });

  test("returns null when none pending", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "done", "2026-06-18T10:00:00Z", "handled"));
    reg.register(specFor("laptop"), store);
    expect(await reg.claimNext("laptop")).toBeNull();
  });

  test("a claim PATCH failure surfaces + leaves the note pending (no hand-out)", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "older", "2026-06-18T10:00:00Z"));
    reg.register(specFor("laptop"), store);
    store.throwOnNextSetStatus = new Error("vault 500");
    await expect(reg.claimNext("laptop")).rejects.toThrow(/vault 500/);
    expect(store.notes.get("a")!.status).toBe("pending"); // not lost — retryable.
  });

  test("FIX 3: a passed-through updatedAt is used as the CAS precondition on the claim", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add({ ...inbound("a", "older", "2026-06-18T10:00:00Z"), updatedAt: "rev-1" });
    reg.register(specFor("laptop"), store);
    const claimed = await reg.claimNext("laptop");
    expect(claimed!.id).toBe("a");
    // CAS landed → the store bumped updatedAt (modelling the vault advancing it on write).
    expect(store.notes.get("a")!.status).toBe("in-flight");
    expect(store.notes.get("a")!.updatedAt).toBe("rev-1::bumped");
  });

  test("FIX 3: a 428/409 conflict on the claim PATCH makes claimNext skip to the NEXT pending (no double-claim)", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    // Two pending notes, each with a known revision for the CAS precondition.
    store.add({ ...inbound("a", "older", "2026-06-18T10:00:00Z"), updatedAt: "rev-a" });
    store.add({ ...inbound("b", "newer", "2026-06-18T10:05:00Z"), updatedAt: "rev-b" });
    reg.register(specFor("laptop"), store);

    // Simulate a CONCURRENT winner: between claimNext's list and its PATCH of "a",
    // another session claims "a" and advances its revision. The next PATCH of "a" with the
    // now-stale precondition will throw InboundClaimConflictError → re-list → claim "b".
    const realSet = store.setInboundStatus.bind(store);
    let firstPatch = true;
    store.setInboundStatus = (async (id, status, claimedAt, ifUpdatedAt) => {
      if (firstPatch && id === "a") {
        firstPatch = false;
        // The "other session" already claimed "a" (its revision moved on).
        store.notes.get("a")!.updatedAt = "rev-a-claimed-by-someone-else";
        store.notes.get("a")!.status = "in-flight";
      }
      return realSet(id, status, claimedAt, ifUpdatedAt);
    }) as typeof store.setInboundStatus;

    const claimed = await reg.claimNext("laptop");
    // The conflict on "a" was caught + re-listed; we claimed "b" instead — never "a" twice.
    expect(claimed!.id).toBe("b");
    expect(store.notes.get("b")!.status).toBe("in-flight");
  });

  test("FIX 3: a conflict with NO other pending returns null (nothing claimable right now)", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add({ ...inbound("a", "only", "2026-06-18T10:00:00Z"), updatedAt: "rev-a" });
    reg.register(specFor("laptop"), store);
    // Every CAS on "a" loses (the precondition is always stale → conflict). After the
    // conflict, "a" is left in-flight (by the simulated winner), so the re-list finds no
    // pending and returns null — not a double-claim, not an error.
    store.setInboundStatus = (async (id: string) => {
      store.notes.get(id)!.status = "in-flight";
      throw new InboundClaimConflictError(id, 409);
    }) as typeof store.setInboundStatus;
    const claimed = await reg.claimNext("laptop");
    expect(claimed).toBeNull();
  });
});

describe("ChannelQueueRegistry — reply (outbound + mark handled)", () => {
  test("writes the outbound via the store reply, THEN marks the inbound handled", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "question", "2026-06-18T10:00:00Z", "in-flight"));
    store.notes.get("a")!.claimedAt = "2026-06-18T10:01:00Z";
    reg.register(specFor("laptop"), store);

    const sent = await reg.reply("laptop", { inReplyTo: "a", text: "the answer" });
    expect(sent.sent.length).toBe(1);
    // Outbound recorded through the SAME reply seam (threads inReplyTo).
    expect(store.outbound).toEqual([{ text: "the answer", inReplyTo: "a" }]);
    // Inbound marked handled + claimedAt cleared.
    expect(store.notes.get("a")!.status).toBe("handled");
    expect(store.notes.get("a")!.claimedAt).toBeUndefined();
  });

  test("if the outbound write fails, the inbound is NOT marked handled (retryable)", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "question", "2026-06-18T10:00:00Z", "in-flight"));
    reg.register(specFor("laptop"), store);
    store.throwOnReply = new Error("vault write 500");

    await expect(reg.reply("laptop", { inReplyTo: "a", text: "x" })).rejects.toThrow(/vault write 500/);
    expect(store.notes.get("a")!.status).toBe("in-flight"); // still claimed, not handled.
    expect(store.outbound.length).toBe(0);
  });

  test("reply for an unregistered channel throws", async () => {
    const reg = new ChannelQueueRegistry();
    await expect(reg.reply("nope", { text: "x" })).rejects.toThrow(/no channel-backend agent/);
  });
});

describe("ChannelQueueRegistry — release", () => {
  test("returns an in-flight note to pending + clears claimedAt", async () => {
    const reg = new ChannelQueueRegistry();
    const store = new FakeStore();
    store.add(inbound("a", "q", "2026-06-18T10:00:00Z", "in-flight"));
    store.notes.get("a")!.claimedAt = "2026-06-18T10:01:00Z";
    reg.register(specFor("laptop"), store);

    await reg.release("laptop", "a");
    expect(store.notes.get("a")!.status).toBe("pending");
    expect(store.notes.get("a")!.claimedAt).toBeUndefined();
    // It's claimable again.
    const claimed = await reg.claimNext("laptop");
    expect(claimed!.id).toBe("a");
  });
});

describe("ChannelQueueRegistry — sweepExpired (TTL auto-release)", () => {
  test("resets a STALE in-flight note to pending; leaves a fresh one alone", async () => {
    const ttl = 15 * 60 * 1000; // 15 min.
    const reg = new ChannelQueueRegistry({ claimTtlMs: ttl });
    const store = new FakeStore();
    const now = new Date("2026-06-18T12:00:00Z");
    // 'stale' claimed 20 min ago (> TTL) → released; 'fresh' claimed 5 min ago → kept.
    store.add({ id: "stale", text: "s", sender: "operator", ts: "2026-06-18T11:00:00Z", status: "in-flight", claimedAt: "2026-06-18T11:40:00Z" });
    store.add({ id: "fresh", text: "f", sender: "operator", ts: "2026-06-18T11:30:00Z", status: "in-flight", claimedAt: "2026-06-18T11:55:00Z" });
    store.add(inbound("pend", "p", "2026-06-18T11:45:00Z")); // already pending — untouched.
    reg.register(specFor("laptop"), store);

    const released = await reg.sweepExpired(now);
    expect(released).toBe(1);
    expect(store.notes.get("stale")!.status).toBe("pending");
    expect(store.notes.get("stale")!.claimedAt).toBeUndefined();
    expect(store.notes.get("fresh")!.status).toBe("in-flight"); // still fresh.
    expect(store.notes.get("pend")!.status).toBe("pending");
  });

  test("an in-flight note with no claimedAt is left alone (can't judge its age)", async () => {
    const reg = new ChannelQueueRegistry({ claimTtlMs: 1000 });
    const store = new FakeStore();
    store.add(inbound("a", "q", "2026-06-18T10:00:00Z", "in-flight")); // no claimedAt.
    reg.register(specFor("laptop"), store);
    const released = await reg.sweepExpired(new Date("2026-06-18T12:00:00Z"));
    expect(released).toBe(0);
    expect(store.notes.get("a")!.status).toBe("in-flight");
  });

  test("one channel's store error doesn't abort the sweep of the others", async () => {
    const reg = new ChannelQueueRegistry({ claimTtlMs: 1000 });
    const bad = new FakeStore();
    bad.listInboundQueue = async () => {
      throw new Error("vault down");
    };
    const good = new FakeStore();
    good.add({ id: "stale", text: "s", sender: "operator", ts: "t", status: "in-flight", claimedAt: "2026-06-18T00:00:00Z" });
    reg.register(specFor("bad"), bad);
    reg.register(specFor("good"), good);
    const released = await reg.sweepExpired(new Date("2026-06-18T12:00:00Z"));
    expect(released).toBe(1); // good swept despite bad throwing.
    expect(good.notes.get("stale")!.status).toBe("pending");
  });
});

describe("ChannelQueueRegistry — restart safety (vault is the source of truth)", () => {
  test("a claim survives a 'restart' (a fresh registry reading the same store)", async () => {
    const store = new FakeStore();
    store.add(inbound("a", "q1", "2026-06-18T10:00:00Z"));
    store.add(inbound("b", "q2", "2026-06-18T10:05:00Z"));

    // Registry instance #1 claims 'a'.
    const reg1 = new ChannelQueueRegistry();
    reg1.register(specFor("laptop"), store);
    const claimed = await reg1.claimNext("laptop");
    expect(claimed!.id).toBe("a");

    // "Daemon restart": a BRAND-NEW registry over the SAME durable store. The claim
    // (status:in-flight on note 'a') persisted — so the new registry's first claim is
    // 'b' (a is still in-flight, not re-presented), and a handled message would not
    // reappear either. The vault is the source of truth, not in-memory state.
    const reg2 = new ChannelQueueRegistry();
    reg2.register(specFor("laptop"), store);
    const afterRestart = await reg2.claimNext("laptop");
    expect(afterRestart!.id).toBe("b");
    expect(store.notes.get("a")!.status).toBe("in-flight"); // claim survived.

    // Replying (post-restart) marks 'b' handled; a re-read never re-presents it.
    await reg2.reply("laptop", { inReplyTo: "b", text: "answer" });
    expect(store.notes.get("b")!.status).toBe("handled");
    expect(await reg2.pending("laptop")).toEqual({ count: 0, items: [] });
  });
});
