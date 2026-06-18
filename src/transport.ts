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
 * The durable record of ONE `one-shot` agent turn (the execution-lifecycle taxonomy).
 * A one-shot turn has no resumed transcript to be its record, so the daemon writes a
 * run note instead. (A `resident` turn writes NONE — the channel transcript is its
 * record.) The transport that backs the channel persists this; only the VaultTransport
 * implements it (a `#agent/run` note) — other transports omit the optional method.
 */
export interface RunRecord {
  /** The channel the turn ran on. */
  channel: string;
  /** The `#agent/definition` note id this run came from (provenance; plain id string). */
  definition?: string;
  /** The mode the turn ran under (always `one-shot` for a run note today). */
  mode: string;
  /** Outcome — `ok` (success) or `error` (the turn failed). */
  status: "ok" | "error";
  /** The inbound text the turn was handed (the `-p` prompt). */
  input: string;
  /** The reply text on success, or the failure reason on error. */
  output: string;
  /** ISO timestamp the turn started. */
  started_at: string;
  /** ISO timestamp the turn ended. */
  ended_at: string;
  /** Optional token/cost usage for observability (serialized into the note metadata). */
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
   * Optional: write the durable record of a completed `one-shot` turn (an
   * `#agent/run` note for the VaultTransport). Only meaningful for a vault-backed
   * channel; transports without a durable store omit it. The daemon calls it ONLY for
   * one-shot turns (a resident turn's record is its channel transcript). Returns the
   * written record's id(s).
   */
  writeRun?(run: RunRecord): Promise<{ sent: string[] }>;
  /**
   * Optional: handle an HTTP request the daemon didn't handle itself. The
   * daemon owns `Bun.serve`; a transport that needs to contribute routes (e.g.
   * http-ui's per-channel send + SSE endpoints) implements this. Return a
   * Response if this transport owns the path, or null to pass it on. Called
   * after the daemon's built-in routes and before the final 404.
   */
  ingestHttp?(req: Request, url: URL): Promise<Response | null>;
}
