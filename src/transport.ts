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

import type { AgentMode, AgentBackendKind } from "./sandbox/types.ts";

/**
 * A reference to a file attached to an inbound message (Phase 1: inbound file
 * attachments → the programmatic turn). The vault transport surfaces these from
 * an `#agent/message/inbound` note's attachments; the programmatic backend stages
 * the bytes into the agent's private session workspace so a `claude -p` turn can
 * `Read` them. Structured (not flattened into `meta`, which is string-only) so the
 * list rides cleanly transport → daemon → backend.
 */
export interface InboundAttachment {
  /**
   * The vault-internal storage path (e.g. `2026-06-24/<uuid>.png`), relative to the
   * vault's assets dir. The bytes are fetched via `GET <vaultUrl>/vault/<name>/api/storage/<path>`.
   * UNTRUSTED (vault data) — the backend sanitizes the staged filename, never the path.
   */
  path: string;
  /** The MIME type (e.g. `image/png`) — surfaced to the turn so it knows the file kind. */
  mimeType: string;
  /** The basename of `path` (a display/staging hint). UNTRUSTED — the backend re-sanitizes. */
  filename: string;
}

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
  /**
   * Files attached to this inbound message, if any (Phase 1). The programmatic
   * backend stages each into the agent's private session workspace so the turn can
   * read it. Absent/empty → no attachments (today's behavior unchanged).
   */
  attachments?: InboundAttachment[];
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
  /**
   * The thread SUBJECT (roles×threads NEXT slice, #120). When present on a MULTI-threaded
   * thread, the note becomes a DETERMINISTIC, upserting record at `threadKey(name, subject)`
   * (`Threads/<safeChannel>/<safeName>--<safeSubject>`) — rolling turn_count + cumulative
   * usage + a preserved session across fires (per-thread continuity), exactly like the
   * single-threaded deterministic path but at the subject-scoped leaf. Absent/empty → the
   * HEAD identity (single-threaded deterministic note / multi-threaded per-fire uuid note).
   */
  subject?: string;
  /** The `#agent/definition` note id this thread came from (provenance; plain id string). */
  definition?: string;
  /** The mode the turn ran under — governs thread identity + whether the note upserts. */
  mode: AgentMode;
  /**
   * The thread's CONFIG (the flattened model — DESIGN-2026-06-29-threads-roles-context.md
   * Phase 3): the resolved `model` / `backend` for the turn, so the thread note SELF-CARRIES
   * its config and the `#agent/definition` is no longer needed for it. The transport stamps
   * these onto `metadata.model` / `metadata.backend` with WRITE-IF-ABSENT semantics — a
   * deterministic thread PRESERVES an existing value (an operator's or the migration's
   * thread-set config wins; the def value only SEEDS a thread that has none yet), exactly
   * like `started_at` / `session`. Absent (a transport that doesn't resolve config, or a
   * record that carries none) → the keys aren't written (byte-identical to before Phase 3).
   * `status` is DELIBERATELY NOT carried here: the thread's `metadata.status` already means
   * the TURN OUTCOME (`ok`/`error`/`working`); the def's enabled/pending/error status is a
   * discovery-state field that moves to the thread in Phase 4 (with discovery/routing),
   * owned by `agent-defs.ts`, under a distinct key — never overloading the turn status.
   */
  model?: string;
  /** The thread's resolved backend (see {@link model}). Stamped onto `metadata.backend`, write-if-absent. */
  backend?: AgentBackendKind;
  /**
   * Outcome / lifecycle state of the thread after THIS write:
   *  - `working` — the turn has STARTED but not finished (the thread-as-container
   *    start-ensure, written BEFORE `deliver()`). Only valid with `phase: "start"`.
   *  - `ok` — the turn finished successfully.
   *  - `error` — the turn failed.
   * This is a METADATA field; the turn's text (prompt + reply) lives in the `#agent/message`
   * transcript notes, NOT the thread body (the daemon never writes the thread content —
   * DESIGN-2026-06-29-thread-content-and-skills.md).
   */
  status: "ok" | "error" | "working";
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
   * Optional: read the persisted Claude session UUID for a thread's deterministic
   * `#agent/thread` note (the thread≡session record), or undefined when none yet (the
   * first turn). The daemon reads this BEFORE a turn so it can `--resume` the prior
   * conversation. `subject` (roles×threads NEXT slice, #120) resolves the SUBJECT-scoped
   * note (`Threads/<ch>/<name>--<subject>`) for a multi-threaded subject thread; omitted →
   * the def-named note (single-threaded resume, HEAD). Only a durable transport (the
   * VaultTransport) implements it; transports without a durable thread store (telegram) omit it.
   */
  readThreadSession?(channel: string, name: string, subject?: string): Promise<string | undefined>;
  /**
   * Optional: read the thread's CONFIG (the flattened model — Phase 3): the resolved
   * `model` / `backend` carried on the thread's `#agent/thread` note (`metadata.model` /
   * `metadata.backend`). The daemon reads this BEFORE a turn so config resolves THREAD-FIRST
   * (the thread's own value wins), falling back to the def for any field the thread doesn't
   * carry — the transition-safe path to retiring `#agent/definition` for config. `subject`
   * resolves the subject-scoped note; omitted → the def-named note (HEAD). Returns the fields
   * the note carries (each absent when the note doesn't have it / there's no thread note yet).
   * Only a durable transport (the VaultTransport) implements it; transports without a durable
   * thread store omit it → the daemon falls back to the def config entirely (today's behavior).
   */
  readThreadConfig?(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ model?: string; backend?: AgentBackendKind }>;
  /**
   * Optional: CLEAR the persisted session on a thread's `#agent/thread` note so its next
   * turn starts a fresh Claude conversation (the per-agent restart / reset). `subject`
   * resolves the subject-scoped note; omitted → the def-named note (HEAD). Only a durable
   * transport (the VaultTransport) implements it; transports without a durable thread store
   * (telegram) omit it.
   */
  clearThreadSession?(channel: string, name: string, subject?: string): Promise<void>;
  /**
   * Optional: read the thread's own CONTENT — its per-thread standing context
   * (DESIGN-2026-06-29-thread-content-and-skills.md). The thread note's authored BODY (CONTENT
   * only — NEVER metadata, as `{ path, content }`) becomes the prompt entry BETWEEN the def and
   * the loadout. `subject` resolves the subject-scoped note; omitted → the def-named note (HEAD).
   * Returns `undefined` when there is no thread note yet OR the body is blank/whitespace (the
   * no-thread-content case — the prompt stays `[self, ...loadout]`). The daemon NEVER writes this
   * content; a human/agent authors it. Only a durable transport (the VaultTransport) implements
   * it; transports without a durable thread store omit it.
   */
  readThreadContent?(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ path: string; content: string } | undefined>;
  /**
   * Optional: read the thread's LOADOUT (threads-only Phase A —
   * DESIGN-2026-06-29-threads-only.md §9) — the `metadata.loadout` array of note PATHS on the
   * thread's `#agent/thread` note, resolved to `{ path, content }` entries (note CONTENT only,
   * NEVER metadata), preserving the declared ORDER. `subject` resolves the subject-scoped note;
   * omitted → the def-named note (HEAD). Absent `metadata.loadout` → an empty array. A missing
   * note path is SKIPPED-and-WARNED (never throws — mirrors the def-load skip discipline); a
   * blank-bodied note is returned and the composer skips it. Only a durable transport (the
   * VaultTransport) implements it; transports without a durable thread store omit it.
   */
  readThreadLoadout?(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ path: string; content: string }[]>;
  /**
   * Optional: read the thread's ROLES (layer ① — DESIGN-2026-06-29-threads-roles-context.md).
   * Resolves the `metadata.roles` array of note PATHS on the thread's `#agent/thread` note in
   * ONE pass to BOTH (a) the ordered CONTENT entries (`{ path, content }` — note content only)
   * the backend composes as the FIRST prompt layer, and (b) the grant-holder KEYS (the slugged
   * PATH, `rolePathKey`) for the loaded notes that are ROLES (carry the `#agent/role` tag AND
   * declare a non-empty `wants:`). This is the SECURITY GATE: listing a plain content note in
   * `metadata.roles` loads its content as context but its `wants:` is IGNORED (only `#agent/role`
   * notes contribute grants) — loading context can never escalate. The backend prepends the
   * entries before the def (self) and unions the grant keys with the def's own `spec.name` grants.
   * `subject` resolves the subject-scoped thread note. Absent `metadata.roles` / no role → an
   * empty `{ entries: [], grantKeys: [] }` (every current thread). Only a durable transport (the
   * VaultTransport) implements it; others omit it.
   */
  readThreadRoles?(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ entries: { path: string; content: string }[]; grantKeys: string[] }>;
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
