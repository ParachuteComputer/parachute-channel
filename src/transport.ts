/**
 * Transport abstraction for parachute-agent.
 *
 * A Transport is one messaging backend (Telegram today, http-ui / vault later).
 * The daemon core — channel registry, routing, SSE fan-out, permission relay —
 * is transport-agnostic and talks to every backend through this interface.
 *
 * Addressing that is specific to a backend (Telegram chat_id, message_id as
 * Telegram ints, etc.) travels inside `meta`. Keep `meta` as the escape hatch
 * so a non-Telegram transport never has to invent Telegram fields.
 */

import type { AgentMode } from "./sandbox/types.ts";

/** An inbound message, routed by the daemon to the bridges subscribed to `channel`. */
export interface InboundMessage {
  /** The named channel this message arrived on. */
  channel: string;
  /** The human-readable body the session sees. */
  content: string;
  /** Backend-specific addressing + provenance (chat_id, message_id, user, …). */
  meta: Record<string, string>;
  /** The transport kind that produced this message (e.g. "telegram"). */
  source: string;
}

export interface ReplyArgs {
  channel: string;
  text?: string;
  files?: string[];
  reply_to?: string;
  meta?: Record<string, string>;
}

/**
 * One turn's input to materializing a `#agent/thread` note — the UNIFIED model
 * (`definition -> thread -> message`). BOTH execution-lifecycle modes materialize a thread
 * note (the structural unification: everything is a thread; a "run" was always a thread
 * with one turn). The transport that backs the channel persists this; only the
 * VaultTransport implements it (a `#agent/thread` note) — other transports omit the
 * optional method.
 *
 * MODE difference (resolved transport-side): `single-threaded` upserts ONE thread note per
 * channel at a deterministic path named after the def and rolls up turn_count + usage;
 * `multi-threaded` writes one thread note PER FIRE. The carrier shape is the same.
 */
export interface ThreadRecord {
  /** The channel the turn ran on. */
  channel: string;
  /**
   * The agent/def name — the single-threaded thread is "named after the definition": this
   * sanitizes to the deterministic path leaf so the one-per-channel note upserts in place.
   * Omitted falls back to the channel (the 1:1 default, where channel == name).
   */
  name?: string;
  /** The `#agent/definition` note id this thread came from (provenance; plain id string). */
  definition?: string;
  /** The mode the turn ran under — governs thread identity + whether the note upserts. */
  mode: AgentMode;
  /**
   * Outcome / lifecycle state of the thread after THIS write:
   *  - `working` — the turn has STARTED but not finished (the thread-as-container
   *    start-ensure, written BEFORE `deliver()`): the input is shown, NO reply yet.
   *    Only valid with `phase: "start"`.
   *  - `ok` — the turn finished successfully (the reply landed in `output`).
   *  - `error` — the turn failed (the reason is in `output`).
   */
  status: "ok" | "error" | "working";
  /** The inbound text the turn was handed (the `-p` prompt). */
  input: string;
  /** The reply text on success, the failure reason on error, or "" while `working`. */
  output: string;
  /** ISO timestamp the turn started (single-threaded preserves the FIRST turn's). */
  started_at: string;
  /** ISO timestamp the turn ended (becomes the thread's `last_turn_at`; not advanced on a start-ensure). */
  ended_at: string;
  /**
   * The LIFECYCLE PHASE of this write — the thread-as-container model (`definition ->
   * thread -> message`):
   *  - `"start"` — the WORKING-ENSURE, written BEFORE the turn runs. The thread note is
   *    materialized in a `working` state (input shown, no reply). It does NOT count a
   *    turn — single-threaded writes `turn_count = prior` (UNCHANGED) and does NOT
   *    advance `last_turn_at` (no turn completed yet). Idempotent-upsert for
   *    single-threaded; CREATE for multi-threaded (the per-fire note).
   *  - `"end"` (DEFAULT when absent — back-compat) — the FINAL record, written AFTER the
   *    turn. Single-threaded increments `turn_count` (unless `sameTurn`) and advances
   *    `last_turn_at`; this is exactly the pre-thread-as-container behavior.
   * So `turn_count` is counted EXACTLY ONCE per turn, on the `end` write — never
   * double-counted across the start+end pair.
   */
  phase?: "start" | "end";
  /** Optional token/cost usage for this turn (single-threaded accumulates into the note). */
  usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number };
  /**
   * The Claude session UUID to persist on this thread note (`metadata.session`) — the
   * UNIFIED thread≡session record (the daemon owns the uuid; the note is its single
   * source of truth). The registry passes the turn's session id here so the NEXT turn
   * can `--resume` it (read back via {@link VaultTransport.readThreadSession}). Absent
   * on a write that carries no session (e.g. a start-phase working-ensure) — a
   * single-threaded upsert PRESERVES the prior note's session in that case.
   */
  session?: string;
  /**
   * MULTI-threaded only: a stable per-TURN thread id (the note's path leaf). Passing the
   * SAME id on a re-record (e.g. flipping `ok`→`error` after an outbound-delivery failure)
   * makes both writes hit the SAME per-fire note instead of minting a duplicate. Absent →
   * a fresh id is minted. Single-threaded ignores it (its leaf is the deterministic name).
   */
  threadId?: string;
  /**
   * Re-record of the SAME turn (not a new turn). Single-threaded keeps the existing
   * `turn_count` instead of incrementing (the turn was already counted by the first
   * record). No effect on multi-threaded (turn_count is always 1).
   */
  sameTurn?: boolean;
}

