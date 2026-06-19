/**
 * The daemon-level PROGRAMMATIC-AGENT registry + per-channel serial queue — the
 * wiring that makes the {@link ProgrammaticBackend} usable end-to-end (design
 * 2026-06-16-pluggable-agent-backend.md, the wiring follow-up to PR #73).
 *
 * A programmatic agent has NO resident process (unlike the interactive tmux
 * backend). It is just: a registered handle (workspace + spec + persisted
 * session_id) and a per-channel serial worker. An inbound message for a registered
 * channel is ENQUEUED here; the worker drains the queue ONE turn at a time, FIFO,
 * running a single `claude -p --resume <sid>` turn per message and posting the
 * reply back as an outbound `#agent/message/outbound` note.
 *
 * ── The serial-queue contract (HARD requirement — reviewer contract) ─────────────
 * Each agent processes turns ONE AT A TIME, FIFO. There is NEVER two concurrent
 * `claude -p` for the same channel/session — that would FORK the conversation (two
 * turns resuming the same session_id, racing the session-id store). New inbound
 * while a turn runs is queued; the worker drains in arrival order. This is enforced
 * structurally: a single in-flight promise chain per agent (`#draining`), not a
 * lock the caller must remember to take.
 *
 * ── Outbound (design step 5) ─────────────────────────────────────────────────────
 * On a `deliver()` result that is `ok: true` AND `reply` is non-empty, the worker
 * writes an outbound note via the injected {@link WriteOutbound} callback — which
 * the daemon wires to the channel transport's `reply()` (the SAME vault-transport
 * outbound path the interactive `reply` tool uses, so it's durable + shows in the
 * chat UI). An EMPTY reply writes NO note (reviewer contract — `reply` can be `""`).
 * On `ok: false` the error is logged and the turn is DROPPED (no infinite loop, no
 * retry — a failed turn's session id is already persisted by the backend, so the
 * next message resumes the conversation). The outbound write goes through `reply()`,
 * which tags the note `#agent/message/outbound` — the vault inbound trigger keys on
 * `#agent/message/inbound` only, so writing the reply CANNOT re-trigger the inbound
 * webhook (no loop).
 *
 * ── Thread note (the UNIFIED model: definition -> thread -> message) ───────────────
 * BOTH execution-lifecycle modes now MATERIALIZE a `#agent/thread` note (the structural
 * unification — everything is a thread; a "run" was always a thread with one turn). It is
 * the PRIMARY record of the turn, written BEFORE the additive outbound (the c34db03
 * ordering, now uniform) so the record survives an outbound failure. The MODE governs the
 * thread's identity (resolved transport-side): `single-threaded` upserts ONE thread note
 * per channel (named after the def, rolling turn_count + cumulative usage),
 * `multi-threaded` writes one thread note per fire. The thread note carries
 * `['#agent/thread']` EXACTLY — never a message tag — so it can never wake a session.
 */

import type { AgentSpec, AgentMode } from "../sandbox/types.ts";
import { normalizeChannel } from "../sandbox/types.ts";
import type { AgentBackend, AgentHandle, InterimTurnEvent } from "./types.ts";

/**
 * The streaming-view sink (design 2026-06-16 build item #1): the daemon wires this
 * to push a turn's interim progress (assistant text chunks + tool_use) to the
 * channel's live chat subscribers (the per-channel turn-event SSE). The registry's
 * worker calls it per channel as the turn runs, plus a synthesized `done`/`error`
 * lifecycle event so the live view can finalize cleanly even on an empty/failed
 * turn. ADDITIVE: when omitted the worker behaves exactly as before (no live view).
 */
export type TurnEventSink = (channel: string, event: TurnLifecycleEvent) => void;

/**
 * A per-channel turn event the daemon fans out to the live chat. It's the backend's
 * {@link InterimTurnEvent} (text / tool / init) PLUS two registry-synthesized
 * lifecycle events that bracket every turn so the UI never gets stuck "working":
 *  - `done`  — the turn finished; `reply` is the final outbound text (empty when the
 *              turn produced no text). The UI finalizes the live bubble.
 *  - `error` — the turn failed; `error` is the reason. The UI resolves the live view
 *              to an error state rather than leaving a hung spinner.
 */
export type TurnLifecycleEvent =
  | InterimTurnEvent
  | { kind: "done"; reply: string }
  | { kind: "error"; error: string };

