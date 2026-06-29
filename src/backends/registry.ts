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
import { normalizeChannel, threadKey } from "../sandbox/types.ts";
import type { AgentBackend, AgentHandle, InterimTurnEvent, LoadoutEntry, RunContext, TurnSession } from "./types.ts";
import type { InboundAttachment } from "../transport.ts";

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
 * reply to the inbound note id when one is known.
 *
 * RETURN: optionally the written outbound note's id (`{ id }`) — the agent-to-agent
 * callback uses it as the `source_message` an orchestrator pulls the full reply from.
 * Returning `void` (or `{}`) is fine — the callback then just omits `source_message`
 * (the sender still learns the turn finished; it has the `source_thread` to pull from).
 * Kept BACK-COMPAT: every existing `async () => {}` recorder still satisfies this (`void`
 * is a member of the union). A write failure is still surfaced as a throw (the registry's
 * retry/record logic depends on the throw, not the return).
 */
export type WriteOutbound = (
  channel: string,
  reply: string,
  inReplyTo?: string,
  /**
   * The RESOLVABLE, MODE-CORRECT thread id this reply belongs to — the explicit
   * definition→thread→message link the outbound note carries (stamped into `metadata.thread`),
   * mirroring the callback `source_thread` fix (agent#124/#163). For multi-threaded it IS the
   * per-fire thread note's leaf (`Threads/<channel>/<id>`); for single-threaded it is the
   * DETERMINISTIC thread-NOTE id (`Threads/<channel>/<name>`), STABLE across turns — so an
   * observer reading the outbound note's `metadata.thread` resolves the agent's ONE thread
   * with `query-notes { id }`, instead of the per-turn correlation UUID that changed every
   * run (the pre-#163 bug that looked like a fresh session each time). INBOUND-note stamping
   * is deferred (those notes are externally written; see the PR notes).
   */
  threadId?: string,
) => Promise<{ id?: string } | void>;

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
  /**
   * The thread SUBJECT (roles×threads NEXT slice, #120) — when present, a MULTI-threaded
   * thread becomes a DETERMINISTIC, upserting note at `threadKey(name, subject)`
   * (`Threads/<ch>/<name>--<subject>`) carrying a session across fires (per-thread
   * continuity), instead of a per-fire uuid note. Absent/empty → today's identity
   * (single-threaded deterministic note / multi-threaded per-fire note), byte-identical to HEAD.
   */
  subject?: string;
  /** The `#agent/definition` note id (provenance; plain id string). */
  definition?: string;
  /** The mode the turn ran under — governs thread identity + whether the note upserts. */
  mode: AgentMode;
  /**
   * Outcome / lifecycle state after THIS write — `working` (the start-ensure, written
   * BEFORE the turn finishes — the turn has started but not completed), `ok` (success), or
   * `error` (failed). `working` is only valid alongside `phase: "start"`. This is metadata
   * only — the daemon does not write the thread BODY (the authored thread content is preserved).
   */
  status: "ok" | "error" | "working";
  /**
   * The Claude session UUID for this turn — the transport persists it to the thread
   * note's `metadata.session` (the thread≡session record), so the NEXT turn can
   * `--resume` it. Set ONLY on the `end` record, and ONLY from the session claude
   * actually ECHOED (`result.sessionId`, captured from the init/result event). A turn
   * that never established a session (claude exited before creating one) persists NONE
   * — and a single-threaded prior session is preserved by the transport — so the next
   * turn resolves a fresh create and SELF-HEALS rather than `--resume`ing a phantom id
   * (which would brick the channel: "No conversation found" is non-transient → no retry).
   * NOT set on the `start`-ensure (it runs before claude, so no session exists yet).
   */
  session?: string;
  /** ISO start/end of the turn (a start-ensure does not advance the thread's last_turn_at). */
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
  /**
   * The lifecycle PHASE of this write (thread-as-container). `"start"` = the WORKING-ENSURE
   * before the turn (status `working`, turn_count UNCHANGED — no turn completed yet);
   * `"end"` (DEFAULT when absent) = the final record after the turn (turn_count increments
   * on the `end` write). So a turn is counted EXACTLY ONCE — on `end`, never on `start`.
   */
  phase?: "start" | "end";
}

/**
 * Materialize a `#agent/thread` note for a completed turn — the seam the registry posts a
 * thread note through. The daemon wires this to the channel transport's `writeThread()` (a
 * VaultTransport writes a `#agent/thread` note). Called for BOTH modes now (the structural
 * unification — every turn materializes a thread note): single-threaded upserts one note
 * per channel, multi-threaded writes one per fire. A write failure is the implementation's
 * to surface (the registry logs whatever it throws); it never re-runs the turn. Optional on
 * the registry — when unwired (no vault-backed channel), a turn still runs, just no note.
 *
 * RETURNS the WRITTEN thread-note's id (`{ id }`) so the drain can use it as a RESOLVABLE
 * `source_thread` on the agent-to-agent callback (agent#124) — for BOTH modes, this is the
 * actual note an orchestrator can pull with `query-notes { id }` (single-threaded: the
 * deterministic `Threads/<safeChannel>/<safeName>` note; multi-threaded: the per-fire
 * `Threads/<safeChannel>/<uuid>` note). `void` is in the union (back-compat) — a transport
 * with no durable store, or one that can't surface an id, returns it and the drain falls
 * back to the per-turn id.
 */
export type WriteThread = (thread: ThreadNote) => Promise<{ id?: string } | void>;

/**
 * A callback delivered back to a SENDER's channel when a turn it requested finishes —
 * the agent-to-agent request/response substrate ("reply_to"). The daemon wires this to
 * write a NEW `#agent/message/inbound` note to the `channel` (so it wakes the sender
 * through the normal inbound path), carrying the {@link CallbackMeta} contract.
 *
 * The content is a brief NOTIFICATION + a LINK to the result (NOT the full reply
 * duplicated) — the orchestrator reads `source_message`/`source_thread` off the metadata
 * and PULLS the full result if it wants (the user's explicit choice: summary + link,
 * orchestrator pulls — cleaner + a better security boundary than fan-out duplication).
 *
 * LOOP SAFETY (load-bearing): the callback note this writes carries the INBOUND tags so
 * it routes, but the daemon's wiring MUST NOT put a `reply_to` on it — a callback is
 * TERMINAL, so handling one can never auto-trigger another callback (no ping-pong).
 *
 * A write failure is the implementation's to surface (the registry logs whatever it
 * throws); a callback NEVER re-runs the turn. Optional on the registry — when unwired (no
 * vault-backed channels), reply_to is silently inert.
 */
export type WriteCallback = (channel: string, content: string, meta: CallbackMeta) => Promise<void>;

/**
 * The METADATA CONTRACT a callback inbound note carries (design
 * 2026-06-20-agent-callbacks.md). The daemon's {@link WriteCallback} wiring stamps these
 * onto the new `#agent/message/inbound` note's `metadata` (the vault stores them as
 * strings). The orchestrator reads `source_message` / `source_thread` to PULL the full
 * result. Deliberately a SUMMARY + LINK, never the duplicated reply body.
 */
export interface CallbackMeta {
  /**
   * `"true"` — the marker that distinguishes a callback inbound from an ordinary one, so
   * an orchestrator's turn can tell "a sub-task finished" from "a new request arrived".
   */
  callback: "true";
  /** The terminal outcome of the requested turn — `ok` (succeeded) or `error` (failed). */
  status: "ok" | "error";
  /** The channel/def whose turn just finished (the recipient) — provenance for the sender. */
  source_channel: string;
  /**
   * The WRITTEN thread-note id — RESOLVABLE for BOTH modes (agent#124): an orchestrator can
   * always pull the recipient's full thread record with `query-notes { id: source_thread }`,
   * even on an error/empty/tool-only turn (the thread note is written BEFORE the outbound
   * reply, so its id exists when there's no `source_message`).
   *  - multi-threaded: the per-fire note id (`Threads/<safeChannel>/<uuid>`).
   *  - single-threaded: the deterministic note id (`Threads/<safeChannel>/<safeName>`) — NOT
   *    the per-turn correlation id (the pre-#124 bug: that correlation id wasn't the note leaf
   *    for single-threaded, so it couldn't be resolved).
   * The drain sources this from {@link WriteThread}'s returned id; if the seam can't surface
   * one (no durable store) it falls back to the per-turn id (still a stable provenance token).
   */
  source_thread: string;
  /**
   * The recipient's OUTBOUND reply note id, when the turn produced (and delivered) a
   * reply. The orchestrator pulls the full reply text from here. ABSENT when there was no
   * reply (an error turn, or an empty/tool-only turn) — the callback still fires so the
   * orchestrator learns the turn is done; it just has no reply note to pull.
   */
  source_message?: string;
  /** The sender's opaque correlation id, echoed verbatim when one was set. Omitted otherwise. */
  correlation_id?: string;
  /**
   * The depth of THIS callback = the incoming message's depth + 1. The sender's turn,
   * woken by this callback, inherits it; if that turn delegates onward, the chain's depth
   * keeps climbing toward {@link MAX_DELEGATION_DEPTH}.
   */
  delegation_depth: string;
}

/**
 * The hard ceiling on delegation HOPS — the depth loop guard (design
 * 2026-06-20-agent-callbacks.md §loop-safety). An inbound message arriving at or past this
 * depth delivers NO callback (logged), which BOUNDS any chain even if the no-`reply_to`-on-
 * callback rule were somehow circumvented. 8 is generous for real orchestration trees
 * (an orchestrator → workers → sub-workers fan-out is 2-3 deep) while still finite.
 */
