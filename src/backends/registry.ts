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
 * reply back as an outbound `#channel-message/outbound` note.
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
 * which tags the note `#channel-message/outbound` — the vault inbound trigger keys on
 * `#channel-message/inbound` only, so writing the reply CANNOT re-trigger the inbound
 * webhook (no loop).
 */

import type { AgentSpec } from "../sandbox/types.ts";
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
 * VaultTransport writes a `#channel-message/outbound` note). `inReplyTo` threads the
 * reply to the inbound note id when one is known. Returns nothing; a write failure
 * is the implementation's to surface (the registry logs whatever it throws).
 */
export type WriteOutbound = (
  channel: string,
  reply: string,
  inReplyTo?: string,
) => Promise<void>;

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
  /** Optional streaming-view sink — push interim + lifecycle turn events per channel. */
  private readonly onTurnEvent?: TurnEventSink;

  constructor(deps: { backend: AgentBackend; writeOutbound: WriteOutbound; onTurnEvent?: TurnEventSink }) {
    this.backend = deps.backend;
    this.writeOutbound = deps.writeOutbound;
    if (deps.onTurnEvent) this.onTurnEvent = deps.onTurnEvent;
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
          `parachute-channel: programmatic backend.stop for "${name}" failed (continuing): ${(err as Error).message}`,
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
        `parachute-channel: programmatic session reset for "${name}" failed: ${(err as Error).message}`,
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
          `parachute-channel: programmatic turn for channel "${channel}" threw ` +
            `(should be a value): ${reason}`,
        );
        this.emitTurnEvent(channel, { kind: "error", error: reason });
        continue;
      }

      if (!result.ok) {
        // Logged + dropped — no retry, no loop. The backend already persisted the
        // session id (a turn can fail after establishing a session), so the next
        // message resumes the conversation. Resolve the live view to an error state.
        console.warn(
          `parachute-channel: programmatic turn for channel "${channel}" failed: ${result.error}`,
        );
        this.emitTurnEvent(channel, { kind: "error", error: result.error });
        continue;
      }

      // Empty reply → NO note (reviewer contract — `reply` can be ""). A turn that
      // legitimately produced no text (e.g. tool-only work) leaves the chat clean.
      if (result.reply && result.reply.length > 0) {
        try {
          await this.writeOutbound(channel, result.reply, msg.inReplyTo);
        } catch (err) {
          const reason = (err as Error).message;
          console.error(
            `parachute-channel: programmatic outbound write for channel "${channel}" failed: ${reason}`,
          );
          // The reply was produced but NOT persisted. Resolve the live view to ERROR,
          // not `done` — a `done` would drop the in-progress bubble and trigger a poll
          // that finds no note, leaving the user with a silently vanished reply.
          // (reviewer nit, PR #83)
          this.emitTurnEvent(channel, { kind: "error", error: `reply produced but not saved: ${reason}` });
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
}
