/**
 * The ATTACHED-backend queue registry (design 2026-06-18-channel-backend.md, phase 1).
 * (The backend VALUE was named `"channel"` before the rename; the ROUTING KEY `channel`
 * — the agent's address / the `/mcp/<channel>` segment — is a separate concept and KEEPS
 * its name, so `channel` still appears throughout as the routing-key identifier.)
 *
 * The PARALLEL to {@link ProgrammaticAgentRegistry}, NOT a reuse of it. A
 * `backend: "attached"` agent runs NO `claude -p` and has NO drain worker: the turn
 * is handled by a Claude Code session the OPERATOR runs and connects ("attaches") to the
 * channel's MCP endpoint. The inbound `#agent/message/inbound` notes themselves ARE the
 * queue (the vault is the queue + the source of truth), and their claim `status`
 * (`pending | in-flight | handled`) lives on the note, so a claim survives a daemon
 * restart and a handled message is never re-presented.
 *
 * ── Why a separate registry (the daemon routing fork) ────────────────────────────
 * The programmatic registry's drain worker reads `deliver()`'s `reply` synchronously
 * and OWNS the outbound write. An attached agent has no synchronous turn and its
 * outbound is written by the MCP `reply` tool — reusing that worker would double-write
 * (worker + tool) or drop the reply (worker sees an empty `deliver`). So the fork is
 * at the daemon ROUTER: inbound for an `attached` agent routes HERE and is NOT enqueued
 * to the programmatic worker. This registry exposes only queue operations the MCP
 * surface calls — there is no in-process `deliver`-produces-reply.
 *
 * ── The queue operations (called by the channel MCP surface, phase 2) ────────────
 *   - `pending(channel)`   → count + a peek (ids/previews) of `status:pending` inbound.
 *   - `claimNext(channel)` → oldest `pending` → set `in-flight` + `claimedAt`; returns
 *                            { id, text, inReplyTo, systemPrompt }. Single-claim (two
 *                            sessions don't double-handle). null when none pending.
 *   - `reply(channel, …)`  → write the outbound note via the SAME vault-transport
 *                            `reply()` the programmatic worker uses (durable, threads,
 *                            shows in chat UI, tagged outbound so it can't re-trigger
 *                            the inbound webhook), THEN set the inbound `handled`.
 *   - `release(channel,id)`→ `in-flight` → `pending` (the session is giving up).
 *   - `sweepExpired(now)`  → `in-flight` notes claimed > TTL ago → `pending` (so a
 *                            crashed session can't strand the queue). Wired into the
 *                            daemon's periodic tick.
 *
 * CARDINALITY: one channel : one agent (the channel IS the agent's conduit). The
 * surface deliberately doesn't bake "channel == agent" so deep that adding an optional
 * agent filter to `claimNext` later would be a breaking change — the operations key on
 * the channel name only, and the per-channel record carries the agent's spec.
 */

import type { AgentSpec } from "../sandbox/types.ts";
import { InboundClaimConflictError } from "../transports/vault.ts";
import type { InboundQueueNote, InboundStatus } from "../transports/vault.ts";

/**
 * The storage seam the registry operates a channel's queue through — the durable
 * inbound-note store (the daemon wires this to the channel's VaultTransport; tests
 * inject a fake). Mirrors the vault-transport methods 1:1 so the seam is thin.
 */
export interface AttachedQueueStore {
  /** List this channel's inbound queue notes, ascending by ts (oldest first). */
  listInboundQueue(opts?: { limit?: number }): Promise<InboundQueueNote[]>;
  /**
   * Set an inbound note's claim status (+ optionally claimedAt; `null` clears it).
   * When `ifUpdatedAt` is given, the write is a COMPARE-AND-SWAP (the claim only lands
   * if the note hasn't changed since it was read) and throws {@link
   * InboundClaimConflictError} when the race is lost (agent#101); omitting it is the
   * prior last-write-wins behavior (release / handled / sweep).
   */
  setInboundStatus(
    id: string,
    status: InboundStatus,
    claimedAt?: string | null,
    ifUpdatedAt?: string,
  ): Promise<void>;
  /** Write an outbound reply (the SAME `#agent/message/outbound` path the worker uses). */
  reply(args: { text: string; inReplyTo?: string }): Promise<{ sent: string[] }>;
}

