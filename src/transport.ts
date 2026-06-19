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
  /** Outcome of THIS turn — `ok` (success) or `error` (the turn failed). */
  status: "ok" | "error";
  /** The inbound text the turn was handed (the `-p` prompt). */
  input: string;
  /** The reply text on success, or the failure reason on error. */
  output: string;
  /** ISO timestamp the turn started (single-threaded preserves the FIRST turn's). */
  started_at: string;
  /** ISO timestamp the turn ended (becomes the thread's `last_turn_at`). */
  ended_at: string;
  /** Optional token/cost usage for this turn (single-threaded accumulates into the note). */
  usage?: { inputTokens?: number; outputTokens?: number; totalCostUsd?: number };
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
   * Optional: handle an HTTP request the daemon didn't handle itself. The
   * daemon owns `Bun.serve`; a transport that needs to contribute routes (e.g.
   * http-ui's per-channel send + SSE endpoints) implements this. Return a
   * Response if this transport owns the path, or null to pass it on. Called
   * after the daemon's built-in routes and before the final 404.
   */
  ingestHttp?(req: Request, url: URL): Promise<Response | null>;
}