/**
 * Write an outbound reply for a channel — the seam the registry posts a turn's
 * reply through. The daemon wires this to the channel transport's `reply()` (a
 * VaultTransport writes a `#agent/message/outbound` note). `inReplyTo` threads the
 * reply to the inbound note id when one is known. Returns nothing; a write failure
 * is the implementation's to surface (the registry logs whatever it throws).
 */
export type WriteOutbound = (
  channel: string,
  reply: string,
  inReplyTo?: string,
) => Promise<void>;

/**
 * One turn's input to materializing a `#agent/thread` note (the UNIFIED model
 * `definition -> thread -> message`) — the data the registry hands {@link WriteThread}.
 * BOTH execution-lifecycle modes materialize a thread note (the structural unification:
 * everything is a thread; a "run" was always a thread with one turn). Mirrors {@link
 * ThreadRecord} in transport.ts; kept local here so the registry doesn't import the
 * transport layer.
 */
export interface ThreadNote {
  channel: string;
  /**
   * The agent/def name — single-threaded's thread is "named after the definition" (the
   * transport sanitizes it into the deterministic upsert path). Falls back to the channel.
   */
  name?: string;
  /** The `#agent/definition` note id (provenance; plain id string). */
  definition?: string;
  /** The mode the turn ran under — governs thread identity + whether the note upserts. */
  mode: AgentMode;
  /** Outcome — `ok` (success) or `error` (the turn failed). */
  status: "ok" | "error";
  /** The inbound text handed to the turn (the `-p` prompt). */
  input: string;
  /** The reply on success, or the failure reason on error. */
  output: string;
  /** ISO start/end of the turn. */
  started_at: string;
  ended_at: string;
  /** Optional token/cost usage for observability. */
  usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number };
  /**
   * MULTI-threaded only: a stable per-TURN thread id (the per-fire note's leaf). The same
   * id on a re-record (the outbound-failure status flip) reuses the SAME note instead of
   * minting a duplicate. Single-threaded ignores it (deterministic name leaf).
   */
  threadId?: string;
  /**
   * Re-record of the SAME turn — single-threaded keeps `turn_count` (the turn was already
   * counted by the first record); no effect on multi-threaded.
   */
  sameTurn?: boolean;
}

/**
 * Materialize a `#agent/thread` note for a completed turn — the seam the registry posts a
 * thread note through. The daemon wires this to the channel transport's `writeThread()` (a
 * VaultTransport writes a `#agent/thread` note). Called for BOTH modes now (the structural
 * unification — every turn materializes a thread note): single-threaded upserts one note
 * per channel, multi-threaded writes one per fire. A write failure is the implementation's
 * to surface (the registry logs whatever it throws); it never re-runs the turn. Optional on
 * the registry — when unwired (no vault-backed channel), a turn still runs, just no note.
 */
export type WriteThread = (thread: ThreadNote) => Promise<void>;

/** How many times the outbound write is RETRIED on a transient failure (agent — PR #3
 *  FIX 1) before giving up. Total attempts = 1 + this. */
export const OUTBOUND_MAX_RETRIES = 2;
/** Base backoff (ms) between outbound retries — grows linearly (attempt 1 → BASE, 2 → 2×BASE). */
export const OUTBOUND_RETRY_BASE_MS = 250;

/**
 * Classify an outbound-write error as TRANSIENT (worth retrying) vs PERMANENT (a real
 * rejection). The VaultTransport's `reply()` throws `Error` whose message embeds the
 * HTTP status as `(NNN)` for a non-ok vault response, or a raw network/fetch rejection
 * (no status) when the vault is unreachable. So:
 *   - a parseable 5xx (502/503/504/…) → TRANSIENT (a vault blip; retry).
 *   - NO parseable status (a network error, DNS, connection refused) → TRANSIENT.
 *   - a parseable 4xx (400/401/403/409/…) → PERMANENT (a real rejection — auth, bad
 *     request; retrying just re-fails). Do NOT retry these.
 * This keeps the retry to the case the audit flagged (a transient vault 5xx silently
 * losing the reply) without papering over a genuine 4xx rejection.
 */
export function isTransientOutboundError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  const m = msg.match(/\((\d{3})\)/);
  if (!m) return true; // no HTTP status → a network/connection error → transient.
  const status = Number(m[1]);
  return status >= 500 && status <= 599; // 5xx transient; 4xx permanent.
}