/** Bound on the CAS re-list retries in {@link AttachedQueueRegistry.claimNext} — a
 *  safety net against a pathological all-contended queue (each pass claims/eliminates
 *  one note, so the loop is naturally bounded by the pending count anyway). */
const MAX_CLAIM_ATTEMPTS = 25;

/** The default in-flight claim TTL (design: 15 min comfortably covers an operator turn). */
export const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000;

/** A peek at the pending queue — count + a bounded preview of the waiting items. */
export interface PendingView {
  /** How many inbound messages are `pending` (unclaimed) on this channel. */
  count: number;
  /** A bounded preview (oldest-first) for "you have N messages waiting" affordances. */
  items: Array<{ id: string; preview: string }>;
}

/** The claimed message `claimNext` returns — everything a session needs to be the agent. */
export interface ClaimedMessage {
  /** The inbound note id — pass it back as `inReplyTo` on `reply`. */
  id: string;
  /** The message text to work on. */
  text: string;
  /** The note id this turn threads to (== `id`, surfaced explicitly for the reply call). */
  inReplyTo: string;
  /**
   * The agent's system prompt (the `#agent/definition` body) — the session adopts the
   * persona by treating this as its instructions for the reply. Adopting it is the
   * SESSION's responsibility (MCP can't force a system prompt on the caller); the MCP
   * server INSTRUCTIONS reinforce the convention. Empty string when the def has none.
   */
  systemPrompt: string;
}

/** One registered attached-backend agent: its spec + the store its queue lives in. */
interface AttachedRecord {
  /** The agent slug (the spec name) == the wake channel (agent ≡ channel). */
  name: string;
  /** The channel the queue + MCP surface key on. */
  channel: string;
  /** The spec — carries the systemPrompt the session adopts on `next-message`. */
  spec: AgentSpec;
  /** The durable inbound-note store (the channel's VaultTransport, in production). */
  store: AttachedQueueStore;
}

/** How many pending items the `pending` peek returns at most (a nudge, not a dump). */
const PENDING_PEEK_CAP = 20;
/** How long a pending preview snippet is (characters). */
const PREVIEW_LEN = 120;

/**
 * The daemon's registry of ATTACHED-backend agents + their durable queues. Keyed by
 * CHANNEL (the inbound-routing index + the MCP-surface lookup are both O(1)). One
 * instance per daemon, constructed at boot; the store is injected per-agent so tests
 * drive it with a fake store, no real vault.
 */
export class AttachedQueueRegistry {
  /** channel → record. */
  private readonly byChannel = new Map<string, AttachedRecord>();
  /** name → channel (the lifecycle index; an agent has exactly one channel). */
  private readonly nameToChannel = new Map<string, string>();
  private readonly claimTtlMs: number;

  constructor(opts?: { claimTtlMs?: number }) {
    this.claimTtlMs = opts?.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  }

  /**
   * Register (or replace) a attached-backend agent. Lightweight: index the record by
   * channel + name. Idempotent-replace by name (a reload / boot re-register swaps the
   * spec + store in place). Throws if the spec declares no channel.
   */
  register(spec: AgentSpec, store: AttachedQueueStore): void {
    if (spec.channels.length === 0) {
      throw new Error(`attached-queue registry: spec "${spec.name}" declares no channels`);
    }
    const channel = channelOf(spec);
    // If the name moved channels (rare), drop the stale channel index.
    const priorChannel = this.nameToChannel.get(spec.name);
    if (priorChannel !== undefined && priorChannel !== channel) {
      this.byChannel.delete(priorChannel);
    }
    this.byChannel.set(channel, { name: spec.name, channel, spec, store });
    this.nameToChannel.set(spec.name, channel);
  }

  /** Deregister a attached-backend agent by NAME — drop its indexes. The durable queue
   *  notes stay in the vault (deregistering an agent doesn't delete its history). */
  deregister(name: string): boolean {
    const channel = this.nameToChannel.get(name);
    if (channel === undefined) return false;
    this.byChannel.delete(channel);
    this.nameToChannel.delete(name);
    return true;
  }