/**
 * The METADATA a callback inbound note carries (the agent-to-agent "reply_to" substrate).
 * Mirrors `CallbackMeta` in backends/registry.ts; kept local here so the transport layer
 * doesn't import the backend layer (the registry already keeps a local copy of the thread
 * note shape for the same reason). All string-valued — the vault stores metadata as strings.
 *
 * IMPORTANT: a callback note carries `callback:"true"` + status + the source links, but NEVER
 * a `reply_to` — a callback is terminal, which is the structural loop guard.
 */
export interface CallbackMetadata {
  callback: "true";
  status: "ok" | "error";
  source_channel: string;
  source_thread: string;
  source_message?: string;
  correlation_id?: string;
  delegation_depth: string;
}

export interface ReactArgs {
  channel: string;
  message_id: string;
  emoji: string;
  meta?: Record<string, string>;
}

export interface EditArgs {
  channel: string;
  message_id: string;
  text: string;
  meta?: Record<string, string>;
}

export interface PermissionArgs {
  channel: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

export interface DownloadArgs {
  channel: string;
  file_id: string;
}

/**
 * The daemon hands each transport a context bound to that transport's channel.
 * The transport calls back into it to route inbound traffic.
 */
export interface TransportContext {
  /** The channel name this transport instance is bound to. */
  channel: string;
  /** Route an inbound message to the bridges subscribed to this channel. */
  emit(msg: InboundMessage): void;
  /** Route a permission verdict (from the transport's UI) back to subscribers. */
  emitPermissionVerdict(v: { request_id: string; behavior: string }): void;
}

/**
 * Thrown by a transport for an operator-configuration problem (a 4xx-class
 * fault: e.g. no allowlisted users to prompt), as opposed to a runtime failure.
 * The daemon maps this to HTTP 400 so callers can distinguish "fix your config"
 * from "the server broke".
 */
export class ChannelConfigError extends Error {}

export interface Transport {
  /** Stable identifier for the transport kind, e.g. "telegram". */
  readonly kind: string;
  /** Begin receiving inbound traffic; wire up `ctx.emit`. */
  start(ctx: TransportContext): Promise<void>;
  /** Stop receiving and release resources. */
  stop(): Promise<void>;
  /** Send an outbound message. Required for every transport. */
  reply(args: ReplyArgs): Promise<{ sent: string[] }>;
  /** Optional: add an emoji reaction. */
  react?(args: ReactArgs): Promise<void>;
  /** Optional: edit a previously sent message. */
  edit?(args: EditArgs): Promise<void>;
  /** Optional: surface a permission prompt with allow/deny affordances. */
  sendPermission?(args: PermissionArgs): Promise<{ sent: string[] }>;
  /** Optional: fetch an attachment, returning a local path. */
  download?(args: DownloadArgs): Promise<{ path: string }>;
  /**
   * Optional: materialize a `#agent/thread` note for a completed turn (the VaultTransport's
   * `#agent/thread` note). Only meaningful for a vault-backed channel; transports without a
   * durable store omit it. The daemon calls it for BOTH execution-lifecycle modes (the
   * structural unification — every turn materializes a thread note): single-threaded upserts
   * one note per channel, multi-threaded writes one per fire. Returns the written note id(s).
   */
  writeThread?(thread: ThreadRecord): Promise<{ sent: string[] }>;
  /**
   * Optional: read the persisted Claude session UUID for a single-threaded agent's
   * deterministic `#agent/thread` note (the thread≡session record), or undefined when
   * none yet (the first turn). The daemon reads this BEFORE a turn so it can `--resume`
   * the prior conversation. Only a durable transport (the VaultTransport) implements it;
   * transports without a durable thread store (telegram) omit it.
   */
  readThreadSession?(channel: string, name: string): Promise<string | undefined>;
  /**
   * Optional: write an agent-to-agent CALLBACK as an INBOUND note on THIS channel (the
   * "reply_to" substrate). A recipient agent's drain, on turn completion, calls this on the
   * SENDER's channel transport to wake the sender with a completion notification. The note
   * carries the inbound tags (so the vault trigger wakes the sender through the normal path)
   * PLUS the {@link CallbackMetadata} contract — BUT it must NOT carry a `reply_to` (a
   * callback is terminal; that is the loop guard). Only a durable transport (the
   * VaultTransport) implements it; others omit it. Returns the written note id(s).
   */
  writeCallback?(content: string, meta: CallbackMetadata): Promise<{ sent: string[] }>;
  /**
   * Optional: handle an HTTP request the daemon didn't handle itself. The
   * daemon owns `Bun.serve`; a transport that needs to contribute routes (e.g.
   * http-ui's per-channel send + SSE endpoints) implements this. Return a
   * Response if this transport owns the path, or null to pass it on. Called
   * after the daemon's built-in routes and before the final 404.
   */
  ingestHttp?(req: Request, url: URL): Promise<Response | null>;
}