export const MAX_DELEGATION_DEPTH = 8;

/**
 * Cap on the per-channel PENDING-INBOUND queue (the agent#121 pre-registration buffer).
 * A buffer that grows without bound is a memory-leak / DoS footgun if a channel's agent
 * never comes up; past the cap the OLDEST pending message is dropped (FIFO eviction) with
 * a loud log — bounded loss is better than unbounded growth, and the durable inbound notes
 * still exist in the vault for the agent to re-read once it's live.
 */
export const PENDING_INBOUND_CAP = 50;

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

/**
 * The thread id to stamp into an OUTBOUND note's `metadata.thread` (agent#163) — the
 * MODE-CORRECT, RESOLVABLE definition→thread→message link, mirroring the callback
 * `source_thread` fix (agent#124). Keyed on `perFire`:
 *
 *  - DETERMINISTIC thread (`perFire: false`) — single-threaded, OR a multi-threaded SUBJECT
 *    thread (roles×threads NEXT slice, #120). The note is the resolvable, deterministic
 *    `Threads/<safeChannel>/<name[--subject]>` note, so an observer reading the outbound's
 *    `metadata.thread` resolves the agent's stable thread with `query-notes { id }`. Stamp
 *    the resolvable `threadNoteId`. The pre-#163 bug stamped the per-turn correlation UUID
 *    here, which changed every turn and resolved to nothing.
 *  - PER-FIRE thread (`perFire: true`) — a multi-threaded thread with NO subject: each fire is
 *    its own note at `Threads/<safeChannel>/<turnThreadId>`, so the per-fire id IS the leaf.
 *
 * Falls back to `turnThreadId` when no resolvable note id surfaced (no durable thread store
 * wired, or the thread-note write failed) — never undefined, so the link is always stamped.
 */
export function outboundThreadId(
  perFire: boolean,
  turnThreadId: string,
  threadNoteId: string | undefined,
): string {
  if (perFire) return turnThreadId;
  return threadNoteId ?? turnThreadId;
}

/**
 * Derive the run-context `fired-by` provenance (agent#162) from an inbound message's
 * `sender` (the note's `metadata.sender`). A SCHEDULED job fire stamps `runner:<jobId>`
 * (the runner's sender provenance) → reported as the job id so the agent knows it's a cron
 * fire; anything else (a human / a delegated agent message) → `interactive`. Absent sender →
 * undefined (the run context omits `fired-by`).
 */
export function runFiredBy(sender: string | undefined): string | undefined {
  if (!sender) return undefined;
  const m = /^runner:(.+)$/.exec(sender);
  if (m) return `scheduled-job:${m[1]}`;
  return "interactive";
}

/** A queued inbound message awaiting its serial turn. */
export interface QueuedMessage {
  /** The inbound text handed to the `claude -p` turn as the prompt. */
  content: string;
  /** The inbound note id (if known), threaded into the outbound reply's `in_reply_to`. */
  inReplyTo?: string;
  // ── AGENT-TO-AGENT CALLBACK ROUTING ("reply_to") ───────────────────────────────
  // These ride from the inbound note's metadata (a SENDING agent stamps them when it
  // writes an inbound note to THIS channel via the vault), through `contextFor.emit`
  // (daemon.ts, which flattens note.metadata into `meta`), onto this queue item, so the
  // drain can deliver a CALLBACK to the originating channel when this turn finishes.
  /**
   * The SENDER's channel name — where to deliver a callback when this turn completes
   * (BOTH ok and error). A single-threaded agent's channel ↔ thread is 1:1, so an
   * orchestrator knows its own channel = its def name and stamps it here when it writes
   * the inbound note to the recipient. Absent → NO callback (a normal, non-orchestrated
   * turn). A callback note itself NEVER carries `reply_to` (it's terminal — that is the
   * primary loop guard; see {@link MAX_DELEGATION_DEPTH}).
   */
  replyTo?: string;
  /**
   * An OPAQUE id the sender uses to match a callback to the request it fired (it may
   * have N sub-tasks in flight). Echoed verbatim onto the callback metadata; the daemon
   * never interprets it. Absent → omitted from the callback.
   */
  correlationId?: string;
  /**
   * How many delegation HOPS deep this message is (0 = a top-level human/runner turn).
   * Incremented on each callback hop; bounds runaway chains. A message arriving at or
   * past {@link MAX_DELEGATION_DEPTH} delivers NO callback (the depth loop guard). The
   * vault stores metadata as STRINGS, so daemon.ts coerces `metadata.delegation_depth`
   * to a finite integer before it lands here; a missing/garbage value reads as 0.
   */
  delegationDepth?: number;
  /**
   * Files attached to this inbound message (Phase 1: inbound file attachments → the
   * programmatic turn). Threaded transport → daemon → `deliver`; the programmatic
   * backend stages each into the agent's private session workspace so the turn can
   * `Read` it. Absent/empty → no attachments (today's behavior unchanged).
   */
  attachments?: InboundAttachment[];
  /**
   * WHO/WHAT sent this inbound (the note's `metadata.sender`) — used ONLY to derive the
   * run-context `fired-by` provenance the daemon injects into the turn (agent#162): a
   * SCHEDULED job fire stamps `runner:<jobId>`, an interactive/delegated message stamps
   * something else. Absent → the run context omits `fired-by`. Carries no routing meaning.
   */
  sender?: string;
  /**
   * The THREAD SUBJECT (roles×threads NOW slice) — rides from the inbound note's
   * `metadata.subject`, through `contextFor.emit` (daemon.ts), onto this queue item.
   * In the NOW slice it carries NO routing meaning — the drain stays per-CHANNEL serial,
   * NOT per-subject — but it is threaded through so the composed prompt can fold in a
   * subject dossier and the NEXT slice (#120 thread routing + per-thread session
   * continuity) can key off it without re-plumbing. Absent → no subject (today's behavior;
   * the weave path is untouched). Carries no routing meaning in NOW.
   */
  subject?: string;
  /**
   * The THREAD-ID (threads-only Phase B — DESIGN-2026-06-29-threads-only.md §5/§9) — rides
   * from the inbound note's `metadata.thread` (read FIRST by {@link noteAgentKey}). When
   * present it IS the {@link drainKeyFor} drain key directly, so a thread-addressed inbound
   * serializes per-thread regardless of subject/mode. ADDITIVE + dormant: nothing writes
   * `metadata.thread` yet (Phase C flips the writer), and the 4 live def agents carry only
   * `metadata.agent` → no `thread` → the bare-channel drain key (byte-identical to HEAD).
   */
  thread?: string;
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
  /**
   * thread-id → channel (the THREAD-ADDRESS index — threads-only Phase B,
   * DESIGN-2026-06-29-threads-only.md §3/§5). An ADDITIVE parallel index to
   * {@link nameToChannel}: an inbound carrying `metadata.thread` routes through here.
   * Populated on {@link register} from {@link threadIdOf} (the spec's thread identity).
   * For the 4 live def agents the thread-id ≡ name ≡ channel, so this maps `steward → steward`
   * exactly like `nameToChannel` — the def path is unchanged; this index is just the
   * additional lookup a `metadata.thread`-addressed inbound consults (a `metadata.agent`
   * inbound never reads it). It's a CACHE of the live set, rebuildable by listing
   * `#agent/thread`; the durable record is the thread note.
   */
  private readonly byThread = new Map<string, string>();
  /**
   * DRAIN-KEY → FIFO queue of pending messages — the PER-THREAD serial queue
   * (roles×threads NEXT slice, #120). The drain key is {@link drainKeyFor}:
   *  - a single-threaded agent, OR a message with NO subject → the bare CHANNEL
   *    (byte-identical to HEAD — every current agent incl. the weave routes here).
   *  - a multi-threaded agent WITH a subject → `threadKey(spec.name, subject)`
   *    (`<name>--<subject>`), so distinct subjects of one agent get distinct queues.
   * Keying queues + {@link draining} by the SAME drain key is what makes two messages
   * of the SAME (name, subject) strictly serial while letting two DIFFERENT subjects
   * of one agent run concurrently — the per-thread serial guarantee (class doc lines 13-20).
   */
  private readonly queues = new Map<string, QueuedMessage[]>();
  /**
   * DRAIN-KEY → the in-flight drain promise (its presence == a worker is running for that
   * thread). One promise per drain key is the structural lock: a second message for the
   * SAME drain key never starts a second worker (it appends + the running worker picks it
   * up), so a given (name, subject) thread is NEVER processed by two concurrent `claude -p`.
   * A DIFFERENT subject is a DIFFERENT key → its own promise → may run concurrently.
   */
  private readonly draining = new Map<string, Promise<void>>();
  /**
   * channel → FIFO queue of PENDING-INBOUND messages that arrived BEFORE a live
   * programmatic agent was registered for the channel (the agent#121 fix). The daemon
   * OWNS these — it must never drop an inbound it can't yet process (the vault trigger
   * acks success on the daemon's 200 and never retries, so a drop is permanent). On
   * {@link register} the channel's pending queue is DRAINED into the normal {@link
   * enqueue} path, so the queued turns run in arrival order once the agent is live.
   * IN-MEMORY only (v1): a daemon restart loses pending, which is fine — the durable
   * inbound notes still exist in the vault and `loadAll` + the 60s def-poll reconverge.
   */
  private readonly pending = new Map<string, QueuedMessage[]>();
  /**
   * Channels EXPECTED to gain a live programmatic agent (a def maps here / the
   * instantiate path has started bringing one up) — the gate for {@link queuePending}.
   * Only an EXPECTED channel queues a pre-registration inbound; a genuinely unknown
   * channel (nothing maps to it) is logged + dropped (there's nothing to deliver to).
   * Marked by {@link expectChannel} (the def-instantiation path) and by {@link register}
   * itself; cleared by {@link unexpectChannel} (deregister/teardown).
   */
  private readonly expectedChannels = new Set<string>();