  /** Is a attached-backend agent registered for this channel? (the routing-fork check) */
  hasChannel(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  /** Is a attached-backend agent registered under this name? (the mutual-exclusion check) */
  hasName(name: string): boolean {
    return this.nameToChannel.has(name);
  }

  /** All registered channels (for /health + the sweep + tests). */
  channels(): string[] {
    return [...this.byChannel.keys()];
  }

  /**
   * The registered attached-backend agents as plain records (name + channel + the
   * spec's surfaceable, non-secret fields). The `GET /api/agents` list (#102) maps
   * these into {@link AgentInfo}; tests assert the shape. Sorted by name for a stable
   * list. NEVER carries a token/secret — the spec's vault binding is a name + access
   * verb only. The live `pending` count is fetched separately (it's an async vault
   * read; see {@link pending}) so this accessor stays synchronous + cheap.
   */
  list(): Array<{ name: string; channel: string; vault?: string; systemPrompt?: string }> {
    return [...this.byChannel.values()]
      .map((rec) => ({
        name: rec.name,
        channel: rec.channel,
        ...(rec.spec.vault?.name ? { vault: rec.spec.vault.name } : {}),
        ...(rec.spec.systemPrompt ? { systemPrompt: rec.spec.systemPrompt } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Peek the pending queue for a channel: the count of `status:pending` inbound + a
   * bounded oldest-first preview. A no-op shape `{ count: 0, items: [] }` for an
   * unregistered (non-channel) channel — the MCP surface gates cleanly on a non-channel
   * channel rather than erroring.
   */
  async pending(channel: string): Promise<PendingView> {
    const rec = this.byChannel.get(channel);
    if (!rec) return { count: 0, items: [] };
    const notes = await rec.store.listInboundQueue();
    const pendingNotes = notes.filter((n) => n.status === "pending");
    const items = pendingNotes
      .slice(0, PENDING_PEEK_CAP)
      .map((n) => ({ id: n.id, preview: preview(n.text) }));
    return { count: pendingNotes.length, items };
  }

  /**
   * Claim the OLDEST `pending` inbound for a channel: set it `in-flight` + stamp
   * `claimedAt = now`, then return it (+ the agent's system prompt). The status flip to
   * `in-flight` (the vault is the source of truth) is what makes a SEQUENTIAL second
   * `claimNext` skip it: each call re-reads the live queue, so once the first claim's
   * PATCH lands the note is no longer `pending`. Returns null when none pending (or for
   * an unregistered channel).
   *
   * SINGLE-CLAIM via COMPARE-AND-SWAP (agent#101). The claim PATCH carries
   * `if_updated_at` (the note's last-seen `updated_at`), so it only lands if the note
   * hasn't changed since this call read it. Two truly-concurrent `claimNext` calls read
   * the SAME `updated_at`; the first claim advances it, so the second's precondition
   * FAILS (the store throws {@link InboundClaimConflictError}) — we then RE-LIST and try
   * the NEXT pending message, never double-claiming. The loop is bounded by the pending
   * count (each pass either claims one or eliminates a now-contended one) plus a hard
   * {@link MAX_CLAIM_ATTEMPTS} backstop. A note with no `updatedAt` (a vault that omitted
   * it) falls back to the prior last-write-wins claim — the precondition is simply
   * absent, so the narrow double-claim window remains only for that degenerate case.
   * Returns null when none pending (or for an unregistered channel).
   */
  async claimNext(channel: string, now: () => Date = () => new Date()): Promise<ClaimedMessage | null> {
    const rec = this.byChannel.get(channel);
    if (!rec) return null;
    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      // RE-LIST each attempt so a lost CAS race sees the queue as the winner left it
      // (the contended note is now in-flight, so `find` skips past it to the next pending).
      const notes = await rec.store.listInboundQueue();
      const oldest = notes.find((n) => n.status === "pending"); // ascending by ts.
      if (!oldest) return null;
      try {
        // Commit the claim (status → in-flight + claimedAt) BEFORE returning, guarded by
        // the note's `updated_at` so a concurrent claimer can't also win it. A non-conflict
        // PATCH failure propagates (the caller gets the error; the note stays pending).
        await rec.store.setInboundStatus(
          oldest.id,
          "in-flight",
          now().toISOString(),
          oldest.updatedAt, // CAS precondition; undefined → store falls back to force.
        );
      } catch (err) {
        if (err instanceof InboundClaimConflictError) {
          // Another session claimed this note between our list and PATCH — re-list and
          // try the next pending one (no double-claim).
          continue;
        }
        throw err;
      }
      return {
        id: oldest.id,
        text: oldest.text,
        inReplyTo: oldest.id,
        systemPrompt: rec.spec.systemPrompt ?? "",
      };
    }
    // Exhausted the retry budget under sustained contention — treat as "none claimable
    // right now" (a connected session retries `next-message`). Non-corrupting.
    return null;
  }

  /**
   * Reply to an inbound on a channel: write the outbound `#agent/message/outbound`
   * note via the SAME vault-transport `reply()` the programmatic worker uses (durable,
   * threads `inReplyTo`, renders in the chat UI, tagged outbound so it can NEVER
   * re-trigger the inbound webhook — loop-safe), THEN mark the inbound `handled` and
   * clear its `claimedAt`. Order matters: the outbound is written FIRST so a failure to
   * persist the reply leaves the inbound un-handled (the session can retry) rather than
   * marking it done with no reply. Returns the outbound note id(s). Throws for an
   * unregistered channel (the MCP surface maps it to a tool error).
   */
  async reply(channel: string, args: { inReplyTo?: string; text: string }): Promise<{ sent: string[] }> {
    const rec = this.byChannel.get(channel);
    if (!rec) throw new Error(`attached-queue registry: no attached-backend agent for "${channel}"`);
    const sent = await rec.store.reply({
      text: args.text,
      ...(args.inReplyTo ? { inReplyTo: args.inReplyTo } : {}),
    });
    // Mark handled only AFTER the outbound is durably written. Clear claimedAt so a
    // handled note doesn't linger with a stale claim timestamp.
    if (args.inReplyTo) {
      await rec.store.setInboundStatus(args.inReplyTo, "handled", null);
    }
    return sent;
  }

  /**
   * Release an in-flight claim back to `pending` (the session is giving up). Clears
   * `claimedAt`. Idempotent at the vault level (re-setting pending is harmless). Throws
   * for an unregistered channel.
   */
  async release(channel: string, id: string): Promise<void> {
    const rec = this.byChannel.get(channel);
    if (!rec) throw new Error(`attached-queue registry: no attached-backend agent for "${channel}"`);
    await rec.store.setInboundStatus(id, "pending", null);
  }

  /**
   * TTL auto-release: across EVERY registered channel, reset to `pending` any
   * `in-flight` note whose `claimedAt` is older than the claim TTL — so a crashed /
   * abandoned session can't strand the queue. Best-effort + per-channel-isolated: one
   * channel's store error is logged and never aborts the others. Returns the number of
   * notes released. Wired into the daemon's periodic tick.
   *
   * An `in-flight` note with NO usable `claimedAt` is left alone (we can't judge its
   * age) — defensive; in practice `claimNext` always stamps one.
   */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    let released = 0;
    const cutoff = now.getTime() - this.claimTtlMs;
    for (const rec of this.byChannel.values()) {
      let notes: InboundQueueNote[];
      try {
        notes = await rec.store.listInboundQueue();
      } catch (err) {
        console.warn(
          `attached-queue: sweep list for "${rec.channel}" failed (continuing): ${(err as Error).message}`,
        );
        continue;
      }
      for (const n of notes) {
        if (n.status !== "in-flight") continue;
        if (!n.claimedAt) continue; // can't judge age — leave it.
        const claimedMs = new Date(n.claimedAt).getTime();
        if (Number.isNaN(claimedMs) || claimedMs > cutoff) continue; // fresh enough.
        try {
          await rec.store.setInboundStatus(n.id, "pending", null);
          released++;
          console.log(
            `attached-queue: auto-released stale in-flight note ${n.id} on "${rec.channel}" ` +
              `(claimed ${n.claimedAt}, TTL ${this.claimTtlMs}ms).`,
          );
        } catch (err) {
          console.warn(
            `attached-queue: sweep release of ${n.id} on "${rec.channel}" failed (continuing): ` +
              `${(err as Error).message}`,
          );
        }
      }
    }
    return released;
  }
}

/** The wake channel for a spec (its first channel) — agent ≡ channel for a channel def. */
function channelOf(spec: AgentSpec): string {
  const first = spec.channels[0]!;
  return typeof first === "string" ? first : first.name;
}

/** A bounded single-line preview of a message body (for the pending peek). */
function preview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > PREVIEW_LEN ? `${oneLine.slice(0, PREVIEW_LEN - 1)}…` : oneLine;
}