/** Sleep helper for the outbound retry backoff (injectable-free; small + bounded). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A queued inbound message awaiting its serial turn. */
interface QueuedMessage {
  /** The inbound text handed to the `claude -p` turn as the prompt. */
  content: string;
  /** The inbound note id (if known), threaded into the outbound reply's `in_reply_to`. */
  inReplyTo?: string;
}

/** A registered programmatic agent's live status (surfaced in /health + the list). */
export type ProgrammaticAgentState = "idle" | "working" | "queued";

/**
 * One registered programmatic agent. Holds the backend handle, its serial queue +
 * in-flight worker, and a tiny bit of observable state (`working` + queue depth).
 */
export interface ProgrammaticAgentHandle {
  /** The agent slug (the spec name). */
  name: string;
  /** The wake channel this agent serves (the first channel of its spec). */
  channel: string;
  /** The spec the agent was registered from (carries the workspace/sandbox policy). */
  spec: AgentSpec;
  /** The backend's opaque handle (passed to `deliver`/`stop`/`status`). */
  backendHandle: AgentHandle;
}

/**
 * The daemon's registry of programmatic agents + their per-channel serial queues.
 *
 * Keyed by CHANNEL (the wake channel) so inbound routing — which only knows the
 * channel — is an O(1) lookup. A second index by NAME backs the lifecycle ops
 * (`deregister`, mutual-exclusion check). One instance per daemon, constructed at
 * boot; injectable deps (`backend`, `writeOutbound`) so tests drive it with a fake
 * backend + a recorder, no real `claude -p` or vault.
 */
export class ProgrammaticAgentRegistry {
  /** channel → handle (the inbound-routing index). */
  private readonly byChannel = new Map<string, ProgrammaticAgentHandle>();
  /** name → channel (the lifecycle index; an agent has exactly one wake channel). */
  private readonly nameToChannel = new Map<string, string>();
  /** channel → FIFO queue of pending messages. */
  private readonly queues = new Map<string, QueuedMessage[]>();
  /** channel → the in-flight drain promise (its presence == a worker is running). */
  private readonly draining = new Map<string, Promise<void>>();

  private readonly backend: AgentBackend;
  private readonly writeOutbound: WriteOutbound;
  /** Optional thread-note sink — materialize an `#agent/thread` note (BOTH modes). */
  private readonly writeThread?: WriteThread;
  /** Optional streaming-view sink — push interim + lifecycle turn events per channel. */
  private readonly onTurnEvent?: TurnEventSink;
  /** Base backoff (ms) between outbound retries (FIX 1). Injectable so tests run fast. */
  private readonly outboundRetryBaseMs: number;

  constructor(deps: {
    backend: AgentBackend;
    writeOutbound: WriteOutbound;
    writeThread?: WriteThread;
    onTurnEvent?: TurnEventSink;
    /** Override the outbound-retry backoff base (ms). Default {@link OUTBOUND_RETRY_BASE_MS}. */
    outboundRetryBaseMs?: number;
  }) {
    this.backend = deps.backend;
    this.writeOutbound = deps.writeOutbound;
    if (deps.writeThread) this.writeThread = deps.writeThread;
    if (deps.onTurnEvent) this.onTurnEvent = deps.onTurnEvent;
    this.outboundRetryBaseMs = deps.outboundRetryBaseMs ?? OUTBOUND_RETRY_BASE_MS;
  }

  /**
   * Emit a turn event to the streaming-view sink, swallowing any throw — a live-view
   * push must NEVER break the serial worker (the durable note path is what matters).
   * A no-op when no sink is wired.
   */
  private emitTurnEvent(channel: string, event: TurnLifecycleEvent): void {
    if (!this.onTurnEvent) return;
    try {
      this.onTurnEvent(channel, event);
    } catch {
      // A dead-stream / sink fault must not strand the queue.
    }
  }

  /** The wake channel for a spec (its first channel, normalized). */
  private static channelOf(spec: AgentSpec): string {
    if (spec.channels.length === 0) {
      throw new Error(`programmatic registry: spec "${spec.name}" declares no channels`);
    }
    return normalizeChannel(spec.channels[0]!).name;
  }