  private readonly backend: AgentBackend;
  private readonly writeOutbound: WriteOutbound;
  /** Optional thread-note sink — materialize an `#agent/thread` note (BOTH modes). */
  private readonly writeThread?: WriteThread;
  /**
   * Optional callback sink — deliver an agent-to-agent callback to a sender's channel on
   * turn completion (the "reply_to" substrate). Unwired → reply_to is silently inert.
   */
  private readonly writeCallback?: WriteCallback;
  /** Optional streaming-view sink — push interim + lifecycle turn events per channel. */
  private readonly onTurnEvent?: TurnEventSink;
  /**
   * Optional pre-turn session read — the persisted Claude session UUID for a
   * single-threaded agent's thread note (the daemon wires this to the channel
   * transport's `readThreadSession`). Read in {@link drain} so a single-threaded turn
   * 2+ `--resume`s its prior conversation. Unwired (or no prior) → every turn creates a
   * fresh session. Multi-threaded NEVER consults it (each fire is a fresh thread).
   */
  private readonly readSession?: (
    channel: string,
    name: string,
    subject?: string,
  ) => Promise<string | undefined>;
  /**
   * Optional session CLEAR — wipe a single-threaded agent's persisted thread-note session
   * so its next turn starts a FRESH claude conversation (the per-agent restart). The daemon
   * wires this to the channel transport's `clearThreadSession`. Called by {@link resetSession}.
   * Unwired → reset is a clean no-op beyond returning that the agent exists.
   */
  private readonly clearSession?: (channel: string, name: string, subject?: string) => Promise<void>;
  /**
   * Optional pre-turn LOADOUT read (threads-only Phase A — DESIGN-2026-06-29-threads-only.md
   * §9). Resolves the thread's `metadata.loadout` (an array of note PATHS) off its
   * `#agent/thread` note and returns each as a {@link LoadoutEntry} (`{path, content}` —
   * CONTENT only, never metadata). Read in {@link drain} and passed to the backend's `deliver`,
   * which prepends the SELF entry (the def body) and composes the arity-N system prompt. This
   * SUPERSEDES the rc.13 `readSubjectDossier` (arity-2) seam. UNWIRED → empty loadout, so every
   * turn composes `# <path>\n\n<def body>` (the no-loadout invariant — byte-identical to HEAD
   * apart from the path header). Best-effort: a read failure logs + the turn runs with the empty
   * loadout (self entry only), never strands the queue. Missing paths are skipped-and-warned by
   * the resolver itself (never throws on a missing note).
   */
  private readonly readLoadout?: (
    channel: string,
    name: string,
    subject?: string,
  ) => Promise<LoadoutEntry[]>;
  /**
   * Optional pre-turn loaded-PACK grant-KEY read (threads-only Phase B′ —
   * DESIGN-2026-06-29-threads-only.md §4). Resolves the SAME `metadata.loadout` paths as
   * {@link readLoadout}, but reads the loaded notes' METADATA to find the `#pack` notes
   * declaring `wants:`, returning each such pack's slugged-path grant key (`packPathKey`). Read
   * in {@link drain} and passed to `deliver`, which UNIONS each pack's APPROVED grants with the
   * def's own (`spec.name`). The SECURITY GATE (a non-pack note's `wants:` is ignored) lives in
   * the resolver. SEPARATE from {@link readLoadout} so the prompt composition stays content-only
   * (Phase A). UNWIRED / no pack with `wants:` → empty → the grant source set is exactly
   * `[spec.name]` (legacy continuity — byte-identical injection for every current agent).
   */
  private readonly readPackKeys?: (
    channel: string,
    name: string,
    subject?: string,
  ) => Promise<string[]>;
  /**
   * Optional pre-turn THREAD-CONTENT read (DESIGN-2026-06-29-thread-content-and-skills.md). The
   * thread note's own authored BODY (`{ path, content }` — CONTENT only) becomes the prompt entry
   * BETWEEN the def (self) and the loadout. Read in {@link drain} and passed to the backend's
   * `deliver`, which composes `[self, thread-content, ...loadout]` (the def + thread content
   * protected from budget truncation). The daemon NEVER writes this content. UNWIRED / no thread
   * note / blank body → undefined → the prompt is `[self, ...loadout]` (the no-thread-content
   * invariant). Best-effort: a read failure logs + the turn runs without thread content.
   */
  private readonly readThreadContent?: (
    channel: string,
    name: string,
    subject?: string,
  ) => Promise<{ path: string; content: string } | undefined>;
  /** Base backoff (ms) between outbound retries (FIX 1). Injectable so tests run fast. */
  private readonly outboundRetryBaseMs: number;

  constructor(deps: {
    backend: AgentBackend;
    writeOutbound: WriteOutbound;
    writeThread?: WriteThread;
    writeCallback?: WriteCallback;
    onTurnEvent?: TurnEventSink;
    /**
     * Read the persisted thread-note session UUID. `subject` (roles×threads NEXT slice, #120)
     * resolves the SUBJECT-scoped thread note for a multi-threaded subject thread; omitted →
     * the deterministic def-named note (single-threaded resume, HEAD).
     */
    readSession?: (channel: string, name: string, subject?: string) => Promise<string | undefined>;
    /**
     * Clear the persisted thread-note session (the per-agent restart / reset). `subject`
     * resolves the subject-scoped thread note; omitted → the def-named note (HEAD).
     */
    clearSession?: (channel: string, name: string, subject?: string) => Promise<void>;
    /**
     * Read the thread's LOADOUT (threads-only Phase A) — the `metadata.loadout` note paths
     * resolved to `{path, content}` entries. Optional — UNWIRED → empty loadout (the def body
     * alone, the no-loadout invariant). `subject` resolves the subject-scoped thread note.
     */
    readLoadout?: (channel: string, name: string, subject?: string) => Promise<LoadoutEntry[]>;
    /**
     * Read the thread's loaded-PACK grant KEYS (threads-only Phase B′) — the slugged paths of
     * the loaded `#pack` notes that declare `wants:`. Optional — UNWIRED → no pack keys (the
     * def's `spec.name` grants alone, legacy continuity). `subject` resolves the subject-scoped
     * thread note.
     */
    readPackKeys?: (channel: string, name: string, subject?: string) => Promise<string[]>;
    /**
     * Read the thread's own CONTENT (DESIGN-2026-06-29-thread-content-and-skills.md) — the
     * thread note's authored body as `{ path, content }`, composed BETWEEN the def and the
     * loadout. Optional — UNWIRED / no thread note / blank body → undefined (the prompt is
     * `[self, ...loadout]`, the no-thread-content invariant). `subject` resolves the
     * subject-scoped thread note.
     */
    readThreadContent?: (
      channel: string,
      name: string,
      subject?: string,
    ) => Promise<{ path: string; content: string } | undefined>;
    /** Override the outbound-retry backoff base (ms). Default {@link OUTBOUND_RETRY_BASE_MS}. */
    outboundRetryBaseMs?: number;
  }) {
    this.backend = deps.backend;
    this.writeOutbound = deps.writeOutbound;
    if (deps.writeThread) this.writeThread = deps.writeThread;
    if (deps.writeCallback) this.writeCallback = deps.writeCallback;
    if (deps.onTurnEvent) this.onTurnEvent = deps.onTurnEvent;
    if (deps.readSession) this.readSession = deps.readSession;
    if (deps.clearSession) this.clearSession = deps.clearSession;
    if (deps.readLoadout) this.readLoadout = deps.readLoadout;
    if (deps.readPackKeys) this.readPackKeys = deps.readPackKeys;
    if (deps.readThreadContent) this.readThreadContent = deps.readThreadContent;
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

  /**
   * The THREAD-ID a spec registers under (threads-only Phase B) — the address a
   * `metadata.thread`-routed inbound resolves through {@link byThread}. For the live cast
   * the thread-id ≡ the spec name ≡ the channel (the design's "thread-id ≡ agent-name ≡
   * channel, by construction" — §9), so this is `spec.name`. A future explicit thread record
   * (Phase C) would override this; today it's the name, which keeps the def path unchanged.
   */
  private static threadIdOf(spec: AgentSpec): string {
    return spec.name;
  }

  /**
   * The PER-THREAD serial DRAIN KEY for an inbound message — what {@link queues} +
   * {@link draining} are keyed by. The per-drain-key serial guarantee (class doc lines
   * 13-20) holds for ANY of these: same key → strictly serial; different keys → concurrent.
   *
   * Precedence (threads-only Phase B — DESIGN-2026-06-29-threads-only.md §5):
   *  1. A thread-addressed message (`msg.thread`, from `metadata.thread`) → that thread-id IS
   *     the drain key DIRECTLY. This is the Phase-B simplification: the `multiThreaded && subject`
   *     gate is bypassed — a thread-addressed inbound serializes per-thread independent of
   *     subject/mode (same thread-id → strictly serial; different thread-ids → concurrent, even
   *     across one channel's worker, since each thread-id is its own queue + drain promise).
   *  2. Else a MULTI-threaded agent WITH a subject → `threadKey(spec.name, subject)`
   *     (`<name>--<subject>`), so two subjects of one agent get DISTINCT queues (concurrent),
   *     while two messages of the SAME subject share one queue (strictly serial). This is the
   *     #120 subject-routing path, UNCHANGED (a single-threaded agent's subject is NOT a routing
   *     axis — it coalesces to the bare channel, as before).
   *  3. Else (no thread; OR single-threaded; OR no subject) → the bare CHANNEL. The BACK-COMPAT
   *     path: every live def agent (incl. the steward weave) carries no thread + no subject, so
   *     the key is exactly the channel and the queue/drain behavior is BYTE-IDENTICAL to HEAD.
   *
   * NOTE: a message can only enqueue here when a LIVE handle exists for the channel (enqueue
   * requires byChannel), so the handle resolves the agent name + mode for the subject key. A
   * missing handle (the caller already returns false) defaults to the channel key. The thread-id
   * path (1) does NOT need the handle — the explicit address keys directly.
   */
  private drainKeyFor(channel: string, msg: QueuedMessage): string {
    // 1. Explicit thread-id address → the drain key directly (per-thread serial), gate-free.
    const thread = msg.thread?.trim();
    if (thread) return thread;
    const handle = this.byChannel.get(channel);
    if (!handle) return channel;
    // 2. The #120 subject path — multi-threaded only (a single-threaded agent's subject is
    //    not a routing axis; it coalesces to the bare channel, back-compat).
    const multiThreaded = (handle.spec.mode ?? "single-threaded") === "multi-threaded";
    if (!multiThreaded) return channel;
    const subject = msg.subject?.trim();
    if (!subject) return channel; // 3. No subject → the bare channel.
    return threadKey(handle.spec.name, subject);
  }

  /**
   * Drop EVERY per-thread queue + drain promise belonging to a channel — used on
   * teardown/re-key (deregister, a name moving channels). Because {@link queues} +
   * {@link draining} are now keyed by the per-thread DRAIN KEY (`<channel>` or
   * `<channel-name>--<subject>`), deleting only the bare-channel key would orphan a
   * multi-threaded agent's subject queues. We clear the channel key AND every
   * `<channel-name>--*` subject key whose threadKey is prefixed by the channel's agent name.
   * An in-flight subject drain self-terminates on its next loop (it re-reads byChannel,
   * now empty for that channel); dropping the `draining` entry just stops the map leaking.
   */
  private clearChannelQueues(channel: string): void {
    // The bare-channel key (single-threaded / no-subject path).
    this.queues.delete(channel);
    this.draining.delete(channel);
    // Subject keys are `${spec.name}--${slug(subject)}`. Resolve the agent name for this
    // channel if a handle is still present; else fall back to the channel as the name prefix
    // (covers the common case name===channel). Match any key with that `--`-prefixed form.
    const handle = this.byChannel.get(channel);
    const namePrefix = `${handle?.spec.name ?? channel}--`;
    for (const key of [...this.queues.keys()]) {
      if (key.startsWith(namePrefix)) this.queues.delete(key);
    }
    for (const key of [...this.draining.keys()]) {
      if (key.startsWith(namePrefix)) this.draining.delete(key);
    }
  }

  /** Is a programmatic agent registered for this channel? (the inbound-routing check) */
  hasChannel(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  /** Is a programmatic agent registered under this name? (the mutual-exclusion check) */
  hasName(name: string): boolean {
    return this.nameToChannel.has(name);
  }

  /**
   * Is a LIVE programmatic agent registered for this THREAD-ID? (threads-only Phase B —
   * the thread-address routing check). True when the thread-id resolves to a live channel
   * via {@link byThread}. For the live cast thread-id ≡ channel, so a `metadata.thread:
   * steward` inbound finds the same live agent a `metadata.agent: steward` inbound does.
   */
  hasThread(threadId: string): boolean {
    const channel = this.byThread.get(threadId);
    return channel !== undefined && this.byChannel.has(channel);
  }

  /** The live channel a thread-id resolves to, or undefined (threads-only Phase B). */
  channelForThread(threadId: string): string | undefined {
    const channel = this.byThread.get(threadId);
    return channel !== undefined && this.byChannel.has(channel) ? channel : undefined;
  }

  /**
   * RESOLVE-OR-CREATE a thread for a `metadata.thread`-addressed inbound (threads-only
   * Phase B — DESIGN-2026-06-29-threads-only.md §5/§9). This GENERALIZES the inbound
   * handler's old `channels.get → 401-if-absent` lookup into a path that OWNS a message for
   * a not-yet-instantiated thread instead of dropping it. Returns:
   *
   *  - `"live"`    — a live agent already serves this thread (via {@link byThread} →
   *                  {@link byChannel}); the caller routes/enqueues normally to its channel.
   *  - `"owned"`   — no live agent YET, but the thread is RESOLVABLE (`resolvable` true — a
   *                  thread note / def exists for it). We mark the thread-id EXPECTED (so a
   *                  subsequent {@link queuePending} BUFFERS the inbound, owned + replayed on
   *                  {@link register}) and return `"owned"`. The caller queues-pending under
   *                  the thread-id, never 401/drops. This REUSES the agent#121 buffer pattern,
   *                  generalized from "channel not yet live" to "thread not yet instantiated".
   *  - `"unknown"` — nothing maps to this thread-id (not live, not resolvable). The caller
   *                  behaves EXACTLY as today (the inbound handler's existing 401 / no-route
   *                  semantics — no silent-drop change).
   *
   * BACK-COMPAT: a `metadata.agent`-addressed inbound never reaches here (the handler resolves
   * a live channel for it directly), so the 4 live def agents are untouched.
   *
   * PHASE-C INVARIANT (do not break when wiring the writer): the "owned" path marks the
   * thread-id EXPECTED via {@link expectChannel} (a CHANNEL-keyed set) and the caller buffers
   * via {@link queuePending}`(threadId, …)`; the replay on {@link register} runs
   * `drainPending(channel)`. This relies on `threadId ≡ channel` (true today —
   * {@link threadIdOf} = `spec.name` = the channel). If Phase C introduces a thread-id that
   * DIFFERS from the channel, the buffered inbound must be replayed under the THREAD-ID key on
   * register (generalize `drainPending`), or a thread-addressed pending message would silently
   * never drain. Keep thread-id ≡ channel, or fix the replay key together.
   */
  resolveOrCreateThread(threadId: string, resolvable: boolean): "live" | "owned" | "unknown" {
    if (this.hasThread(threadId)) return "live";
    if (!resolvable) return "unknown";
    // Not yet live, but a thread note / def exists → OWN the message: mark the thread-id
    // expected so queuePending buffers it (replayed when the thread agent registers).
    this.expectChannel(threadId);
    return "owned";
  }

  /**
   * Tear down a thread on a thread-note `status` transition to ARCHIVE (threads-only Phase B
   * — DESIGN-2026-06-29-threads-only.md §5/§9). This is the status-driven replacement for the
   * auto-teardown the def-set diff (`agent-defs.ts`) gave defs for free — which is GONE for
   * NON-def threads (nothing diffs a set of thread notes). When a thread note's `status` goes
   * to archived/done, the surface (or a vault trigger) calls this to converge the daemon:
   *
   *  - DROP every per-thread queue + drain promise for the thread (reusing the thread-key-aware
   *    {@link clearChannelQueues} — the drain key for a thread-addressed thread IS the thread-id,
   *    so the bare-key delete clears exactly this thread's queue. NOTE: a thread-addressed message
   *    uses the thread-id drain key DIRECTLY (drainKeyFor path 1, bypassing the subject axis), so
   *    in Phase B there are no `<threadId>--<subject>` sub-keys to orphan; clearChannelQueues'
   *    prefix-scan is harmless belt-and-suspenders here);
   *  - DROP the thread-id's EXPECTED mark + any buffered pending inbound (so an archived thread
   *    can't strand a buffered message or replay stale ones on a future register);
   *  - DROP the {@link byThread} address entry so a later `metadata.thread` inbound resolves
   *    as `unknown` (not a torn-down thread).
   *
   * Lightweight: a NON-def thread may only be EXPECTED/buffered (never fully registered), so
   * this does NOT require a backend handle. If a live agent IS registered for the thread, its
   * deregister (the def path / explicit removal) tears down the backend handle; archiveThread
   * is the queue/index convergence the status transition drives. Returns whether anything was
   * cleared (false = the thread-id had no live/expected/buffered state).
   */
  archiveThread(threadId: string): boolean {
    const had =
      this.queues.has(threadId) ||
      this.draining.has(threadId) ||
      this.expectedChannels.has(threadId) ||
      this.pending.has(threadId) ||
      this.byThread.has(threadId);
    // clearChannelQueues clears the bare key (= the thread-id drain key for a thread-addressed
    // thread) AND any `<threadId>--*` subject sub-keys.
    this.clearChannelQueues(threadId);
    this.expectedChannels.delete(threadId);
    this.pending.delete(threadId);
    this.byThread.delete(threadId);
    return had;
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
    // NOTE (roles×threads NEXT slice): this reads only the BARE-channel drain key, so a
    // multi-threaded agent whose active work is on subject keys (`name--subject`) reports
    // `idle` here. Acceptable while multi-threaded agents aren't in production; tracked for
    // a /health upgrade before they are (the drain key, not the channel, is the unit of work).
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
      // the entry doesn't leak until that promise happens to settle. Also drop the old
      // channel's EXPECTED mark + any stranded pending buffer — nothing routes there now,
      // so a residual mark/buffer would leak (reviewer nit; defense-in-depth — the normal
      // flow only ever expects the NEW channel before this register).
      // Clear EVERY per-thread queue/drain for the old channel (bare + subject keys), not
      // just the bare-channel key — a multi-threaded agent's subject queues would otherwise
      // leak (roles×threads NEXT slice). clearChannelQueues reads the handle for the subject-key
      // name prefix, so run it BEFORE byChannel.delete while the handle is still present — that
      // resolves the REAL agent name even if name !== channel in a future split (reviewer nit).
      this.clearChannelQueues(priorChannel);
      this.byChannel.delete(priorChannel);
      this.expectedChannels.delete(priorChannel);
      this.pending.delete(priorChannel);
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
    // THREAD-ADDRESS index (threads-only Phase B) — map the spec's thread-id → channel so a
    // `metadata.thread`-routed inbound resolves here. For the live cast thread-id ≡ name ≡
    // channel (so this is `steward → steward`, mirroring nameToChannel) — additive, the def
    // path is unchanged.
    this.byThread.set(ProgrammaticAgentRegistry.threadIdOf(spec), channel);
    // The channel now has a live agent — it's no longer merely "expected" (the gate that
    // let pre-registration inbound queue pending); the live byChannel index is the truth now.
    this.expectedChannels.delete(channel);
    // REPLAY-ON-REGISTER (agent#121): drain any inbound that arrived BEFORE this agent was
    // live — they were buffered in the pending queue (never dropped). Feed them through the
    // NORMAL enqueue path, in arrival order (FIFO), so the queued turns run exactly as if
    // they'd arrived after registration. enqueue() requires the channel to be in byChannel,
    // which it now is. Do this AFTER the indexes are set so enqueue routes correctly.
    this.drainPending(channel);
    return handle;
  }

  /**
   * Mark a channel as EXPECTED to gain a live programmatic agent — the gate that lets an
   * inbound arriving BEFORE registration be QUEUED PENDING instead of dropped (agent#121).
   * The def-instantiation path calls this BEFORE it brings the channel + agent up, so the
   * narrow desync window (channel live, agent not yet registered) buffers rather than loses.
   * Idempotent. {@link register} also marks-then-clears it; {@link unexpectChannel} clears it
   * on teardown.
   */
  expectChannel(channel: string): void {
    this.expectedChannels.add(channel);
  }

  /**
   * Drop a channel's EXPECTED mark + any buffered pending inbound — called on teardown
   * (deregister) of an agent that will NOT come back, so a stale def can't leave inbound
   * stranded in the pending buffer forever. (deregister of a still-expected agent that WILL
   * re-register should NOT call this — only a genuine removal.)
   */
  unexpectChannel(channel: string): void {
    this.expectedChannels.delete(channel);
    this.pending.delete(channel);
  }

  /**
   * QUEUE an inbound that arrived before a live programmatic agent exists for the channel
   * (agent#121). Returns:
   *  - `"queued"`  — the channel is EXPECTED (a def maps here / instantiation in flight); the
   *                  message is buffered (FIFO, capped at {@link PENDING_INBOUND_CAP}) and
   *                  will replay on {@link register}. The daemon now OWNS it (never dropped).
   *  - `"unknown"` — nothing maps to this channel (not expected, not registered): there is
   *                  nothing to deliver to, so the caller logs + drops (still 200 — the vault
   *                  must not retry into a permanent `_pending_at` stall).
   *
   * NOTE: a channel with a LIVE agent never reaches here — {@link enqueue} handles it. This is
   * strictly the pre-registration / desync buffer.
   */
  queuePending(channel: string, msg: QueuedMessage): "queued" | "unknown" {
    if (!this.expectedChannels.has(channel)) return "unknown";
    const queue = this.pending.get(channel) ?? [];
    queue.push(msg);
    // Bounded buffer: past the cap, evict the OLDEST (FIFO) so we keep the most recent
    // context and never grow unbounded. Loud log — a capped pending queue means an agent
    // isn't coming up in time (a real operational signal), and the dropped message is still
    // durable in the vault for the agent to re-read once live.
    if (queue.length > PENDING_INBOUND_CAP) {
      queue.shift();
      console.warn(
        `parachute-agent: pending-inbound queue for channel "${channel}" hit the cap ` +
          `(${PENDING_INBOUND_CAP}) — dropped the oldest buffered message (still durable in ` +
          `the vault). The programmatic agent for this channel is not coming up in time.`,
      );
    }
    this.pending.set(channel, queue);
    return "queued";
  }

  /**
   * Drain a channel's PENDING-INBOUND buffer into the live serial queue — called by
   * {@link register} once the agent is live. FIFO: the oldest pending inbound is enqueued
   * first, so the buffered turns run in arrival order. A no-op when the buffer is empty.
   */
  private drainPending(channel: string): void {
    const buffered = this.pending.get(channel);
    if (!buffered || buffered.length === 0) return;
    this.pending.delete(channel);
    console.log(
      `parachute-agent: replaying ${buffered.length} pending inbound message(s) for ` +
        `channel "${channel}" now that its programmatic agent is registered.`,
    );
    for (const msg of buffered) {
      // enqueue() routes to the serial worker (the channel is now in byChannel). FIFO order
      // is preserved by iterating the buffer oldest-first.
      this.enqueue(channel, msg);
    }
  }

  /** How many inbound are buffered pending for a channel (tests + /health observability). */
  pendingCount(channel: string): number {
    return this.pending.get(channel)?.length ?? 0;
  }

  /** Is a channel currently marked EXPECTED (the pending-queue gate)? (tests) */
  isExpected(channel: string): boolean {
    return this.expectedChannels.has(channel);
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
    // Clear every per-thread queue/drain for this channel (bare + subject keys) BEFORE
    // dropping byChannel, so the handle is still present to resolve the agent-name prefix
    // for the subject keys (roles×threads NEXT slice). An in-flight subject drain
    // self-terminates on its next loop (it re-reads byChannel, now empty for the channel).
    this.clearChannelQueues(channel);
    this.byChannel.delete(channel);
    this.nameToChannel.delete(name);
    // Drop the THREAD-ADDRESS index entry (threads-only Phase B). Resolve the thread-id from
    // the handle's spec when present (it may differ from `name` under a future explicit thread
    // record); fall back to `name` (today thread-id ≡ name). A `metadata.thread`-routed inbound
    // must stop resolving to a torn-down agent.
    this.byThread.delete(handle ? ProgrammaticAgentRegistry.threadIdOf(handle.spec) : name);
    // Clear the EXPECTED mark + any buffered pending inbound for this channel too —
    // the agent is gone, so a pending message has nothing to drain into and would
    // strand forever (and the next register would replay stale messages). The daemon's
    // teardown wrapper also calls unexpectChannel, but clearing it here makes direct
    // registry callers safe too (the reviewer's latent-footgun nit).
    this.expectedChannels.delete(channel);
    this.pending.delete(channel);
    // Tear down the backend handle (the programmatic `stop` is a no-op — there's no
    // process to kill, and the session now lives on the durable thread note, not a
    // backend store). Deregister deliberately does NOT clear the thread-note session:
    // re-registering the same agent should resume its conversation. Wiping continuity is
    // an explicit RESET (`resetSession`), not a side effect of teardown.
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
   * Reset a programmatic agent's conversation — clear the persisted session on its
   * `#agent/thread` note (via the wired `clearSession` → the transport's
   * `clearThreadSession`) so the next message starts a FRESH claude conversation, WITHOUT
   * deregistering it. This is what the per-session restart endpoint maps to for a
   * programmatic agent (the interactive restart's "kill + re-spawn" has no analog — there's
   * no process; continuity is the thread-note session, not a backend store). With the next
   * turn's `readSession` finding no session, it resolves a fresh `--session-id` create.
   * Best-effort: a clear failure is logged, never thrown. Returns whether an agent was
   * registered under that name.
   */
  async resetSession(name: string): Promise<boolean> {
    const handle = this.getByName(name);
    if (!handle) return false;
    try {
      await this.clearSession?.(handle.channel, handle.spec.name);
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
    // PER-THREAD ROUTING (roles×threads NEXT slice, #120): resolve the drain key. A
    // single-threaded / no-subject message keys by the bare CHANNEL (byte-identical to
    // HEAD); a multi-threaded agent WITH a subject keys by `threadKey(name, subject)`, so
    // distinct subjects get distinct queues + distinct drain promises (concurrent), while
    // the SAME subject shares one queue + one promise (strictly serial). The serial
    // guarantee is per DRAIN KEY, not per channel.
    const drainKey = this.drainKeyFor(channel, msg);
    const queue = this.queues.get(drainKey) ?? [];
    queue.push(msg);
    this.queues.set(drainKey, queue);
    // Start the worker if it isn't already running FOR THIS DRAIN KEY. The drain promise's
    // PRESENCE in `draining` (keyed by drain key) is the "a worker is running for this
    // thread" flag — set it synchronously before any await so a second enqueue for the same
    // drain key in the same tick can't start a second worker (the per-thread serial lock).
    // A DIFFERENT drain key has its own entry → its own worker → may run concurrently.
    if (!this.draining.has(drainKey)) {
      const p = this.drain(drainKey, channel).finally(() => {
        this.draining.delete(drainKey);
      });
      this.draining.set(drainKey, p);
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
  private async drain(drainKey: string, channel: string): Promise<void> {
    for (;;) {
      // The FIFO for THIS thread — keyed by the per-thread drain key, NOT the channel. A
      // single-threaded / no-subject thread's drain key IS the channel (back-compat); a
      // subject thread's is `threadKey(name, subject)`. Reading the queue by drain key is
      // what keeps two subjects of one agent independently serial.
      const queue = this.queues.get(drainKey);
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

      // RESOLVE THE SESSION (the thread≡session record — the daemon owns the uuid). A
      // single-threaded agent RESUMES the session persisted on its deterministic thread
      // note (when one exists); the first turn (no prior) and EVERY multi-threaded fire
      // CREATE a fresh session with a new uuid (`--session-id`). The backend just runs the
      // turn with this {@link TurnSession}; it reads no session store.
      const multiThreaded = (handle.spec.mode ?? "single-threaded") === "multi-threaded";
      // The thread SUBJECT (roles×threads NEXT slice, #120) — trimmed; empty → none.
      const turnSubject = msg.subject?.trim() ? msg.subject : undefined;
      // A multi-threaded agent WITH a subject is a NAMED thread: a deterministic note at
      // `Threads/<ch>/<name>--<subject>` that upserts + carries a session across fires
      // (turning "fresh thread per fire" into "resume the named thread"). A multi-threaded
      // agent with NO subject stays fresh-per-fire (HEAD); a single-threaded agent is the
      // HEAD deterministic def-named note.
      const hasSubjectThread = multiThreaded && !!turnSubject;
      // RESUME the persisted session when one exists for this thread note:
      //  - single-threaded → its deterministic def-named note (HEAD behavior, unchanged).
      //  - multi-threaded WITH a subject → the subject-scoped note (NEW: per-thread continuity).
      //  - multi-threaded with NO subject → NEVER resume (each fire is a fresh thread; HEAD).
      // The leaf is resolved transport-side via `singleThreadedPath(channel, name, subject)`,
      // so write + read + clear all agree on the path (no leaf math duplicated here).
      let resumeId: string | undefined;
      if (this.readSession && (!multiThreaded || hasSubjectThread)) {
        resumeId = await this.readSession(handle.channel, handle.spec.name, turnSubject);
      }
      const turnSession: TurnSession = resumeId
        ? { id: resumeId, resume: true }
        : { id: crypto.randomUUID(), resume: false };

      // ── THREAD-AS-CONTAINER (the user's model: definition -> thread -> message). ENSURE
      // the thread note in a `working` state BEFORE the turn runs, so the thread is visible
      // the moment processing starts (status `working` → `ok`/`error`), not only as a
      // by-product of a completed turn. The SAME per-turn thread id ties this start-ensure
      // to the end-record below: single-threaded UPSERTS its deterministic note (and the
      // end-record overwrites it `working` → `ok`/`error`); multi-threaded CREATES the
      // per-fire note (and the end-record updates the SAME note via `turnThreadId`).
      //
      // turn_count is NOT touched here. `phase: "start"` tells the transport to write
      // `turn_count = prior` (UNCHANGED — no turn has completed) and NOT advance
      // `last_turn_at`. The turn is counted EXACTLY ONCE, on the `end` record below — so
      // start+end never double-count. Best-effort: a start-ensure write failure is logged
      // (inside recordThread) and the turn STILL runs — a missing/stale working note must
      // never strand the queue or skip the turn.
      // Capture the start-ensure's WRITTEN thread-note id. For single-threaded this is the
      // DETERMINISTIC `Threads/<safeChannel>/<safeName>` note (the same every turn) — so a
      // resolvable thread id is available BEFORE the turn runs, for the failure-note +
      // outbound `metadata.thread` stamping (agent#163), even on a turn that fails early.
      const startThreadNoteId = await this.recordThread(handle, msg, "working", startedAt, undefined, {
        threadId: turnThreadId,
        phase: "start",
        // NO session on the start-ensure: it runs BEFORE claude, so claude may never
        // establish a session this turn. Persisting `turnSession.id` here would brick the
        // next turn (it'd `--resume` an id for a conversation that never existed →
        // non-transient "No conversation found" → no retry). We persist a session ONLY on
        // the `end` record, and ONLY the id claude actually echoed (FIX 2). For a
        // single-threaded resume turn the prior session is preserved by writeThread anyway.
      });
      // The MODE-CORRECT, RESOLVABLE thread id stamped into outbound + failure notes
      // (agent#163): a DETERMINISTIC thread (single-threaded OR a multi-threaded subject
      // thread) → the deterministic thread-NOTE id (stable across turns); a PER-FIRE thread
      // (multi-threaded, NO subject) → the per-fire `turnThreadId`. `perFire` is multi-threaded
      // AND no subject. Computed once from the start-ensure id so every path (early failure, ok,
      // outbound-failure) stamps the same resolvable link.
      const perFire = multiThreaded && !hasSubjectThread;
      const outThreadId = outboundThreadId(perFire, turnThreadId, startThreadNoteId);

      // RUN CONTEXT (agent#162): assemble the runtime facts a headless `claude -p` turn can't
      // know — the REAL wall-clock (`startedAt`), whether this run CONTINUES a prior session
      // (`turnSession.resume`) or starts fresh, and WHY it fired (a scheduled job vs an
      // interactive/delegated message, from the inbound sender). The backend prepends these as
      // a labeled preamble so the agent stamps ACCURATE times instead of fabricating them.
      // (DEFERRED: `priorTurnCount` — the rolling turn_count lives in the transport's thread
      // note and isn't surfaced back to the drain; wiring it is a follow-up. Until then the
      // preamble omits the `turn=N` line — the `now`/session/fired-by trio is the floor.)
      const firedBy = runFiredBy(msg.sender);
      const runContext: RunContext = {
        now: startedAt,
        session: turnSession.resume ? "resumed" : "new",
        ...(firedBy ? { firedBy } : {}),
      };

      // LOADOUT (threads-only Phase A — DESIGN-2026-06-29-threads-only.md §9): resolve the
      // thread's `metadata.loadout` note paths off its `#agent/thread` note (CONTENT-only,
      // each → a {path, content} entry). The backend prepends the SELF entry (the def body)
      // and composes the arity-N system prompt. Read for EVERY thread (single- and
      // multi-threaded) at its mode-correct note (subject-scoped when a subject narrows the
      // thread; the def-named note otherwise). UNWIRED → empty loadout, so the system prompt
      // is the def body alone (the no-loadout invariant — byte-identical to HEAD apart from
      // the `# <path>` header). Best-effort: a read failure logs + the turn runs with the
      // empty loadout (self entry only), never strands the queue. Missing paths are
      // skipped-and-warned inside the resolver (never throws).
      let loadout: LoadoutEntry[] = [];
      if (this.readLoadout) {
        try {
          loadout = await this.readLoadout(handle.channel, handle.spec.name, turnSubject);
        } catch (err) {
          console.error(
            `parachute-agent: loadout read for channel "${channel}"` +
              (turnSubject ? ` subject "${turnSubject}"` : "") +
              ` failed (turn runs with the def body alone): ${(err as Error).message}`,
          );
        }
      }

      // PACK GRANT KEYS (threads-only Phase B′ — DESIGN-2026-06-29-threads-only.md §4): resolve
      // the loaded-PACK grant keys (the slugged paths of the loaded `#pack` notes declaring
      // `wants:`) off the SAME thread note. The backend UNIONS each pack's APPROVED grants with
      // the def's own (`spec.name`). SEPARATE metadata read from the content-only loadout (so the
      // prompt composition is unchanged). The SECURITY GATE — a non-pack note's `wants:` is
      // ignored — lives in the resolver. UNWIRED / no pack with `wants:` (every current thread)
      // → empty → the grant sources are exactly `[spec.name]` (legacy continuity, byte-identical
      // injection). Best-effort: a read failure logs + the turn injects the def's grants alone.
      let packKeys: string[] = [];
      if (this.readPackKeys) {
        try {
          packKeys = await this.readPackKeys(handle.channel, handle.spec.name, turnSubject);
        } catch (err) {
          console.error(
            `parachute-agent: pack-key read for channel "${channel}"` +
              (turnSubject ? ` subject "${turnSubject}"` : "") +
              ` failed (turn injects the def's grants alone): ${(err as Error).message}`,
          );
        }
      }

      // THREAD CONTENT (DESIGN-2026-06-29-thread-content-and-skills.md): the thread note's own
      // authored body — THIS thread's standing context — read CONTENT-only off its mode-correct
      // `#agent/thread` note (subject-scoped when a subject narrows the thread). The backend
      // composes it BETWEEN the def (self) and the loadout. Undefined (unwired / no thread note /
      // blank body) → the no-thread-content invariant (the prompt is the def + loadout). The
      // daemon NEVER writes this content. Best-effort: a read failure logs + the turn runs without
      // thread content (never strands the queue).
      let threadContent: LoadoutEntry | undefined;
      if (this.readThreadContent) {
        try {
          threadContent = await this.readThreadContent(handle.channel, handle.spec.name, turnSubject);
        } catch (err) {
          console.error(
            `parachute-agent: thread-content read for channel "${channel}"` +
              (turnSubject ? ` subject "${turnSubject}"` : "") +
              ` failed (turn runs without thread content): ${(err as Error).message}`,
          );
        }
      }

      let result;
      try {
        // Forward each interim event to the streaming-view sink (keyed by channel)
        // as the turn runs — the "watch it work" live progress. The sink swallows
        // its own throws (emitTurnEvent), so a dead live stream can't break the turn.
        result = await this.backend.deliver(
          handle.backendHandle,
          msg.content,
          turnSession,
          (e) => this.emitTurnEvent(channel, e),
          // Phase 1: inbound attachments → the programmatic backend stages them into the
          // agent's private workspace so the turn can Read them. Absent/empty → no staging.
          msg.attachments,
          // agent#162: the daemon-known runtime context (real clock, new/resumed, fired-by).
          runContext,
          // threads-only Phase A: the thread's resolved LOADOUT notes (entries 1..N). The
          // backend prepends the SELF entry (the def body) and composes the arity-N system
          // prompt. Empty (unwired / no loadout) → the def body alone (the no-loadout invariant).
          loadout,
          // roles×threads NEXT slice (#120, G): the thread SUBJECT — the backend keys the
          // PER-THREAD private workspace off it (`sessions/<name>--<subject>/`), so concurrent
          // subjects of one agent never clobber each other's per-turn `.mcp.json` /
          // `system-prompt.txt` / HOME. Undefined → `sessions/<name>/` (HEAD, unchanged).
          turnSubject,
          // threads-only Phase B′: the loaded-PACK grant keys — the backend unions each pack's
          // APPROVED grants with the def's own (`spec.name`). Empty (every current thread) →
          // the grant sources are exactly `[spec.name]` (legacy continuity, byte-identical).
          packKeys,
          // thread content (DESIGN-2026-06-29-thread-content-and-skills.md): THIS thread's
          // authored standing context, composed BETWEEN the def and the loadout (def + thread
          // content protected from budget truncation). Undefined / blank → the def + loadout
          // alone (the no-thread-content invariant).
          threadContent,
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
        const threadNoteId = await this.recordThread(handle, msg, "error", startedAt, undefined, {
          threadId: turnThreadId,
          phase: "end",
          // No `result` (the backend threw) → NO session to persist. We never write a
          // session claude didn't echo (FIX 2): persisting an unestablished uuid would
          // brick the next turn's `--resume`. A single-threaded prior session is preserved
          // by writeThread; otherwise the next turn self-heals with a fresh create.
        });
        this.emitTurnEvent(channel, { kind: "error", error: reason });
        // Post a user-facing failure note so the channel shows SOMETHING (not a silent
        // no-reply) — best-effort. Stamp the MODE-CORRECT resolvable thread id (agent#163).
        await this.postFailureNote(channel, msg.inReplyTo, outThreadId, reason);
        // CALLBACK on the failure too — an orchestrator MUST learn its sub-task failed, not
        // hang waiting forever. No outbound note was produced, so no `source_message`; the
        // RESOLVABLE thread-note id (written above) is `source_thread` so the orchestrator can
        // still pull the recipient's thread on a no-reply turn (agent#124).
        await this.maybeDeliverCallback(handle, msg, turnThreadId, "error", undefined, threadNoteId);
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
        const threadNoteId = await this.recordThread(handle, msg, "error", startedAt, undefined, {
          threadId: turnThreadId,
          phase: "end",
          // Persist ONLY the session claude ECHOED (FIX 2). A turn can fail AFTER
          // establishing a session (claude emitted it in the init/result event) → resume
          // it next turn. A turn that failed BEFORE establishing one echoes none →
          // `result.sessionId` is undefined → we persist nothing → the next turn
          // self-heals with a fresh create (no brick). NEVER fall back to `turnSession.id`.
          ...(result.sessionId ? { session: result.sessionId } : {}),
        });
        this.emitTurnEvent(channel, { kind: "error", error: result.error });
        // Post a user-facing failure note so the channel shows SOMETHING (not a silent
        // no-reply) — best-effort. Stamp the MODE-CORRECT resolvable thread id (agent#163).
        await this.postFailureNote(channel, msg.inReplyTo, outThreadId, result.error);
        // CALLBACK on the failure-as-value too (status:error) — the orchestrator learns the
        // sub-task failed and can react. No delivered reply, so no `source_message`; the
        // RESOLVABLE thread-note id (written above) is `source_thread` (agent#124).
        await this.maybeDeliverCallback(handle, msg, turnThreadId, "error", undefined, threadNoteId);
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
      // Capture the WRITTEN thread-note id — the RESOLVABLE `source_thread` for the callback
      // (agent#124). The same note id is reused for the outbound-failure re-record below
      // (sameTurn → same note), so a callback on either terminal path points at a pullable
      // thread record.
      let threadNoteId = await this.recordThread(handle, msg, "ok", startedAt, result.usage, {
        threadId: turnThreadId,
        phase: "end",
        // Persist the session claude ECHOED (FIX 2) so the next turn `--resume`s this
        // conversation — the thread≡session record. A successful turn always echoes an id;
        // the guard keeps the "only an established session" invariant uniform.
        ...(result.sessionId ? { session: result.sessionId } : {}),
      });

      // The outbound reply — the channel-transcript delivery (the chat bubble). It is
      // ADDITIVE to the primary thread-note record already written above (for BOTH modes).
      // Empty reply → NO note (reviewer contract — `reply` can be ""): a turn that produced
      // no text (e.g. tool-only work) leaves the chat clean.
      //
      // `sourceMessage` — the delivered outbound note id, captured for the callback's
      // `source_message` so an orchestrator can PULL the full reply text. Stays undefined
      // for an empty/tool-only turn (no note) — the callback still fires (status:ok), it
      // just has no reply note to point at (the orchestrator pulls from `source_thread`).
      let sourceMessage: string | undefined;
      if (result.reply && result.reply.length > 0) {
        const delivered = await this.deliverOutboundWithRetry(
          channel,
          result.reply,
          msg.inReplyTo,
          // agent#163: stamp the MODE-CORRECT, RESOLVABLE thread id into the outbound note's
          // `metadata.thread` — single-threaded → the deterministic thread-NOTE id (stable
          // across turns; an observer resolves the ONE thread), multi-threaded → the per-fire
          // id. NOT the per-turn correlation UUID (the pre-#163 bug that looked like a fresh
          // session every run).
          outThreadId,
        );
        if (delivered.ok) sourceMessage = delivered.noteId;
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
          // We do NOT re-run the `claude -p` turn (that forks/burns quota). The reply text is
          // not persisted (the transcript write is what failed, and the daemon no longer writes
          // the thread body) — the turn is recorded `status:error` so the failure is visible and
          // the `error` turn-event carries the "reply produced but not saved" reason.
          console.error(
            `parachute-agent: programmatic outbound write for channel "${channel}" failed ` +
              `after ${OUTBOUND_MAX_RETRIES} retries: ${delivered.error}`,
          );
          // RE-RECORD the SAME turn as status:error — reuse the per-turn thread id +
          // `sameTurn` so this updates the note the `ok` record above just wrote (one
          // note, no turn_count double-count) rather than minting a duplicate / advancing
          // the count (the FIX-1 re-record bug the reviewer caught).
          // Re-record returns the SAME note's id (sameTurn upsert / same per-fire note) — use
          // it as the callback `source_thread` (agent#124), falling back to the ok-record id.
          threadNoteId = (await this.recordThread(
            handle,
            msg,
            "error",
            startedAt,
            result.usage,
            {
              threadId: turnThreadId,
              sameTurn: true,
              phase: "end",
              // The turn DID establish a session (it produced a reply) — keep the ECHOED id
              // on the note so the next turn resumes, even though the outbound transcript
              // write failed. Only claude's echoed id (FIX 2), never the passed uuid.
              ...(result.sessionId ? { session: result.sessionId } : {}),
            },
          )) ?? threadNoteId;
          this.emitTurnEvent(channel, {
            kind: "error",
            error: `reply produced but not saved: ${delivered.error}`,
          });
          // CALLBACK as status:error — the reply was produced but NOT delivered, so the
          // turn did not truly succeed; the orchestrator must learn that. No `source_message`
          // (the outbound note never landed); the undelivered text lives in the error thread
          // note for an operator to recover — pull it via the RESOLVABLE `source_thread`.
          await this.maybeDeliverCallback(handle, msg, turnThreadId, "error", undefined, threadNoteId);
          continue;
        }
      }

      // Resolve the live view: `done` carries the final reply text (empty when the
      // turn produced none) so the UI finalizes the in-progress bubble — the durable
      // note (written above) is what actually persists; this just ends the spinner.
      // Reached only when the outbound write SUCCEEDED, or there was no reply to write
      // (empty/tool-only turn → clean resolve, no note expected).
      this.emitTurnEvent(channel, { kind: "done", reply: result.reply ?? "" });
      // CALLBACK on success — the turn finished cleanly (status:ok). `sourceMessage` is the
      // delivered reply note (when there was one) the orchestrator pulls the full result from;
      // `source_thread` (the WRITTEN thread-note id, agent#124) is the RESOLVABLE pull-link in
      // both modes, including an empty/tool-only turn where there's no `sourceMessage`.
      await this.maybeDeliverCallback(handle, msg, turnThreadId, "ok", sourceMessage, threadNoteId);
    }
  }

  /**
   * Deliver an agent-to-agent CALLBACK to the originating channel when a requested turn
   * finishes — the request/response substrate ("reply_to"). Called at EVERY terminal point
   * of the drain (success, failure-as-value, defensive-catch throw, AND outbound-delivery
   * failure), because an orchestrator must learn the outcome whether the sub-task succeeded
   * OR failed — a hung orchestrator waiting on a dropped failure is the worst outcome.
   *
   * GUARDS (in order; each is a hard precondition — failing any one is a clean no-op):
   *  1. No {@link WriteCallback} wired → reply_to is inert (a daemon with no vault channels).
   *  2. No `replyTo` on the originating message → an ordinary, non-orchestrated turn. This
   *     is THE common case + the first loop guard: a CALLBACK note is written WITHOUT a
   *     `reply_to` (see the daemon's wiring), so handling a callback can NEVER itself emit a
   *     callback — no ping-pong, structurally.
   *  3. `delegationDepth >= MAX_DELEGATION_DEPTH` → the DEPTH loop guard. Even if guard 2
   *     were somehow defeated, this bounds any chain to a finite hop count. We LOG loudly
   *     (a hit is a real signal — a delegation tree ran away or a cycle formed) and drop the
   *     callback. The turn itself already ran + recorded; only the onward notification stops.
   *
   * The callback CONTENT is a brief NOTIFICATION + a LINK (never the duplicated reply) — the
   * orchestrator reads `source_thread`/`source_message` off the metadata and PULLS the full
   * result (the user's explicit choice). METADATA is the {@link CallbackMeta} contract, with
   * `delegation_depth` = incoming + 1 so the chain's depth climbs each hop.
   *
   * Best-effort like the other sinks: a write failure is LOGGED, never thrown — a callback
   * failure must NOT strand the per-channel drain or re-run the (already-completed) turn.
   */
  private async maybeDeliverCallback(
    handle: ProgrammaticAgentHandle,
    msg: QueuedMessage,
    turnThreadId: string,
    status: "ok" | "error",
    sourceMessage?: string,
    sourceThreadId?: string,
  ): Promise<void> {
    // Guard 1 + 2: no sink, or this wasn't a delegated request → nothing to call back.
    if (!this.writeCallback) return;
    if (!msg.replyTo) return;

    // Guard 3 (DEPTH): bound the delegation chain. The INCOMING depth (default 0) is how
    // deep this message already is; the callback we'd write is one hop deeper. If the
    // incoming message is already at/over the ceiling, stop — do not deliver.
    const incomingDepth = msg.delegationDepth ?? 0;
    if (incomingDepth >= MAX_DELEGATION_DEPTH) {
      console.warn(
        `parachute-agent: delegation depth ${incomingDepth} >= MAX (${MAX_DELEGATION_DEPTH}) for ` +
          `channel "${handle.channel}" → NOT delivering a callback to "${msg.replyTo}" (loop guard). ` +
          `A delegation chain ran away or a cycle formed; the turn ran + recorded normally.`,
      );
      return;
    }

    // The brief notification + link. NOT the full reply (the orchestrator pulls it).
    const verb = status === "ok" ? "finished (ok)" : "finished with an error";
    const content =
      `[callback] ${handle.channel} ${verb} — see source_message / source_thread in this ` +
      `note's metadata to pull the full result.`;

    // The metadata contract. delegation_depth = incoming + 1 (this hop). correlation_id +
    // source_message are echoed/included only when present. The daemon's WriteCallback
    // wiring writes this as a `#agent/message/inbound` note to `msg.replyTo` and — CRUCIALLY
    // — does NOT stamp a `reply_to` on it (the terminal-callback loop guard).
    //
    // `source_thread` is the WRITTEN thread-note id (agent#124) — RESOLVABLE for BOTH modes
    // (`query-notes { id: source_thread }`), available even on an error/empty/tool-only turn
    // (the thread note is written before the outbound). Fall back to the per-turn id only when
    // the thread seam surfaced none (no durable store / a write failure) — still a stable
    // provenance token, just not a pullable note.
    const meta: CallbackMeta = {
      callback: "true",
      status,
      source_channel: handle.channel,
      source_thread: sourceThreadId ?? turnThreadId,
      ...(sourceMessage ? { source_message: sourceMessage } : {}),
      ...(msg.correlationId ? { correlation_id: msg.correlationId } : {}),
      delegation_depth: String(incomingDepth + 1),
    };

    try {
      await this.writeCallback(msg.replyTo, content, meta);
    } catch (err) {
      console.error(
        `parachute-agent: delivering callback to channel "${msg.replyTo}" failed ` +
          `(continuing — the turn already completed + recorded): ${(err as Error).message}`,
      );
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
   *
   * RETURNS the WRITTEN thread-note id so the drain can use it as a RESOLVABLE
   * `source_thread` on the agent-to-agent callback (agent#124), for BOTH modes. `undefined`
   * when no sink is wired, the write failed, or the seam surfaced no id — the drain then
   * falls back to the per-turn id.
   */
  private async recordThread(
    handle: ProgrammaticAgentHandle,
    msg: QueuedMessage,
    status: "ok" | "error" | "working",
    startedAt: string,
    usage: ThreadNote["usage"],
    opts: { threadId?: string; sameTurn?: boolean; phase?: "start" | "end"; session?: string } = {},
  ): Promise<string | undefined> {
    if (!this.writeThread) return undefined;
    const thread: ThreadNote = {
      channel: handle.channel,
      name: handle.spec.name,
      // roles×threads NEXT slice (#120): carry the thread SUBJECT so the transport can
      // resolve a subject-scoped deterministic thread note (`Threads/<ch>/<name>--<subject>`)
      // that UPSERTS + carries a session across fires (per-thread continuity) instead of a
      // per-fire uuid note. Absent/empty → no subject → today's identity (single-threaded
      // deterministic note, or multi-threaded per-fire note) is byte-identical to HEAD.
      ...(msg.subject?.trim() ? { subject: msg.subject } : {}),
      ...(handle.spec.definition ? { definition: handle.spec.definition } : {}),
      mode: handle.spec.mode ?? "single-threaded",
      status,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      ...(usage ? { usage } : {}),
      // The Claude session UUID for this turn — persisted to the thread note so the next
      // turn `--resume`s it (the thread≡session record). The transport preserves a prior
      // single-threaded session when a write carries none.
      ...(opts.session ? { session: opts.session } : {}),
      // The per-turn thread id (stable across an ok→error re-record) + the same-turn flag,
      // so a re-record updates the SAME note without minting a duplicate (multi) or
      // double-counting turn_count (single).
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
      ...(opts.sameTurn ? { sameTurn: true } : {}),
      // The lifecycle phase — `start` (working-ensure, no turn counted) vs `end` (final
      // record, turn counted). Absent → `end` at the transport (back-compat).
      ...(opts.phase ? { phase: opts.phase } : {}),
    };
    try {
      // The seam returns the WRITTEN note id (`{ id }`) for a durable transport; `void` for
      // one with no store. Surface it so the drain can set a RESOLVABLE callback
      // `source_thread` (agent#124). A missing id → undefined → the drain falls back to the
      // per-turn id.
      const written = await this.writeThread(thread);
      return written?.id;
    } catch (err) {
      console.error(
        `parachute-agent: writing #agent/thread note for channel "${handle.channel}" failed ` +
          `(continuing): ${(err as Error).message}`,
      );
      return undefined;
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
    threadId?: string,
  ): Promise<{ ok: true; noteId?: string } | { ok: false; error: string }> {
    let lastError = "";
    for (let attempt = 0; attempt <= OUTBOUND_MAX_RETRIES; attempt++) {
      try {
        // Capture the written note id (when the seam returns one) so the caller can
        // point a callback's `source_message` at the delivered reply. A void return →
        // no id (the callback then omits source_message — still fires).
        const written = await this.writeOutbound(channel, reply, inReplyTo, threadId);
        return { ok: true, ...(written && written.id ? { noteId: written.id } : {}) };
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

  /**
   * Post a brief, user-facing FAILURE note to the channel when a turn doesn't complete
   * (the backend's transient-retry is exhausted, or a non-transient error). A silent
   * no-reply reads as "nothing came through" — this makes the failure visible in the
   * transcript, with the reason. Best-effort: a failed failure-note write is logged,
   * never thrown (it must not break the drain). Reuses the bounded outbound-write retry.
   */
  private async postFailureNote(
    channel: string,
    inReplyTo: string | undefined,
    threadId: string,
    reason: string,
  ): Promise<void> {
    const short = reason.length > 240 ? `${reason.slice(0, 240)}…` : reason;
    const text =
      `⚠️ I couldn't complete that — the turn failed: ${short}\n\n` +
      `This is often temporary; please try again in a moment.`;
    try {
      const delivered = await this.deliverOutboundWithRetry(channel, text, inReplyTo, threadId);
      if (!delivered.ok) {
        console.error(
          `parachute-agent: failure note for channel "${channel}" not delivered: ${delivered.error}`,
        );
      }
    } catch (err) {
      console.error(
        `parachute-agent: posting failure note for channel "${channel}" threw (continuing): ${(err as Error).message}`,
      );
    }
  }
}