  /** Is a programmatic agent registered for this channel? (the inbound-routing check) */
  hasChannel(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  /** Is a programmatic agent registered under this name? (the mutual-exclusion check) */
  hasName(name: string): boolean {
    return this.nameToChannel.has(name);
  }

  /** The registered handle for a channel, or undefined. */
  getByChannel(channel: string): ProgrammaticAgentHandle | undefined {
    return this.byChannel.get(channel);
  }

  /** The registered handle for a name, or undefined. */
  getByName(name: string): ProgrammaticAgentHandle | undefined {
    const channel = this.nameToChannel.get(name);
    return channel === undefined ? undefined : this.byChannel.get(channel);
  }

  /** All registered handles (for /health + the GET /api/agents list). */
  list(): ProgrammaticAgentHandle[] {
    return [...this.byChannel.values()];
  }

  /**
   * The live status of an agent: `working` while a turn is in flight, `queued`
   * (with the pending count) when messages are waiting, else `idle`. Used by
   * /health + the agents list to render `programmatic · idle|working|queued:N`.
   */
  statusOf(channel: string): { state: ProgrammaticAgentState; queued: number } {
    const queued = this.queues.get(channel)?.length ?? 0;
    if (this.draining.has(channel)) {
      // A worker is in flight. If there are messages waiting BEHIND the in-flight
      // one, report queued:N (N = waiting, not counting the in-flight turn); else
      // working. `queued` is the queue length, which excludes the message currently
      // being processed (it's shifted off before the turn runs).
      return queued > 0 ? { state: "queued", queued } : { state: "working", queued: 0 };
    }
    return { state: "idle", queued: 0 };
  }

  /**
   * Register a programmatic agent from its spec — lightweight: validate, build the
   * backend handle (no resident process), index it by channel + name. The caller
   * (the spawn path) has already set up the workspace + .mcp.json + credentials +
   * spec.json. Idempotent-replace: re-registering the same name swaps the handle
   * (the boot re-register + a re-spawn both land here).
   *
   * Returns the registered handle. Throws if the spec declares no channels (a
   * programmatic agent must have a wake channel to route inbound to).
   */
  async register(spec: AgentSpec): Promise<ProgrammaticAgentHandle> {
    const channel = ProgrammaticAgentRegistry.channelOf(spec);
    // Replace any prior registration for this name (a re-spawn / boot re-register).
    const priorChannel = this.nameToChannel.get(spec.name);
    if (priorChannel !== undefined && priorChannel !== channel) {
      // The name moved to a different wake channel — drop the old channel index.
      // An in-flight drain on the old channel self-terminates (it re-reads
      // `byChannel`, now empty for that channel); we drop its `draining` flag too so
      // the entry doesn't leak until that promise happens to settle.
      this.byChannel.delete(priorChannel);
      this.queues.delete(priorChannel);
      this.draining.delete(priorChannel);
    }
    const backendHandle = await this.backend.start(spec);
    const handle: ProgrammaticAgentHandle = {
      name: spec.name,
      channel,
      spec,
      backendHandle,
    };
    this.byChannel.set(channel, handle);
    this.nameToChannel.set(spec.name, channel);
    return handle;
  }

  /**
   * Deregister a programmatic agent by NAME — drop its indexes + queue and clear
   * its backend session (so a future re-spawn starts a fresh conversation). An
   * in-flight turn is NOT cancelled (a `claude -p` turn is a fire-once subprocess;
   * we just stop routing new inbound to it). Returns whether one was registered.
   */
  async deregister(name: string): Promise<boolean> {
    const channel = this.nameToChannel.get(name);
    if (channel === undefined) return false;
    const handle = this.byChannel.get(channel);
    this.byChannel.delete(channel);
    this.nameToChannel.delete(name);
    this.queues.delete(channel);
    // Clear the persisted resume id so a re-spawn starts fresh (the backend's
    // `stop` is a no-op beyond that — there's no process to kill).
    if (handle) {
      try {
        await this.backend.stop(handle.backendHandle);
      } catch (err) {
        console.error(
          `parachute-agent: programmatic backend.stop for "${name}" failed (continuing): ${(err as Error).message}`,
        );
      }
    }
    return true;
  }

  /**
   * Reset a programmatic agent's conversation — clear its persisted session id so
   * the next message starts fresh, WITHOUT deregistering it. This is what the
   * per-session restart endpoint maps to for a programmatic agent (the interactive
   * restart's "kill + re-spawn" has no analog — there's no process). Returns whether
   * an agent was registered under that name.
   */
  async resetSession(name: string): Promise<boolean> {
    const handle = this.getByName(name);
    if (!handle) return false;
    try {
      await this.backend.stop(handle.backendHandle);
    } catch (err) {
      console.error(
        `parachute-agent: programmatic session reset for "${name}" failed: ${(err as Error).message}`,
      );
    }
    return true;
  }

  /**
   * ENQUEUE an inbound message for the channel's programmatic agent and ensure the
   * serial worker is draining. A no-op (returns false) when no programmatic agent
   * is registered for the channel — the caller falls back to the normal push path.
   *
   * The worker is a single in-flight promise chain per channel (`#draining`): if one
   * is already running, this just appends to the queue and the running worker picks
   * it up; otherwise it starts a new drain. Concurrency is impossible by
   * construction — there is at most ONE drain promise per channel at a time, and the
   * drain processes the queue strictly in order.
   */
  enqueue(channel: string, msg: QueuedMessage): boolean {
    if (!this.byChannel.has(channel)) return false;
    const queue = this.queues.get(channel) ?? [];
    queue.push(msg);
    this.queues.set(channel, queue);
    // Start the worker if it isn't already running. The drain promise's PRESENCE in
    // `draining` is the "a worker is running" flag — set it synchronously before any
    // await so a second enqueue in the same tick can't start a second worker.
    if (!this.draining.has(channel)) {
      const p = this.drain(channel).finally(() => {
        this.draining.delete(channel);
      });
      this.draining.set(channel, p);
    }
    return true;
  }

  /**
   * Drain a channel's queue ONE turn at a time, FIFO, until empty. Each iteration
   * shifts the oldest message, runs ONE `deliver()` turn, and posts a non-empty
   * `ok` reply as an outbound note. Never two concurrent turns — the loop awaits each
   * `deliver()` before shifting the next. Re-checks the queue after each turn so a
   * message enqueued mid-turn is drained in the same run (no missed wake).
   *
   * Failure handling: a `deliver` that returns `{ ok: false }` is LOGGED and dropped
   * (no retry, no loop — the design's "do NOT infinite-loop" contract). A throw from
   * `deliver` (it shouldn't — the contract is failure-as-value) is caught so one bad
   * turn can't kill the worker / strand the rest of the queue. An outbound-write
   * failure is logged; the turn still counts as drained (the reply is durable-or-not
   * at the transport's discretion; we don't re-run the turn, which would fork).
   */
  private async drain(channel: string): Promise<void> {
    for (;;) {
      const queue = this.queues.get(channel);
      if (!queue || queue.length === 0) return;
      const handle = this.byChannel.get(channel);
      if (!handle) return; // deregistered mid-drain — stop.
      const msg = queue.shift()!;

      // The UNIFIED model (the structural unification): BOTH modes materialize a
      // `#agent/thread` note — everything is a thread; a "run" was always a thread with one
      // turn. The MODE difference is the thread's identity (resolved transport-side):
      // single-threaded upserts ONE note per channel (rolling turn_count + usage),
      // multi-threaded writes one note per fire. Read the mode off the spec so the
      // thread note carries it (it's the indexed query axis + governs the upsert).
      const startedAt = new Date().toISOString();
      // A stable per-TURN thread id, passed to every recordThread for this turn. For
      // multi-threaded it's the per-fire note's leaf, so a re-record (the outbound-failure
      // status flip below) updates the SAME note instead of minting a duplicate; single-
      // threaded ignores it (deterministic name leaf). One uuid per turn.
      const turnThreadId = crypto.randomUUID();

      let result;
      try {
        // Forward each interim event to the streaming-view sink (keyed by channel)
        // as the turn runs — the "watch it work" live progress. The sink swallows
        // its own throws (emitTurnEvent), so a dead live stream can't break the turn.
        result = await this.backend.deliver(handle.backendHandle, msg.content, (e) =>
          this.emitTurnEvent(channel, e),
        );
      } catch (err) {
        // The backend contract is failure-as-VALUE, never a throw — but defend so a
        // surprise throw can't kill the worker and strand the queue. Resolve the live
        // view to an error state (no stuck "working" spinner).
        const reason = (err as Error).message;
        console.error(
          `parachute-agent: programmatic turn for channel "${channel}" threw ` +
            `(should be a value): ${reason}`,
        );
        // BOTH modes materialize a thread note even on a (defensive-catch) failure — the
        // thread note captures the turn outcome, so a failed turn is still a queryable
        // `status:error` (single-threaded upserts the rolling thread; multi-threaded writes
        // a per-fire note).
        await this.recordThread(handle, msg, "error", reason, startedAt, undefined, { threadId: turnThreadId });
        this.emitTurnEvent(channel, { kind: "error", error: reason });
        continue;
      }

      if (!result.ok) {
        // Logged + dropped — no retry, no loop. The backend already persisted the
        // session id (a turn can fail after establishing a session), so the next
        // message resumes the conversation. Resolve the live view to an error state.
        console.warn(
          `parachute-agent: programmatic turn for channel "${channel}" failed: ${result.error}`,
        );
        // BOTH modes record the failed turn (status:error) on the thread note so a failure
        // always leaves a queryable trace (single-threaded upserts the rolling thread,
        // marking it errored; multi-threaded writes a per-fire status:error note).
        await this.recordThread(handle, msg, "error", result.error, startedAt, undefined, { threadId: turnThreadId });
        this.emitTurnEvent(channel, { kind: "error", error: result.error });
        continue;
      }

      // The THREAD NOTE comes FIRST — it is the PRIMARY record of the turn (status:ok now
      // that the turn succeeded), so it must survive even if the ADDITIVE outbound transcript
      // write below fails (that path `continue`s past here). Writing it before the outbound
      // (the c34db03 ordering — now applied UNIFORMLY to both modes) guarantees the turn's
      // record survives an outbound failure: single-threaded upserts the rolling thread,
      // multi-threaded writes the per-fire note. Best-effort: a thread-note failure is
      // logged + the turn still resolves (we never re-run a `claude -p` turn — that would
      // burn quota for a duplicate).
      await this.recordThread(handle, msg, "ok", result.reply ?? "", startedAt, result.usage, { threadId: turnThreadId });

      // The outbound reply — the channel-transcript delivery (the chat bubble). It is
      // ADDITIVE to the primary thread-note record already written above (for BOTH modes).
      // Empty reply → NO note (reviewer contract — `reply` can be ""): a turn that produced
      // no text (e.g. tool-only work) leaves the chat clean.
      if (result.reply && result.reply.length > 0) {
        const delivered = await this.deliverOutboundWithRetry(channel, result.reply, msg.inReplyTo);
        if (!delivered.ok) {
          // FIX 1 (PR #3) — the SCARY one. The reply was PRODUCED but, after the bounded
          // retry, still NOT persisted to the transcript (a persistent vault 5xx / network
          // fault, or a real 4xx rejection). We must NOT leave a clean `status:ok` record
          // claiming the reply landed when it didn't:
          //   1. RE-RECORD the thread note as `status:error` so the durable thread record
          //      reflects the UN-DELIVERED reply (overwrites the optimistic `ok` upsert for
          //      single-threaded; writes/overwrites the per-fire note for multi-threaded).
          //   2. Resolve the live view to ERROR (not `done`) so the UI doesn't drop the
          //      in-progress bubble + poll for a note that isn't there (PR #83 nit).
          // We do NOT re-run the `claude -p` turn (that forks/burns quota) — the reply text
          // is preserved IN the error thread note's output for an operator to recover.
          console.error(
            `parachute-agent: programmatic outbound write for channel "${channel}" failed ` +
              `after ${OUTBOUND_MAX_RETRIES} retries: ${delivered.error}`,
          );
          // RE-RECORD the SAME turn as status:error — reuse the per-turn thread id +
          // `sameTurn` so this updates the note the `ok` record above just wrote (one
          // note, no turn_count double-count) rather than minting a duplicate / advancing
          // the count (the FIX-1 re-record bug the reviewer caught).
          await this.recordThread(
            handle,
            msg,
            "error",
            `reply produced but NOT delivered (outbound write failed: ${delivered.error}). ` +
              `Undelivered reply text: ${result.reply}`,
            startedAt,
            result.usage,
            { threadId: turnThreadId, sameTurn: true },
          );
          this.emitTurnEvent(channel, {
            kind: "error",
            error: `reply produced but not saved: ${delivered.error}`,
          });
          continue;
        }
      }

      // Resolve the live view: `done` carries the final reply text (empty when the
      // turn produced none) so the UI finalizes the in-progress bubble — the durable
      // note (written above) is what actually persists; this just ends the spinner.
      // Reached only when the outbound write SUCCEEDED, or there was no reply to write
      // (empty/tool-only turn → clean resolve, no note expected).
      this.emitTurnEvent(channel, { kind: "done", reply: result.reply ?? "" });
    }
  }

  /**
   * Materialize the `#agent/thread` note for a completed turn — the UNIFIED model, written
   * for BOTH modes (the structural unification). A no-op when no {@link WriteThread} sink is
   * wired (a channel with no durable store). The timing is captured by the caller
   * (`startedAt` before the turn; `ended_at` is now). The MODE rides on the note so the
   * transport resolves the thread identity (single-threaded upserts one note per channel,
   * multi-threaded writes one per fire) + the upsert aggregation. The thread `name` is the
   * agent name (single-threaded's thread is "named after the definition"). Best-effort: a
   * write failure is LOGGED, never thrown out — a missing thread note must not strand the
   * queue, and the turn is never re-run (it would burn quota for a duplicate `claude -p`).
   */
  private async recordThread(
    handle: ProgrammaticAgentHandle,
    msg: QueuedMessage,
    status: "ok" | "error",
    output: string,
    startedAt: string,
    usage: ThreadNote["usage"],
    opts: { threadId?: string; sameTurn?: boolean } = {},
  ): Promise<void> {
    if (!this.writeThread) return;
    const thread: ThreadNote = {
      channel: handle.channel,
      name: handle.spec.name,
      ...(handle.spec.definition ? { definition: handle.spec.definition } : {}),
      mode: handle.spec.mode ?? "single-threaded",
      status,
      input: msg.content,
      output,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      ...(usage ? { usage } : {}),
      // The per-turn thread id (stable across an ok→error re-record) + the same-turn flag,
      // so a re-record updates the SAME note without minting a duplicate (multi) or
      // double-counting turn_count (single).
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.sameTurn ? { sameTurn: true } : {}),
    };
    try {
      await this.writeThread(thread);
    } catch (err) {
      console.error(
        `parachute-agent: writing #agent/thread note for channel "${handle.channel}" failed ` +
          `(continuing): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Deliver the outbound reply with a BOUNDED retry on a TRANSIENT failure (FIX 1, PR
   * #3). A vault 5xx / network blip during the outbound write used to silently lose the
   * reply (the turn resolved, the thread note said "ok", but the chat bubble never
   * landed). We retry up to {@link OUTBOUND_MAX_RETRIES} times with a small linear
   * backoff on a transient error ({@link isTransientOutboundError}: a 5xx or a
   * no-status network error). A PERMANENT error (a 4xx — a real rejection) does NOT
   * retry. Returns `{ ok: true }` once the write lands, or `{ ok: false, error }` after
   * exhausting the retries / on a permanent failure — the caller then records the turn
   * as un-delivered + surfaces it (never claims a clean success). We NEVER re-run the
   * `claude -p` turn here (that would fork the conversation / burn quota); only the
   * idempotent outbound WRITE is retried.
   */
  private async deliverOutboundWithRetry(
    channel: string,
    reply: string,
    inReplyTo?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let lastError = "";
    for (let attempt = 0; attempt <= OUTBOUND_MAX_RETRIES; attempt++) {
      try {
        await this.writeOutbound(channel, reply, inReplyTo);
        return { ok: true };
      } catch (err) {
        lastError = (err as Error).message;
        const transient = isTransientOutboundError(err);
        const more = attempt < OUTBOUND_MAX_RETRIES;
        if (!transient || !more) {
          // A permanent (4xx) error never retries; a transient one that exhausted the
          // budget falls through to the failure return below.
          if (!transient) {
            console.warn(
              `parachute-agent: outbound write for channel "${channel}" failed with a ` +
                `non-transient error (not retrying): ${lastError}`,
            );
          }
          return { ok: false, error: lastError };
        }
        // Transient + retries remain — back off (linear) and try again.
        console.warn(
          `parachute-agent: outbound write for channel "${channel}" transient failure ` +
            `(attempt ${attempt + 1}/${OUTBOUND_MAX_RETRIES + 1}), retrying: ${lastError}`,
        );
        await delay(this.outboundRetryBaseMs * (attempt + 1));
      }
    }
    return { ok: false, error: lastError };
  }
}
