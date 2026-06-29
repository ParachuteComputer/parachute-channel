/**
 * vault transport for parachute-agent.
 *
 * A channel backed by `#agent/message` notes in a Parachute vault. The vault
 * becomes the persistence layer + the inter-module event bus; the channel is the
 * adapter that wakes a session on a new note and writes the session's reply back
 * as a note.
 *
 * TAG NAMESPACE (`#agent/*`, module-owned — design
 * `2026-06-17-vault-native-agents.md`). The `#agent` prefix is owned entirely by
 * the agent module: every vault object the module manages hangs off it —
 * `#agent/definition` (the agent def), `#agent/message{,/inbound,/outbound}` (a
 * conversation turn), `#agent/job` (a scheduled trigger). We WRITE and READ only
 * the `#agent/message*` tags — the channel→agent data-model rename CONTRACT phase
 * dropped the legacy `#channel-message*` and interim `#agent-message*` dual-read
 * (no surviving old-tagged data to recognize).
 *
 * ROUTING KEY (`metadata.agent`). Every note this module writes carries the routing
 * key under `metadata.agent` ONLY — the CONTRACT phase of the channel→agent rename
 * dropped the `metadata.channel` dual-write. The vault inbound trigger keys on
 * `has_metadata:["agent"]`. The `noteAgentKey` helper still READS `agent ?? channel`
 * as a tolerance fallback so a stray in-flight note written by an older build during
 * the live cutover still routes — read-only, no longer written.
 *
 * How it differs from telegram / http-ui — the "external party" is the vault:
 *  - Inbound (human → session): a vault trigger POSTs the daemon's
 *    `/api/vault/inbound` webhook when a new `#agent/message/inbound` note
 *    appears; the daemon resolves the channel from `note.metadata.agent` (via
 *    `noteAgentKey`) and calls this transport's `ingestInbound(note)`, which
 *    `ctx.emit(...)`s → routes to the bridge / MCP session subscribed to that
 *    channel and wakes it.
 *  - Outbound (session → human): when the session calls the `reply` tool, the
 *    bridge POSTs `/api/reply {channel,...}`; the daemon dispatches to this
 *    transport's `reply()`, which writes a `#agent/message/outbound` note via
 *    the vault REST API (`POST <vaultUrl>/vault/<vault>/api/notes`).
 *
 * Tagging model — two ORTHOGONAL axes (this was a footgun; read carefully).
 * In a Parachute vault a slash in a tag NAME is a namespace convention only —
 * it implies NOTHING about query inheritance. `query-notes { tag: "X" }` matches
 * descendants by the `tags.parent_names` graph, which is declared explicitly via
 * `update-tag`, NOT inferred from the name. So a note tagged ONLY
 * `#agent/message/inbound` is INVISIBLE to a `tag: "#agent/message"` query
 * unless that inheritance was separately declared. We don't want to depend on
 * per-vault schema setup, so every note carries BOTH tags literally:
 *  - the parent `#agent/message` — the QUERYABLE membership tag (a UI lists a
 *    channel's whole transcript, both directions, with one `tag: "#agent/message"`
 *    + `metadata.channel` query, because the parent is literally present);
 *  - a directional child — the trigger DISCRIMINATOR (`#agent/message/inbound`
 *    on inbound, `#agent/message/outbound` on outbound).
 *
 * Loop avoidance (load-bearing). An outbound reply is itself an `#agent/message`
 * note; if the trigger fired on it the session would wake on its own reply forever.
 * The vault trigger predicate does EXACT tag membership, so it's keyed on the
 * inbound child only — `tags: ["#agent/message/inbound"]` — which an outbound
 * note (parent + `/outbound`) never carries, so a reply can't wake its own session.
 * As belt-and-suspenders, `ingestInbound` also drops any note tagged
 * `#agent/message/outbound` (or `direction: "outbound"`) — so even a mis-wired
 * trigger can never wake us on our own reply.
 */

import type {
  Transport,
  TransportContext,
  ReplyArgs,
  ThreadRecord,
  CallbackMetadata,
  InboundAttachment,
} from "../transport.ts";
// roles×threads NEXT slice (#120): the shared thread-key sanitizer — REUSED here for the
// subject-scoped deterministic thread-note leaf (`<name>--<slug(subject)>`) so the path
// math matches the registry's drain key exactly (no drift).
import { threadKey } from "../sandbox/types.ts";
// roles as the capability layer (DESIGN-2026-06-29-threads-roles-context.md): the pure
// role-detection helpers — `roleWants` is the SECURITY GATE (a note's `wants:` is honored
// only if it is an `#agent/role`), `rolePathKey` derives the hub grant-holder key from the
// role's slugged path. A role is read ONCE per turn: its CONTENT becomes the layer-① prompt
// entry and its (gated) `wants:` becomes the grant keys — see `readThreadRoles`.
import { roleWants, rolePathKey, isRoleNote } from "../grants.ts";

/** The safe basename of a (possibly path-ful, possibly untrusted) string — the LAST
 *  path segment, with traversal markers stripped. Used to derive a display `filename`
 *  from an attachment `path`. The backend re-sanitizes before staging; this is just a
 *  reasonable default for the surfaced hint. */
function basenameOf(p: string): string {
  // Split on both slash flavors, take the last non-empty segment, drop `..`.
  const parts = p.split(/[/\\]+/).filter((s) => s.length > 0 && s !== "..");
  return parts.length > 0 ? parts[parts.length - 1]! : "";
}

/** Config for a vault transport instance (from the channel registry entry). */
export interface VaultTransportConfig {
  /** Vault name (the `<vault>` path segment in the REST URL). */
  vault: string;
  /** REST base origin. Default `http://127.0.0.1:1940`. */
  vaultUrl?: string;
  /** A `vault:<name>:write` hub JWT, presented as Bearer when writing replies. */
  token: string;
  /**
   * Shared secret the inbound webhook must present (validated by the daemon),
   * for the DEPRECATED `?secret=` back-compat path. OPTIONAL — a JWT-only channel
   * (the frictionless-setup default, provisioned by the hub with NO shared
   * secret) configures none, and the webhook handler authenticates it via the
   * hub-JWT path instead. When absent, the `?secret=` fallback can never succeed
   * for this channel (nothing to validate against → 401).
   */
  webhookSecret?: string;
  /** Optional path prefix for written notes. Default `channel`. */
  notePathPrefix?: string;
  /**
   * Whether `start()` fires the best-effort `ensureSchema()` tag-schema upsert
   * against the connected vault. Default `true` (back-compat — the daemon always
   * declares the module's tag inheritance on connect). Tests that construct a
   * transport with a fake token set this `false` so `start()` does NOT hit the
   * live vault on 127.0.0.1:1940 (which 401s the fake token → ~one `console.warn`
   * per schema entry of benign noise). The "tag both parent + child" write floor
   * means a channel works regardless, so skipping the declaration is safe; it's
   * only a setup optimization, not a runtime contract. See #32.
   */
  declareSchemaOnStart?: boolean;
}

/** The note shape the daemon hands `ingestInbound` (a subset of the trigger payload). */
export interface InboundNote {
  id: string;
  content?: string;
  /** The note's tags — carries `#agent/message/{inbound,outbound}` for loop avoidance. */
  tags?: string[];
  metadata?: Record<string, unknown>;
  /**
   * The note's attachments, if the trigger payload carried them inline (vault's
   * `send: "json"` webhook includes `note.attachments` — each `{ id, path, mimeType, ... }`).
   * A FAST-PATH: when present + non-empty, `ingestInbound` uses these directly and skips
   * the REST attachment-list fetch. When absent, `ingestInbound` does NOT fetch (the
   * daemon always forwards the inline list when the note has one — Phase 1).
   */
  attachments?: Array<{ id?: string; path?: string; mimeType?: string }>;
}

/**
 * A scheduled-job note as read back from the vault (design
 * `2026-06-17-runner-scheduled-agent-turns.md`). The runner's vault-native job
 * store maps these to/from the `Job` type in `jobs.ts`. `content` is the message
 * to inject; the schedule + bookkeeping live in `metadata` (all string-typed in
 * the vault — `enabled` is "true"/"false"; `nextRunAt` is NEVER persisted, it's
 * recomputed in memory by the runner). The note `id` (or path) addresses it for
 * PATCH/DELETE.
 */
export interface JobNote {
  /**
   * The operator-facing job id — the SLUG the operator typed (carried in
   * `metadata.jobId`). This is what the UI displays, what addresses the job in the
   * `/api/jobs/:id` routes, and what stamps `runner:<jobId>` provenance. Falls back
   * to `noteId` for a legacy note written without the metadata field.
   */
  id: string;
  /** The vault note id/path — addresses the note for PATCH / DELETE I/O. */
  noteId: string;
  /** The message text to inject as the inbound note when this job fires. */
  message: string;
  /** Target channel (routes the job to its vault transport). */
  channel: string;
  /** 5-field cron expression. */
  cron: string;
  /** IANA timezone, if set. */
  tz?: string;
  /** Whether the runner considers this job. */
  enabled: boolean;
  /** ISO timestamp the job was created. */
  createdAt?: string;
  /** ISO timestamp of the most recent fire. */
  lastRunAt?: string;
  /** "ok" / "error: …" from the most recent fire. */
  lastStatus?: string;
  /**
   * The THREAD SUBJECT a fire carries (roles×threads NOW slice) — read back from
   * `metadata.subject`. Optional; absent → today's behavior (no subject).
   */
  subject?: string;
}

/** The metadata payload written for a job note (all string-typed, per the vault). */
export interface JobNoteMetadata {
  /** The operator-facing slug (so the displayed id survives the vault's note-id assignment). */
  jobId: string;
  /** The routing key — written under `metadata.agent` only (the channel→agent CONTRACT). */
  agent: string;
  cron: string;
  tz?: string;
  /** "true" | "false" — the vault stores metadata as strings. */
  enabled: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: string;
  /**
   * The THREAD SUBJECT a fire of this job carries (roles×threads NOW slice) — stamped
   * onto the inbound note the runner injects, so the turn's composed prompt + (NEXT)
   * thread routing can read it. Optional; absent → today's behavior (the weave job
   * carries none).
   */
  subject?: string;
}

/**
 * One message in a channel transcript, as the built-in chat renders it. This is
 * the transport-neutral shape `loadTranscript` produces from the vault notes; the
 * daemon's `GET /api/channels/<ch>/messages` returns `{ messages: ChannelMessage[] }`.
 *
 * `direction` drives the chat's bubble placement: `inbound` (human → session) is
 * "you" (right), `outbound` (session → human) is "them" (left) — mirroring the
 * Telegram/vault transport meaning, NOT the chat's local point of view.
 */
export interface ChannelMessage {
  /** The vault note id — the chat dedups its poll by this. */
  id: string;
  /** The message body (the note content). */
  text: string;
  /** `inbound` = human→session ("you"); `outbound` = session→human ("them"). */
  direction: "inbound" | "outbound";
  /** Who authored it (metadata.sender), e.g. "operator" / "session" / "aaron". */
  sender: string;
  /** ISO timestamp (metadata.ts) — the transcript is sorted ascending by this. */
  ts: string;
  /** The inbound note id this reply threads to, when present (outbound only). */
  inReplyTo?: string;
}

/**
 * The claim status carried on an `#agent/message/inbound` note for a CHANNEL-backend
 * agent (design 2026-06-18-channel-backend.md "Claim/ack durability"). The vault is
 * the source of truth — the status lives on the note so a claim survives a daemon
 * restart and a handled message is never re-presented.
 *
 *  - `pending`   — unhandled; waiting for a connected session to claim it.
 *  - `in-flight` — claimed by a session (`next-message`); `claimedAt` stamps when.
 *                  Auto-released back to `pending` after a TTL (the daemon sweep) so a
 *                  crashed session can't strand the queue.
 *  - `handled`   — replied to; the outbound note is written. Never re-presented.
 *
 * NOTE: programmatic-backend inbound notes do NOT use this field — their turn runs
 * synchronously in the serial worker; status is meaningful only on the channel path.
 */
export type InboundStatus = "pending" | "in-flight" | "handled";

/**
 * One inbound queue item for an ATTACHED-backend agent — an `#agent/message/inbound`
 * note as the {@link AttachedQueueRegistry} reads it. Carries the claim `status` +
 * `claimedAt` (for the TTL sweep) alongside the message text + threading id.
 */
export interface InboundQueueNote {
  /** The vault note id — addresses the note for the status PATCH + threads the reply. */
  id: string;
  /** The message text the connected session works on. */
  text: string;
  /** Who authored it (metadata.sender). */
  sender: string;
  /** ISO timestamp (metadata.ts) — the queue is ordered ascending by this (oldest first). */
  ts: string;
  /** The claim status (`pending` when the field is absent — a fresh inbound). */
  status: InboundStatus;
  /** ISO timestamp the note was claimed (set with `in-flight`); used by the TTL sweep. */
  claimedAt?: string;
  /**
   * The note's vault `updated_at` (the last-seen revision). Threaded through so a
   * claim can use it as the `if_updated_at` compare-and-swap precondition (agent#101):
   * two concurrent `claimNext` reads see the SAME `updated_at`; the first claim PATCH
   * advances it, so the second's precondition fails (vault 409) and it re-lists rather
   * than double-claiming. Absent when the vault response omitted it.
   */
  updatedAt?: string;
}

const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";
const DEFAULT_PATH_PREFIX = "channel";

/**
 * Thrown by {@link VaultTransport.setInboundStatus} when a compare-and-swap claim
 * (an `ifUpdatedAt` precondition) FAILED — the note changed since it was read, so
 * another writer won the race (agent#101). The vault returns **409** (`error_type:
 * "conflict"`) for a STALE `if_updated_at`, and **428** (`precondition_required`) when
 * the precondition is absent; we treat both as "lost the claim race" so the caller
 * (the channel queue's `claimNext`) re-lists and tries the next pending message rather
 * than double-claiming. Distinct from a generic write error (any other non-ok status),
 * which still throws a plain Error.
 */
export class InboundClaimConflictError extends Error {
  constructor(
    readonly id: string,
    readonly status: number,
  ) {
    super(`vault transport: inbound claim ${id} lost the CAS race (${status})`);
    this.name = "InboundClaimConflictError";
  }
}
/** Parent tag (NEW, namespaced) — carried LITERALLY on every note WE write; query
 *  this + metadata.channel to see BOTH directions of a channel (the slash children
 *  are namespace, not inheritance). */
const AGENT_MESSAGE_TAG = "agent/message";
/** Inbound child (NEW) — the vault trigger fires on this exact tag (never matches outbound → no loop). */
const AGENT_MESSAGE_INBOUND_TAG = "agent/message/inbound";
/** Outbound child (NEW) — replies carry this; the trigger's exact-match predicate excludes it. */
const AGENT_MESSAGE_OUTBOUND_TAG = "agent/message/outbound";

/** Metadata key carrying the channel-queue claim status (design 2026-06-18). */
const STATUS_META_KEY = "status";
/** Metadata key carrying the ISO timestamp an inbound was claimed (for the TTL sweep). */
const CLAIMED_AT_META_KEY = "claimedAt";

/** The agent (routing) key carried on a vault note's metadata — a THREE-LEVEL dual-read
 *  (threads-only Phase B — DESIGN-2026-06-29-threads-only.md §5/§9): the NEW `thread`
 *  field (the thread-id address) FIRST, then the canonical `agent` field, then the legacy
 *  `channel` field as a read-only TOLERANCE for any in-flight note written by an older
 *  build during the live cutover.
 *
 *  BACK-COMPAT (load-bearing): the 4 live def agents (uni, steward, uni-evolve,
 *  eco-civilization) — and the 4am steward weave job — carry `metadata.agent` and NO
 *  `metadata.thread`, so they route EXACTLY as before this change. The `thread` read is an
 *  ADDITIVE parallel path: nothing WRITES `metadata.thread` yet (Phase C flips the writer),
 *  so it is dormant until a thread-addressed inbound appears. New writes carry `agent` only
 *  (the channel→agent CONTRACT dropped the `channel` dual-write). */
export function noteAgentKey(meta: Record<string, unknown> | undefined | null): string | undefined {
  const t = meta?.thread;
  if (typeof t === "string" && t) return t;
  const a = meta?.agent;
  if (typeof a === "string" && a) return a;
  const c = meta?.channel;
  return typeof c === "string" && c ? c : undefined;
}

/**
 * Coerce a raw `status` metadata value to an {@link InboundStatus}. The vault stores
 * metadata as strings; an absent / empty / unrecognized value reads as `pending` (the
 * safe default — a fresh inbound the trigger just created carries no status, and an
 * unknown value shouldn't strand the note). Only the two non-default states need an
 * explicit value.
 */
function coerceInboundStatus(v: unknown): InboundStatus {
  if (v === "in-flight" || v === "handled") return v;
  return "pending";
}

/**
 * Coerce a raw metadata value (the vault stores metadata as STRINGS) to a finite number,
 * defaulting to 0. Used to roll up a single-threaded thread's cumulative aggregates
 * (`turn_count`, token/cost usage) read back from the prior note.
 */
function numFromMeta(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse a thread note's note-path-array metadata field (`metadata.loadout` — the layer-③
 * extra context; OR `metadata.roles` — the layer-① roles, DESIGN-2026-06-29-threads-roles-context.md)
 * into an ordered list of note PATHS. The model home is an ARRAY of path strings, but the
 * vault stores metadata flexibly (a real JSON array, a JSON-encoded array STRING, or —
 * defensively — a single path string), so accept all three:
 *
 *  - a real `string[]` → kept (string entries only);
 *  - a `string` that JSON-parses to an array of strings → that array;
 *  - any other non-empty `string` → a single-element list (one path);
 *  - absent / empty / unparseable → `[]` (no loadout — the no-loadout invariant).
 *
 * Each entry is trimmed; blank entries are dropped. PURE — no I/O. Exported for unit tests.
 */
export function parseLoadoutPaths(v: unknown): string[] {
  const clean = (arr: unknown[]): string[] =>
    arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter((s) => s.length > 0);
  if (Array.isArray(v)) return clean(v);
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return clean(parsed);
      } catch {
        // Not valid JSON — fall through to treat the whole string as one path.
      }
    }
    return [trimmed];
  }
  return [];
}

/**
 * The module-owned root namespace tag. Declared (with the three children rolling up
 * to it via `parent_names`) so a human `tag:#agent` query expands to EVERYTHING the
 * module owns — definitions, messages, jobs. The module itself never queries by this
 * (it always queries the exact leaf tag); it exists for the nice human rollup, per
 * the design's namespacing decision.
 */
export const AGENT_ROOT_TAG = "agent";

/**
 * Agent-definition tag — a vault-native agent IS a `#agent/definition` note (design
 * `2026-06-17-vault-native-agents.md`). The note BODY is the system prompt; the note
 * METADATA is the config (name, backend, workspace, isolation, the def-vault binding).
 * The module reads these notes from a def-vault and instantiates each as a live agent.
 */
export const AGENT_DEFINITION_TAG = "agent/definition";

/**
 * Role tag — a `#agent/role` note (roles as the capability layer,
 * DESIGN-2026-06-29-threads-roles-context.md). A REUSABLE bundle: its BODY is loaded as the
 * FIRST system-prompt layer (the "hat") and its `wants:` metadata declares the capabilities
 * (MCPs / access / grants) a thread that loads it gains. It is the ONLY layer that grants
 * capability — the security gate (`isRoleNote` / `roleWants` in grants.ts) honors `wants:`
 * ONLY on a note carrying this tag, so loading plain context can never escalate. The
 * elevation of the prior (unwired) `#pack`.
 */
export const AGENT_ROLE_TAG = "agent/role";

/**
 * Scheduled-job tag — the runner's vault-native job store (design
 * `2026-06-17-runner-scheduled-agent-turns.md`). A job IS a vault note carrying
 * this parent tag; queryable + durable + surface-renderable, exactly like
 * `#agent/message`. Introduced in Phase 2 as the flat `#agent-job`; moved into the
 * `#agent/*` namespace (`#agent/job`) by the vault-native-agents work (Phase 4a).
 */
export const AGENT_JOB_TAG = "agent/job";
/** Default path prefix under which job notes are written: `Channels/<ch>/jobs/<id>`. */
const JOB_PATH_PREFIX = "Channels";

/**
 * Thread tag — the UNIFIED model: `definition -> thread -> message`. EVERYTHING is a
 * thread; a `#agent/thread` note is the durable, queryable record of one conversation
 * thread, written for BOTH execution-lifecycle modes (the structural unification —
 * "a run was always a thread with one turn"). The note BODY is a rolling SUMMARY of the
 * thread (a future summarizer agent may own/enrich the `## Summary` slot — module-owned
 * in v1); metadata = `{ agent, definition, mode, status, started_at, last_turn_at,
 * turn_count, usage }` (`agent` is the routing key — the channel→agent CONTRACT).
 * The INDEXED string fields (`status`, `definition`, `mode`) make
 * "all failed threads" / "all threads of agent X" / "all multi-threaded threads"
 * operator-queryable. `definition` is a plain note-id string for now (interim — typed
 * link fields are a future vault feature).
 *
 * The MODE difference is the thread's IDENTITY (path leaf) + whether it upserts:
 *  - `single-threaded` — exactly ONE thread note per channel, at the DETERMINISTIC stable
 *    path `Threads/<safeChannel>/<safeName>` ("named after the definition"), UPSERTED in
 *    place across turns (turn_count increments, usage accumulates).
 *  - `multi-threaded` — one thread note per fire, at `Threads/<safeChannel>/<uuid>` (today
 *    one fire = one thread = one note; turn_count = 1; usage = this turn's). No upsert.
 *
 * The note carries `['#agent/thread']` EXACTLY — NOT a message tag, NOT the inbound
 * child — so it can never wake a session (no loop).
 */
export const AGENT_THREAD_TAG = "agent/thread";
/** Default path prefix under which thread notes are written: `Threads/<ch>/<leaf>`. */
const THREAD_PATH_PREFIX = "Threads";

/**
 * The tag schema this module manages in any vault it's connected to.
 *
 * This is the declarative complement to the "tag both parent + child" fail-safe
 * in `reply()` / inbound writes. A slash in a Parachute tag NAME is namespace-only
 * — it carries NO query inheritance. Inheritance is the `parent_names` graph,
 * declared via the vault's tag-schema API. We declare the full `#agent/*`
 * namespace rollup (design `2026-06-17-vault-native-agents.md`):
 *   - `#agent/definition`        → parent `#agent`
 *   - `#agent/role`              → parent `#agent`
 *   - `#agent/message`           → parent `#agent`
 *   - `#agent/message/inbound`   → parent `#agent/message`
 *   - `#agent/message/outbound`  → parent `#agent/message`
 *   - `#agent/job`               → parent `#agent`
 * so a human `tag:#agent` query rolls up to EVERYTHING the module owns, and
 * `tag:#agent/message` rolls up to both directions — without the module's own
 * exact-leaf queries depending on per-vault schema.
 *
 * The channel→agent rename CONTRACT dropped the prior `#agent-message*` (interim) and
 * `#channel-message*` (legacy) schema entries — there's no surviving old-tagged data
 * to keep their inheritance declared for.
 *
 * This matches the vault's "clients bring their own tag schema" principle: the
 * WRITING module provisions its own tag schema at connect-time. It's MODULE-OWNED
 * DATA (not inline calls) so it's the seam for a future module-protocol
 * "tag schemas this module manages" declaration — changing this constant changes
 * exactly what `ensureSchema()` provisions.
 *
 * `ensureSchema()` upserts each entry; the "tag both" floor in the note writes
 * stays as the fail-safe so the channel works even if this declaration never lands.
 */
export const AGENT_VAULT_TAG_SCHEMA: ReadonlyArray<{
  name: string;
  description?: string;
  parent_names?: string[];
  /**
   * Indexed metadata field declarations (the vault's `update-tag` `fields` shape) —
   * `{ <field>: { type, indexed } }`. Declared so the field gets a generated column +
   * index, making it queryable via metadata operator objects. Used by `#agent/thread`
   * (status/definition/mode) so an operator can query "all failed threads" / "all threads
   * of agent X" / "all multi-threaded threads".
   */
  fields?: Record<string, { type: "string" | "boolean" | "integer"; indexed?: boolean }>;
}> = [
  {
    name: AGENT_ROOT_TAG,
    description: "The agent module's namespace root — rolls up definitions, messages, and jobs.",
  },
  {
    name: AGENT_DEFINITION_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description: "A vault-native agent definition — body is the system prompt, metadata is the config.",
  },
  {
    name: AGENT_ROLE_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description:
      "A reusable role — body is loaded as the first prompt layer; metadata.wants declares its capabilities (the only capability-granting layer).",
  },
  {
    name: AGENT_MESSAGE_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description: "A message in a Parachute channel (parent of /inbound + /outbound).",
    // Declare the canonical `agent` routing key indexed so agent-keyed queries are
    // indexed. (Transcript filtering itself stays client-side / index-free.)
    fields: {
      agent: { type: "string", indexed: true },
    },
  },
  {
    name: AGENT_MESSAGE_INBOUND_TAG,
    parent_names: [AGENT_MESSAGE_TAG],
    description: "Human→session message; the vault trigger fires on this.",
  },
  {
    name: AGENT_MESSAGE_OUTBOUND_TAG,
    parent_names: [AGENT_MESSAGE_TAG],
    description: "Session→human reply.",
  },
  {
    name: AGENT_JOB_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description: "A scheduled job — the runner injects this note's message on its cron schedule.",
    // Indexed query axes so an operator/agent can find jobs by target + state (mirrors
    // the #agent/thread axes). All stored as strings (the vault stores metadata as
    // strings; `enabled` is "true"/"false"):
    //  - agent      → "all jobs targeting agent X"
    //  - enabled    → "active jobs" (enabled:"true") vs paused ("false")
    //  - lastStatus → "jobs whose last run errored"
    // The full field set is `JobNoteMetadata` in src/jobs.ts (design
    // 2026-06-17-runner-scheduled-agent-turns); the schema is permissive, so the other
    // job fields (jobId/cron/tz/createdAt/lastRunAt) ride as undeclared metadata.
    fields: {
      // The canonical `agent` routing key, indexed for "all jobs targeting agent X".
      agent: { type: "string", indexed: true },
      enabled: { type: "string", indexed: true },
      lastStatus: { type: "string", indexed: true },
    },
  },
  {
    name: AGENT_THREAD_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description:
      "A thread record (definition -> thread -> message) — body is a rolling summary, metadata is the thread state. Written for BOTH modes.",
    // The three indexed query axes carry over from the run record VERBATIM — an operator
    // can query threads by outcome / agent / mode:
    //  - status     → "all failed threads" (status:error)
    //  - definition → "all threads of agent X" (the def note id)
    //  - mode       → "all multi-threaded threads"
    fields: {
      // The canonical `agent` routing key, indexed (mirrors #agent/message + #agent/job).
      agent: { type: "string", indexed: true },
      status: { type: "string", indexed: true },
      definition: { type: "string", indexed: true },
      mode: { type: "string", indexed: true },
    },
  },
];

/**
 * The vault trigger the hub registers to wake this channel on inbound notes.
 *
 * This is MODULE-OWNED DATA: the channel owns the shape of the trigger it needs,
 * rather than the hub hardcoding it. The hub fetches this template (via
 * `GET /.parachute/config` → `triggerTemplate`), substitutes the channel name
 * into the placeholders, fills the webhook origin + the `action.auth.bearer`
 * (an `agent:send` hub JWT, per the keystone vault PR's `action.auth.bearer`
 * support), and registers it through the vault's runtime trigger-registration API.
 *
 * Placeholders the hub substitutes:
 *  - `<channel>` in `name` → the channel name (e.g. `channel_inbound_eng`);
 *  - `<hub-origin>` in `action.webhook` → the hub's public origin.
 * The hub also injects `action.auth.bearer` (not in the template — it's a secret
 * the hub mints).
 *
 * The predicate matches a NEW inbound note (`#agent/message/inbound`) that
 * carries an `agent` metadata field (the routing key, post channel→agent CONTRACT)
 * and hasn't been rendered yet. Loop avoidance is by the inbound CHILD tag: an
 * outbound (reply) note carries `#agent/message/outbound`, never the inbound child,
 * so it never fires this. (The trigger `name` and the `channel_inbound_rendered_at`
 * marker are internal plumbing — kept STABLE so re-registration updates the existing
 * trigger in place rather than orphaning one.)
 */
export const AGENT_VAULT_TRIGGER_TEMPLATE = {
  name: "channel_inbound_<channel>", // hub substitutes the channel name
  events: ["created"],
  when: {
    tags: ["agent/message/inbound"],
    has_metadata: ["agent"],
    missing_metadata: ["channel_inbound_rendered_at"],
  },
  action: {
    webhook: "<hub-origin>/agent/api/vault/inbound", // hub fills origin + the auth.bearer
    send: "json",
  },
} as const;

/**
 * The vault trigger that keeps vault-native agent DEFINITIONS in sync (design
 * `2026-06-17-vault-native-agents.md`, Phase 4a). On a `#agent/definition` note
 * created/updated/deleted, the hub POSTs the def-reload webhook; the daemon reloads
 * that ONE agent (created/updated → re-instantiate; deleted → deregister). MODULE-
 * OWNED DATA — the module declares the trigger it needs; the hub fills the origin +
 * the `action.auth.bearer` (a minted `agent:send` token, the same auth as the inbound
 * trigger). One trigger per def-vault (no per-note placeholder — the predicate is the
 * whole `#agent/definition` tag). A poll fallback covers vaults without trigger support.
 */
export const AGENT_DEF_VAULT_TRIGGER_TEMPLATE = {
  name: "agent_def_reload",
  events: ["created", "updated", "deleted"],
  when: {
    tags: ["agent/definition"],
  },
  action: {
    webhook: "<hub-origin>/agent/api/vault/agent-def", // hub fills origin + the auth.bearer
    send: "json",
  },
} as const;

export class VaultTransport implements Transport {
  readonly kind = "vault";

  private ctx: TransportContext | undefined;
  private readonly vault: string;
  private readonly vaultUrl: string;
  private readonly token: string;
  /**
   * Shared secret the daemon validates on the inbound webhook (read by the
   * daemon), for the DEPRECATED `?secret=` path only. Optional — absent on a
   * JWT-only channel, in which case the `?secret=` fallback can never authorize
   * this channel (the daemon treats an absent/empty configured secret as
   * never-matching). The hub-JWT path doesn't read it at all.
   */
  readonly webhookSecret?: string;
  private readonly pathPrefix: string;
  /** See `VaultTransportConfig.declareSchemaOnStart`. Default `true`. */
  private readonly declareSchemaOnStart: boolean;

  constructor(config: VaultTransportConfig) {
    if (!config.vault) {
      throw new Error("VaultTransport: config.vault (vault name) is required");
    }
    if (!config.token) {
      throw new Error("VaultTransport: config.token (vault:<name>:write JWT) is required");
    }
    // webhookSecret is OPTIONAL — a JWT-only channel (the frictionless-setup
    // default) needs none. The webhook is authenticated via the hub-JWT path;
    // the `?secret=` fallback simply can't succeed for a channel with no secret.
    this.vault = config.vault;
    this.vaultUrl = (config.vaultUrl ?? DEFAULT_VAULT_URL).replace(/\/$/, "");
    this.token = config.token;
    this.webhookSecret = config.webhookSecret;
    this.pathPrefix = (config.notePathPrefix ?? DEFAULT_PATH_PREFIX).replace(/\/$/, "");
    this.declareSchemaOnStart = config.declareSchemaOnStart ?? true;
  }

  /**
   * Stable identity of the backing vault (origin + name) — NOT the transport
   * instance. Many channels each construct their OWN VaultTransport pointing at the
   * SAME vault; callers that must query a vault once (e.g. the job-store's `listAll`)
   * dedup by THIS key, not by object identity, or the same notes come back once per
   * channel that shares the vault.
   */
  vaultKey(): string {
    return `${this.vaultUrl}::${this.vault}`;
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    // Declare the tag schema this module manages in the connected vault. Strictly
    // best-effort: `ensureSchema` swallows all of its own errors, so an unreachable
    // vault or a failing PUT can NEVER block (or reject out of) `start()`. The
    // "tag both parent + child" floor in the note writes is the fail-safe, so the
    // channel works even if this declaration never lands. Fire-and-forget — no
    // reason to delay the channel coming up on a schema upsert.
    //
    // Suppressible via `declareSchemaOnStart: false` — tests with a fake token
    // set this so `start()` doesn't 401 against the live vault (benign warn noise,
    // #32). The write floor makes the declaration optional anyway.
    if (this.declareSchemaOnStart) void this.ensureSchema();
  }

  // -------------------------------------------------------------------------
  // Schema declaration — provision this module's tag inheritance at connect-time.
  // -------------------------------------------------------------------------

  /**
   * Idempotently upsert `AGENT_VAULT_TAG_SCHEMA` into the connected vault via
   * the vault's tag-schema REST API. The vault route is
   *   PUT /vault/<vault>/api/tags/:name
   * where `:name` is matched by `subpath.match(/^\/([^/]+)$/)` then
   * `decodeURIComponent`'d (parachute-vault `src/routes.ts` handleTags, the
   * "Routes with tag name" block + `routing.ts` `apiPath.startsWith("/tags")`).
   * Because the route matches a SINGLE path segment (`[^/]+`, no literal slash)
   * and decodes it, the tag name — which contains a `/`
   * (`agent/message/inbound`) — must be `encodeURIComponent`'d so the `/` becomes
   * `%2F`; the route then decodes that back to the literal name. A bare `/` in the
   * URL would fail the `[^/]+` match → 404, silently dropping the declaration. The
   * PUT body is `{ description?, parent_names? }`.
   *
   * Best-effort + non-fatal by contract: every failure is caught and `console.warn`'d,
   * never thrown — the tag-both write floor is the fallback.
   */
  async ensureSchema(): Promise<void> {
    for (const entry of AGENT_VAULT_TAG_SCHEMA) {
      try {
        // Single-segment, percent-encoded name: `agent/message/inbound` →
        // `agent%2Fmessage%2Finbound`. The vault decodes it back to the literal.
        const url = `${this.vaultUrl}/vault/${this.vault}/api/tags/${encodeURIComponent(entry.name)}`;
        const body: {
          description?: string;
          parent_names?: string[];
          fields?: Record<string, { type: "string" | "boolean" | "integer"; indexed?: boolean }>;
        } = {};
        if (entry.description !== undefined) body.description = entry.description;
        if (entry.parent_names !== undefined) body.parent_names = entry.parent_names;
        if (entry.fields !== undefined) body.fields = entry.fields;

        const res = await fetch(url, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          console.warn(
            `vault transport: tag-schema upsert for ${entry.name} failed (${res.status}) ${detail}`.trim(),
          );
        }
      } catch (err) {
        // Vault unreachable / fetch rejected — non-fatal, the tag-both floor covers us.
        console.warn(
          `vault transport: tag-schema upsert for ${entry.name} errored: ${(err as Error).message}`,
        );
      }
    }
  }

  async stop(): Promise<void> {
    // Nothing to release — inbound arrives via the daemon's webhook, not a poll.
  }

  /** The channel name this transport is bound to (after start). */
  private get channel(): string {
    if (!this.ctx) throw new Error("vault transport: not started");
    return this.ctx.channel;
  }

  // -------------------------------------------------------------------------
  // Outbound — the session → vault direction. Write an OUTBOUND note.
  // -------------------------------------------------------------------------

  async reply(args: ReplyArgs): Promise<{ sent: string[] }> {
    const channel = this.channel;
    const ts = new Date().toISOString();
    const id = crypto.randomUUID();
    // Sanitize the channel segment so an operator-configured name with a slash
    // can't reshape the vault path hierarchy (the channel/prefix are operator
    // config, not external input, but keep the path a flat, predictable slug).
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `${this.pathPrefix}/${safeChannel}/${id}`;

    const metadata: Record<string, string> = {
      // The routing key — written under `metadata.agent` ONLY (the channel→agent
      // CONTRACT dropped the `channel` dual-write). `noteAgentKey` still reads
      // `agent ?? channel` as a tolerance fallback for any in-flight straggler.
      agent: channel,
      // `direction` stays as a human/UI convenience field. The loop-avoidance
      // source of truth is now the `#agent/message/outbound` TAG below — the
      // trigger fires on the inbound child tag only, so this note never wakes us.
      direction: "outbound",
      sender: "session",
      ts,
    };
    // Thread the reply to the inbound note id when the bridge passes it through.
    const inReplyTo = args.meta?.in_reply_to;
    if (inReplyTo) metadata.in_reply_to = inReplyTo;
    // The explicit definition→thread→message link: stamp the outbound note with its
    // RESOLVABLE, mode-correct thread id (the programmatic worker passes it through
    // `meta.thread`, agent#163). For a multi-threaded turn this IS the per-fire `#agent/thread`
    // note's leaf; for a single-threaded turn it's the DETERMINISTIC thread-NOTE id
    // (`Threads/<channel>/<name>`), STABLE across turns — so an observer resolves the agent's
    // ONE thread from `metadata.thread`, not a per-turn UUID that changed every run.
    // INBOUND-note stamping is deferred (those notes are written externally, before the turn
    // knows its thread).
    const threadId = args.meta?.thread;
    if (threadId) metadata.thread = threadId;

    const res = await fetch(`${this.vaultUrl}/vault/${this.vault}/api/notes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        content: args.text ?? "",
        path,
        // Parent (queryable membership) + directional child (trigger discriminator).
        // Both literal — the slash child is NOT queryable under the parent on its own.
        tags: [AGENT_MESSAGE_TAG, AGENT_MESSAGE_OUTBOUND_TAG],
        metadata,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `vault transport: write reply failed (${res.status}) ${detail}`.trim(),
      );
    }

    // The vault returns the created note; surface its id. Fall back to the id we
    // proposed in the path if the response shape is unexpected.
    let noteId: string = id;
    try {
      const created = (await res.json()) as { id?: string; note?: { id?: string } };
      noteId = created?.id ?? created?.note?.id ?? id;
    } catch {
      // Non-JSON / empty body — keep the proposed id.
    }
    return { sent: [noteId] };
  }

  /**
   * The DETERMINISTIC path of a thread note that UPSERTS in place —
   * `Threads/<safeChannel>/<leaf>`. The single shared source of truth for that path so
   * {@link writeThread} (the upsert), {@link readThreadSession} (the pre-turn session read),
   * and {@link clearThreadSession} (the reset) can never disagree on where the note lives.
   * Sanitizes the channel segment to a flat, predictable slug.
   *
   * The LEAF is {@link threadKey}`(name, subject)` (roles×threads NEXT slice, #120):
   *  - NO subject → the bare def name (`<safeName>`) — the HEAD single-threaded path,
   *    byte-identical. `threadKey` returns the bare name AND `slug`s it the same way the
   *    prior inline `replace(/[^a-zA-Z0-9_-]/g, "-")` did, so the path is unchanged.
   *  - A subject → `<safeName>--<safeSubject>` (the subject thread's deterministic note),
   *    so a multi-threaded SUBJECT upserts + carries a session across fires.
   *
   * COLLISION NOTE: two agents whose (name, subject) collapse to the SAME leaf on the same
   * channel would share this note. Acceptable: the registry enforces ONE agent per channel
   * (byChannel index), and distinct subjects produce distinct leaves.
   */
  private singleThreadedPath(channel: string, name: string, subject?: string): string {
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    // Slug the NAME segment exactly as HEAD did (the prior inline `replace`), then let
    // threadKey append `--<slug(subject)>` when a subject narrows the thread. With no
    // subject threadKey returns the (already-slugged) name verbatim → the leaf is
    // byte-identical to the HEAD single-threaded path. With a subject the leaf becomes
    // `<safeName>--<safeSubject>` (both slugged → path-safe, no traversal).
    const safeName = (name ?? channel).replace(/[^a-zA-Z0-9_-]/g, "-");
    const leaf = threadKey(safeName, subject);
    return `${THREAD_PATH_PREFIX}/${safeChannel}/${leaf}`;
  }

  /**
   * Materialize a `#agent/thread` note for ONE completed turn — the UNIFIED model
   * (`definition -> thread -> message`). Written for BOTH execution-lifecycle modes
   * (the structural unification): EVERYTHING is a thread, a "run" was always a thread
   * with one turn. This write touches METADATA ONLY (the thread state); the note BODY is
   * the thread's per-thread standing CONTEXT, AUTHORED by a human/agent and NEVER written
   * by the daemon (DESIGN-2026-06-29-thread-content-and-skills.md) — the note is created
   * with EMPTY content when missing and its content is PRESERVED untouched on every later
   * upsert (the PATCH omits `content`). The INDEXED fields (`status`/`definition`/`mode`)
   * make threads operator-queryable. This note carries `['#agent/thread']` EXACTLY — NOT a
   * `#agent/message`, NO inbound child — so it can never wake a session (no loop).
   *
   * The MODE governs the thread's IDENTITY + whether it upserts:
   *  - `single-threaded` — ONE thread note per channel at the DETERMINISTIC stable path
   *    `Threads/<safeChannel>/<safeName>` (named after the definition). It UPSERTS in
   *    place across turns: we READ the existing note first, then write the rolled-up
   *    aggregates (`turn_count` incremented, cumulative `usage`, original `started_at`).
   *  - `multi-threaded` — one thread note PER FIRE at `Threads/<safeChannel>/<uuid>`
   *    (today one fire = one thread; turn_count = 1; usage = this turn's). NO upsert.
   *
   * SAFETY of the read-modify-write for single-threaded: the drain is SERIAL per channel
   * AND single-threaded is one-thread-per-channel today, so there's no concurrent writer
   * to lose an update against. WHEN CONTINUATION brings concurrent threads per channel,
   * switch to re-deriving aggregates from the `#agent/message` children or a vault
   * atomic-merge, to avoid lost-update.
   *
   * Best-effort caller-side: a throw is surfaced to the registry, which logs it (a missing
   * thread note never re-runs the turn — same "don't retry" posture as outbound).
   */
  async writeThread(thread: ThreadRecord): Promise<{ sent: string[] }> {
    const safeChannel = thread.channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const singleThreaded = thread.mode === "single-threaded";
    // roles×threads NEXT slice (#120): a thread is DETERMINISTIC (a named, upserting note
    // that rolls turn_count/usage + carries a session across fires) when it's single-threaded
    // (HEAD) OR it's a multi-threaded thread that carries a SUBJECT. A subject-scoped
    // multi-threaded thread turns "fresh note per fire" into "resume the named thread" — its
    // leaf is `<name>--<subject>`. A multi-threaded thread with NO subject stays a per-fire
    // uuid note (HEAD), byte-identical for the weave + every current agent.
    const subject = thread.subject?.trim();
    const deterministic = singleThreaded || (!singleThreaded && !!subject);

    // IDENTITY (HARD CONSTRAINT 3 — the path leaf IS the thread's identity; no ambiguous
    // `thread_id` metadata field). A DETERMINISTIC thread upserts at a stable leaf named after
    // the def (+ subject when present), via {@link singleThreadedPath} so writeThread,
    // readThreadSession + clearThreadSession all agree on exactly where the note lives. A
    // non-deterministic (multi-threaded, no-subject) thread is a per-FIRE uuid note — reuse
    // the caller's `threadId` when given (a re-record of the same turn — the outbound-failure
    // status flip — targets the SAME per-fire note instead of minting a duplicate); else mint.
    // COLLISION NOTE: two threads whose (name[, subject]) collapse to the SAME leaf on the
    // same channel would upsert each other's note. Acceptable: the registry enforces ONE agent
    // per channel (byChannel index), and distinct subjects produce distinct leaves.
    const path = deterministic
      ? this.singleThreadedPath(thread.channel, thread.name ?? thread.channel, subject)
      : `${THREAD_PATH_PREFIX}/${safeChannel}/${thread.threadId ?? crypto.randomUUID()}`;

    // For a DETERMINISTIC UPSERT (single-threaded OR a multi-threaded subject thread), read
    // the existing thread note (by its deterministic path) to roll up the aggregates. SAFE
    // because the drain is serial PER THREAD KEY (registry per-thread serial guarantee) — a
    // given (name, subject) thread has no concurrent writer to lose an update against.
    //   WHEN per-channel concurrency across DIFFERENT subjects lands they each have their OWN
    //   deterministic note (distinct leaf), so no cross-subject lost-update; only same-subject
    //   would race, and that's serialized by the per-thread drain.
    let priorTurnCount = 0;
    let priorInputTokens = 0;
    let priorOutputTokens = 0;
    let priorCostUsd = 0;
    let priorStartedAt: string | undefined;
    let priorLastTurnAt: string | undefined;
    let priorSession: string | undefined;
    if (deterministic) {
      const prior = await this.readThreadNote(path);
      if (prior) {
        priorTurnCount = numFromMeta(prior.metadata?.turn_count);
        priorInputTokens = numFromMeta(prior.metadata?.input_tokens);
        priorOutputTokens = numFromMeta(prior.metadata?.output_tokens);
        priorCostUsd = numFromMeta(prior.metadata?.total_cost_usd);
        if (typeof prior.metadata?.started_at === "string" && prior.metadata.started_at) {
          priorStartedAt = prior.metadata.started_at;
        }
        if (typeof prior.metadata?.last_turn_at === "string" && prior.metadata.last_turn_at) {
          priorLastTurnAt = prior.metadata.last_turn_at;
        }
        // The persisted Claude session UUID — captured so a write that carries NO
        // session (a start-phase working-ensure) PRESERVES it across the upsert rather
        // than dropping continuity (the thread≡session record).
        if (typeof prior.metadata?.session === "string" && prior.metadata.session) {
          priorSession = prior.metadata.session;
        }
      }
    }

    // ── THREAD-AS-CONTAINER turn_count discipline (the no-double-count invariant) ─────────
    // `phase: "start"` is the WORKING-ENSURE written BEFORE the turn — NO turn has completed
    // yet, so it must NOT advance turn_count: single-threaded writes `turn_count = prior`
    // (UNCHANGED), multi-threaded writes 0 (the per-fire note is being created mid-turn).
    // `phase: "end"` (or absent — back-compat) is the FINAL record AFTER the turn, which is
    // where the turn is COUNTED: single-threaded increments `prior + 1` (UNLESS `sameTurn`,
    // the ok→error outbound-failure re-record, which keeps the already-counted value), and
    // multi-threaded is 1 (one fire = one thread = one turn). So across the start+end pair a
    // turn is counted EXACTLY ONCE (on `end`) — never double-counted.
    const isStart = thread.phase === "start";
    let turnCount: number;
    if (isStart) {
      turnCount = deterministic ? priorTurnCount : 0;
    } else if (deterministic) {
      turnCount = thread.sameTurn ? priorTurnCount : priorTurnCount + 1;
    } else {
      turnCount = 1;
    }
    // `started_at` is set ONCE on create (preserve the prior on upsert). `last_turn_at`
    // advances only when a turn COMPLETES (the `end` write); a `start` working-ensure leaves
    // it at the prior value (single) or empty (multi-create — no turn has completed yet).
    const startedAt = priorStartedAt ?? thread.started_at;
    const lastTurnAt = isStart ? (priorLastTurnAt ?? "") : thread.ended_at;

    // Cumulative usage: a DETERMINISTIC thread SUMS this turn into the prior totals; a
    // per-fire (multi-threaded, no-subject) note carries just this turn's (one fire = one thread).
    const inputTokens =
      (deterministic ? priorInputTokens : 0) + (thread.usage?.inputTokens ?? 0);
    const outputTokens =
      (deterministic ? priorOutputTokens : 0) + (thread.usage?.outputTokens ?? 0);
    const costUsd = (deterministic ? priorCostUsd : 0) + (thread.usage?.totalCostUsd ?? 0);

    // Indexed string fields (queryable) + the thread-state observability fields. The
    // vault stores metadata as strings; numbers are stringified.
    const metadata: Record<string, string> = {
      // The routing key — `metadata.agent` ONLY (the channel→agent CONTRACT).
      agent: thread.channel,
      mode: thread.mode,
      status: thread.status,
      started_at: startedAt,
      turn_count: String(turnCount),
    };
    // `last_turn_at` is only meaningful once a turn has COMPLETED. A `start` working-ensure on
    // a brand-new thread (no prior turn) has no last-turn time yet → omit it rather than
    // stamp an empty string (which would index as a present-but-blank value).
    if (lastTurnAt) metadata.last_turn_at = lastTurnAt;
    if (thread.definition) metadata.definition = thread.definition;
    // The thread≡session record: persist the Claude session UUID onto the note so the
    // NEXT turn can `--resume` it. Prefer the session this write carries; else (a write
    // with no session, e.g. a start-phase working-ensure) PRESERVE the prior DETERMINISTIC
    // note's session so an upsert never drops continuity. A per-fire (no-subject multi)
    // note carries its own per-fire session each write (no preserve — each fire is fresh).
    const session = thread.session ?? (deterministic ? priorSession : undefined);
    if (session) metadata.session = session;
    // Usage is always present once a turn carried it OR we accumulated any — emit the
    // running totals so a query sees cumulative cost for the thread.
    if (deterministic || thread.usage) {
      if (inputTokens) metadata.input_tokens = String(inputTokens);
      if (outputTokens) metadata.output_tokens = String(outputTokens);
      // Round the accumulated cost to 9 decimals before serializing — summing floats
      // (e.g. 0.1 + 0.2) accrues IEEE-754 drift, so a naive String() yields
      // "0.30000000000000004". 9 decimals covers sub-cent costs without losing precision.
      if (costUsd) metadata.total_cost_usd = String(Math.round(costUsd * 1e9) / 1e9);
    }

    // CONTENT = the thread's per-thread standing context, AUTHORED by a human/agent — an INPUT
    // to the prompt, NOT a module-generated summary (DESIGN-2026-06-29-thread-content-and-skills.md).
    // The daemon NEVER writes or overwrites it: this PATCH omits `content` entirely, so the
    // vault CREATES the note with EMPTY content when missing (its create branch defaults
    // `content ?? ""`) and PRESERVES the existing content untouched on every later upsert (its
    // update branch only touches `content` when the body carries it). The thread body is read
    // back CONTENT-only and composed into the system prompt via `readThreadContent`.
    //
    // Upsert by path via PATCH + `if_missing: "create"` (vault#309) — NOT POST. POST
    // /api/notes 409s `path_conflict` on an existing path (it does not upsert), so a
    // single-threaded thread note would create on turn 1 and 409 on every turn after.
    // PATCH-by-path is the real upsert: the vault resolves the (decoded) path, UPDATES it
    // when present (single-threaded turn 2+: metadata merged, content left as authored) or
    // CREATES it when missing (turn 1, and every multi-threaded fresh-uuid fire). `force: true`
    // satisfies the vault's 428 mutation precondition (mirrors `setInboundStatus`). The
    // path is one URL segment (percent-encoded `/`); the route `decodeURIComponent`s it.
    // The `tags` array is consumed ONLY by the create branch. VERIFIED against the vault
    // (`routes.ts`): the PATCH UPDATE branch reads `tags.add` / `tags.remove` (the delta
    // shape), NOT a plain `tags` array — so sending `tags: [AGENT_THREAD_TAG]` here is
    // INERT on update (the note's existing tag is preserved untouched) and only takes
    // effect on the if_missing:create branch. So the single tag is set once at create and
    // preserved across every subsequent upsert (HARD CONSTRAINT 4 — loop-safe single tag).
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        path,
        tags: [AGENT_THREAD_TAG],
        metadata,
        if_missing: "create",
        force: true,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: write thread note failed (${res.status}) ${detail}`.trim());
    }

    let noteId: string = path;
    try {
      const created = (await res.json()) as { id?: string; note?: { id?: string } };
      noteId = created?.id ?? created?.note?.id ?? path;
    } catch {
      // Non-JSON / empty body — keep the path as the addressable id.
    }
    return { sent: [noteId] };
  }

  /**
   * Read a single thread note by its deterministic PATH (the single-threaded upsert
   * read-back). The vault's `GET .../api/notes/<id-or-path>` resolves a note by id OR
   * path; we percent-encode the path's `/` so it's one URL segment. Returns the note
   * (metadata + content) or undefined when it doesn't exist yet (a 404 on the first
   * turn) or the vault is unreachable — the caller treats "no prior" as turn_count 0.
   * Throws on an UNEXPECTED non-ok response (not 404) so a misconfig surfaces.
   */
  private async readThreadNote(
    path: string,
  ): Promise<{ metadata?: Record<string, unknown>; content?: string; tags?: unknown } | undefined> {
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(path)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    } catch (err) {
      // Vault unreachable — treat as "no prior" (we'll create fresh; aggregates reset).
      // SURFACE it: a flaky vault silently resetting a thread's turn_count/usage is a
      // data-quality bug we want visible in logs. Still return undefined so the upsert
      // proceeds (don't strand the queue on a transient network blip).
      console.warn(
        `parachute-agent: readThreadNote network error — thread aggregates reset for ${path}: ${(err as Error).message}`,
      );
      return undefined;
    }
    if (res.status === 404) return undefined; // first turn — note doesn't exist yet.
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: read thread note failed (${res.status}) ${detail}`.trim());
    }
    try {
      const parsed = (await res.json()) as unknown;
      // Tolerate a bare note object OR a `{ note: {...} }` envelope OR a 1-element array.
      // `tags` is carried through (readThreadRoles needs it for the role security gate).
      if (Array.isArray(parsed)) {
        return parsed[0] as { metadata?: Record<string, unknown>; content?: string; tags?: unknown } | undefined;
      }
      const obj = parsed as { note?: unknown; metadata?: unknown; content?: unknown; tags?: unknown };
      if (obj.note && typeof obj.note === "object") {
        return obj.note as { metadata?: Record<string, unknown>; content?: string; tags?: unknown };
      }
      return obj as { metadata?: Record<string, unknown>; content?: string; tags?: unknown };
    } catch {
      // Bad JSON — treat as no prior (don't strand the write on a parse hiccup).
      return undefined;
    }
  }

  /** The persisted Claude session UUID for a thread's deterministic note, or undefined if
   *  none yet (first turn). Read before a turn so the daemon can --resume it. `subject`
   *  (roles×threads NEXT slice, #120) resolves the subject-scoped note
   *  (`Threads/<ch>/<name>--<subject>`) for a multi-threaded subject thread; omitted → the
   *  def-named note (HEAD). Uses {@link singleThreadedPath} so the path math matches writeThread. */
  async readThreadSession(channel: string, name: string, subject?: string): Promise<string | undefined> {
    const prior = await this.readThreadNote(this.singleThreadedPath(channel, name, subject));
    const s = prior?.metadata?.session;
    return typeof s === "string" && s ? s : undefined;
  }

  /** Clear a thread's persisted session so its next turn starts a fresh Claude conversation
   *  (the per-agent restart). `subject` resolves the subject-scoped note; omitted → the
   *  def-named note (HEAD). No-op if no thread note yet. */
  async clearThreadSession(channel: string, name: string, subject?: string): Promise<void> {
    const path = this.singleThreadedPath(channel, name, subject);
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(path)}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ metadata: { session: "" }, force: true }),
    });
    if (res.status === 404) return; // no thread yet = already fresh
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: clear thread session failed (${res.status}) ${detail}`.trim());
    }
  }

  /**
   * Read the thread's own CONTENT — its per-thread standing context
   * (DESIGN-2026-06-29-thread-content-and-skills.md). The thread note's authored BODY (CONTENT
   * only — NEVER metadata) becomes the prompt entry BETWEEN the def and the loadout. `subject`
   * resolves the subject-scoped thread note; omitted → the def-named note (HEAD). The path math
   * reuses {@link singleThreadedPath}, so it agrees with writeThread / readThreadSession /
   * readThreadLoadout.
   *
   * Returns `{ path, content }` ONLY when the note exists AND carries non-blank content (the
   * path is the thread-note path, the composer's `# <path>` header). No thread note yet (404,
   * the first turn before the start-ensure has run / a per-fire thread with no def-named note)
   * OR blank/whitespace content → `undefined` (the no-thread-content case: the prompt is
   * `[self, ...loadout]`, unchanged). Best-effort: a network blip surfaces as `undefined` (via
   * {@link readThreadNote}, which logs it); an UNEXPECTED non-404 read error propagates to the
   * registry's try/catch (the turn runs with the def body alone).
   */
  async readThreadContent(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ path: string; content: string } | undefined> {
    const path = this.singleThreadedPath(channel, name, subject);
    const thread = await this.readThreadNote(path);
    if (!thread) return undefined; // no thread note yet → no authored content.
    const content = typeof thread.content === "string" ? thread.content : "";
    if (content.trim().length === 0) return undefined; // blank body → no thread content.
    return { path, content };
  }

  /**
   * Read the thread's LOADOUT (threads-only Phase A — DESIGN-2026-06-29-threads-only.md §9):
   * the `metadata.loadout` array of note PATHS on the thread's `#agent/thread` note, each
   * resolved to `{ path, content }` (the note's CONTENT only — NEVER its metadata), preserving
   * the declared ORDER. `subject` resolves the subject-scoped thread note; omitted → the
   * def-named note (HEAD). The thread note's path math reuses {@link singleThreadedPath}, so
   * it agrees with writeThread / readThreadSession.
   *
   * SKIP-AND-WARN (mirrors the def-load skip discipline `agent-defs.ts` / `registry.ts`): a
   * loadout path that resolves to no note (404) is SKIPPED with a warn — NEVER thrown — so one
   * stale path can't brick a turn. A blank-bodied note is RETURNED (the composer skips blank
   * entries by content). No thread note yet / absent `metadata.loadout` → an empty array.
   *
   * Best-effort per path: an UNEXPECTED read error on one path is logged + skipped (the turn
   * runs with the rest); the thread-note read itself, if it fails non-404, propagates to the
   * registry's try/catch (which runs the turn with the def body alone).
   */
  async readThreadLoadout(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ path: string; content: string }[]> {
    const thread = await this.readThreadNote(this.singleThreadedPath(channel, name, subject));
    if (!thread) return []; // no thread note yet (first turn) → empty loadout.
    const paths = parseLoadoutPaths(thread.metadata?.loadout);
    if (paths.length === 0) return [];
    const out: { path: string; content: string }[] = [];
    for (const path of paths) {
      let note: { metadata?: Record<string, unknown>; content?: string } | undefined;
      try {
        note = await this.readThreadNote(path);
      } catch (err) {
        // An unexpected (non-404) read error on ONE loadout note — skip it, run with the rest.
        console.warn(
          `parachute-agent: loadout note "${path}" read failed (skipping): ${(err as Error).message}`,
        );
        continue;
      }
      if (!note) {
        // 404 — a stale/renamed loadout path. Skip-and-warn (never throw); the def-load discipline.
        console.warn(`parachute-agent: loadout note "${path}" not found (skipping)`);
        continue;
      }
      // CONTENT only — never the note's metadata. A blank body is returned; the composer skips it.
      out.push({ path, content: typeof note.content === "string" ? note.content : "" });
    }
    return out;
  }

  /**
   * Read the thread's ROLES (layer ① — DESIGN-2026-06-29-threads-roles-context.md): the
   * `metadata.roles` array of note PATHS on the thread's `#agent/thread` note, resolved in ONE
   * pass to BOTH (a) the ordered CONTENT entries (`{ path, content }`) the backend composes as
   * the FIRST prompt layer, and (b) the grant-holder KEYS (the slugged PATH via
   * {@link rolePathKey}) for the loaded notes that are ROLES declaring `wants:`. The backend
   * prepends the entries before the def (self) and unions `listGrants(roleKey)` for each grant
   * key with the def's own `listGrants(spec.name)`.
   *
   * THE SECURITY GATE: a loaded note's `wants:` is honored ONLY if the note carries the
   * `#agent/role` tag (`roleWants` returns null for a non-role note even when it declares
   * `wants:`). So listing an arbitrary content note in `metadata.roles` loads its CONTENT as
   * context but can NEVER add capabilities — only a real `#agent/role` contributes a grant key.
   * This is the single read of each role note: content for layer ① + the gated `wants:` →
   * grants, so a role declares its hat AND its access in one place.
   *
   * Skip-and-warn per path (mirrors the loadout discipline): a 404/renamed path or a read
   * error on one note is skipped — never thrown — so one stale path can't brick a turn. A
   * blank-bodied note is RETURNED in the entries (the composer skips blank entries by content).
   * No thread note / absent `metadata.roles` → `{ entries: [], grantKeys: [] }` (every current
   * thread — the no-roles invariant). Grant keys are deduped (a role listed twice yields one
   * key). `subject` resolves the subject-scoped thread note (path math reuses
   * {@link singleThreadedPath}, so it agrees with writeThread / readThreadLoadout).
   */
  async readThreadRoles(
    channel: string,
    name: string,
    subject?: string,
  ): Promise<{ entries: { path: string; content: string }[]; grantKeys: string[] }> {
    const thread = await this.readThreadNote(this.singleThreadedPath(channel, name, subject));
    if (!thread) return { entries: [], grantKeys: [] }; // no thread note yet (first turn) → no roles.
    const paths = parseLoadoutPaths(thread.metadata?.roles);
    if (paths.length === 0) return { entries: [], grantKeys: [] };
    const entries: { path: string; content: string }[] = [];
    const grantKeys: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      let note: { metadata?: Record<string, unknown>; content?: string; tags?: unknown } | undefined;
      try {
        note = await this.readThreadNote(path);
      } catch (err) {
        console.warn(
          `parachute-agent: role note "${path}" read failed (skipping): ${(err as Error).message}`,
        );
        continue;
      }
      if (!note) {
        // 404 — a stale/renamed role path. Skip-and-warn (never throw); the def-load discipline.
        console.warn(`parachute-agent: role note "${path}" not found (skipping)`);
        continue;
      }
      // CONTENT (layer ①) — loaded for EVERY resolvable role path. A blank body is returned;
      // the composer skips it. Loading content never escalates — only the gated `wants:` below does.
      entries.push({ path, content: typeof note.content === "string" ? note.content : "" });
      // THE SECURITY GATE: honor `wants:` ONLY when the note is an `#agent/role`. A non-role
      // note's `wants:` returns null here → contributes context but never a grant source.
      const wants = roleWants(note);
      if (!wants) {
        // Observability: an `#agent/role` note whose `wants:` is present but unparseable
        // contributes no grants this turn. The reconcile path (POST /api/vault/role) stamps
        // `status:error` on save — the primary surface — but warn here too so an operator can
        // diagnose "my role stopped granting" from the daemon log. A non-role note (the gate)
        // or a role with no `wants:` is silent (expected, not an error).
        if (
          note.metadata?.wants !== undefined &&
          note.metadata?.wants !== null &&
          isRoleNote(note) // only warn for ROLES with bad wants, never plain (gated-out) notes.
        ) {
          console.warn(
            `parachute-agent: loaded role "${path}" has an unusable wants: — contributing no grants ` +
              `this turn (the role-save reconcile stamps status:error; check the note's wants:).`,
          );
        }
        continue;
      }
      const key = rolePathKey(path);
      if (seen.has(key)) continue;
      seen.add(key);
      grantKeys.push(key);
    }
    return { entries, grantKeys };
  }

  // react / edit / download: vault has no reactions; v1 is reply-only. Omitted.

  // -------------------------------------------------------------------------
  // Transcript — read the durable store the chat + Telegram + any vault surface
  // all share. The chat polls this; on send it writes an inbound note (below).
  // -------------------------------------------------------------------------

  /**
   * Read this channel's whole transcript (both directions) from the vault and
   * map it to `ChannelMessage[]`, sorted ascending by `ts`.
   *
   * The query is the canonical "list a channel's transcript" shape from the
   * tagging model: the parent message tag (carried literally on every note) + a
   * routing-key filter (`noteAgentKey(meta) == <this channel>`). Because the parent
   * is on every note, this returns BOTH inbound and outbound — the slash children are
   * namespace, not query inheritance, so we never key off them here.
   *
   *   GET <vaultUrl>/vault/<vault>/api/notes
   *       ?tag=agent%2Fmessage             (the `/` MUST be percent-encoded)
   *       &include_content=true               (we need the bodies)
   *       &limit=<n>                          (default 200)
   *
   * The vault returns a bare JSON array of note objects ({id, content, tags,
   * metadata, ...}). Direction comes from `metadata.direction`, falling back to
   * the inbound/outbound CHILD tag if the metadata field is missing. On a non-ok
   * vault response we throw with a clear message — the daemon route maps it to an
   * error the chat surfaces (no silent empty transcript).
   */
  async loadTranscript(opts?: { limit?: number }): Promise<ChannelMessage[]> {
    const channel = this.channel;
    const limit = opts?.limit ?? 200;
    // Query by the parent TAG only and filter to this channel CLIENT-SIDE. We do
    // NOT use the `?metadata={channel:{eq:...}}` operator filter: an operator
    // query on `channel` requires that field to be declared `indexed: true` in the
    // vault's tag schema, which we can't assume (the vault returns HTTP 400
    // FIELD_NOT_INDEXED otherwise). Tagging-both + client-side filter is the
    // module's index-free floor (same philosophy as the tag-both write) — it works
    // on any vault with no per-vault schema setup. (Declaring the channel field
    // indexed is a future scale optimization, not a requirement.)
    //
    // Because the tag query returns notes across ALL channels, OVERFETCH so this
    // channel's recent history isn't crowded out by other channels' interleaved
    // notes, then keep the most recent `limit` for this channel below.
    const fetchLimit = Math.min(Math.max(limit * 4, 500), 2000);

    type RawNote = {
      id?: string;
      content?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    };

    // Fetch one parent tag's notes; throws with a clear message on a non-ok vault
    // response or bad JSON (the daemon maps it to a surfaced error — no silent
    // empty transcript).
    const fetchByTag = async (tag: string): Promise<RawNote[]> => {
      const params = new URLSearchParams();
      params.set("tag", tag); // URLSearchParams encodes `/` → `%2F`
      params.set("include_content", "true");
      params.set("limit", String(fetchLimit));
      const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;
      const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `vault transport: load transcript failed (${res.status}) ${detail}`.trim(),
        );
      }
      try {
        const parsed = (await res.json()) as unknown;
        // The structured-query route returns a bare array; tolerate a `{notes:[]}`
        // envelope too in case a future shape wraps it.
        return Array.isArray(parsed)
          ? (parsed as RawNote[])
          : ((parsed as { notes?: RawNote[] })?.notes ?? []);
      } catch (err) {
        throw new Error(
          `vault transport: load transcript — bad JSON from vault: ${(err as Error).message}`,
        );
      }
    };

    // Query the single `#agent/message` parent tag (the channel→agent CONTRACT
    // dropped the legacy `#channel-message` / interim `#agent-message` union).
    const notes = await fetchByTag(AGENT_MESSAGE_TAG);

    const messages: ChannelMessage[] = [];
    for (const note of notes) {
      if (typeof note.id !== "string" || !note.id) continue;
      const meta = note.metadata ?? {};
      // Client-side routing-key filter (see the index-free note above): keep only
      // notes whose routing key matches this channel (`noteAgentKey` reads `agent`).
      if (noteAgentKey(meta) !== channel) continue;
      const tags = note.tags ?? [];
      // Direction: prefer the explicit metadata field; fall back to the outbound child tag.
      let direction: "inbound" | "outbound";
      if (meta.direction === "inbound" || meta.direction === "outbound") {
        direction = meta.direction;
      } else if (tags.includes(AGENT_MESSAGE_OUTBOUND_TAG)) {
        direction = "outbound";
      } else {
        // Default to inbound (a human message) when neither signal is present —
        // it renders as "you", the safe default for an unlabeled note.
        direction = "inbound";
      }
      const msg: ChannelMessage = {
        id: note.id,
        text: typeof note.content === "string" ? note.content : "",
        direction,
        sender: typeof meta.sender === "string" ? meta.sender : "",
        ts: typeof meta.ts === "string" ? meta.ts : "",
      };
      if (typeof meta.in_reply_to === "string") msg.inReplyTo = meta.in_reply_to;
      messages.push(msg);
    }
    // Ascending by ts; notes with no ts sort first (stable, deterministic).
    messages.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    // Keep the most recent `limit` for this channel (we overfetched the tag).
    return messages.length > limit ? messages.slice(messages.length - limit) : messages;
  }

  /**
   * Write a human→session INBOUND note — the chat's "send". This mirrors
   * `reply()` exactly except the tags + direction: the inbound CHILD tag
   * (`#agent/message/inbound`) is what the vault trigger fires on, so writing
   * this note WAKES the subscribed session via the existing vault trigger. We do
   * NOT also `ctx.emit` — that would double-wake (one wake from the trigger, one
   * from here). The trigger is the single wake path; this is purely the write.
   *
   * Returns the created note id so the chat can dedup its optimistic local echo
   * against the same id when the note round-trips through the next poll.
   */
  async writeInbound(
    text: string,
    sender?: string,
    /**
     * Extra metadata to STAMP onto the inbound note (e.g. the agent-to-agent callback
     * contract). Merged AFTER the base fields but BEFORE the non-overridable invariants
     * (`agent`/`direction` always win — an inbound note must route + be inbound). A caller
     * must NEVER pass `reply_to` here for a CALLBACK note (the terminal-callback loop guard);
     * see {@link writeCallback}.
     */
    extraMeta?: Record<string, string>,
  ): Promise<{ id: string }> {
    const channel = this.channel;
    const ts = new Date().toISOString();
    const id = crypto.randomUUID();
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `${this.pathPrefix}/${safeChannel}/${id}`;

    const metadata: Record<string, string> = {
      // Caller-supplied extra fields first, so the invariants below cannot be clobbered.
      ...(extraMeta ?? {}),
      // The routing key under `metadata.agent` ONLY (the channel→agent CONTRACT
      // dropped the `channel` dual-write). This is the inbound path the vault trigger
      // fires on — the trigger keys on `has_metadata:["agent"]` to match it.
      agent: channel,
      direction: "inbound",
      sender: sender ?? "operator",
      ts,
    };

    const res = await fetch(`${this.vaultUrl}/vault/${this.vault}/api/notes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        content: text,
        path,
        // Parent (queryable membership) + inbound child (the trigger discriminator
        // that wakes the session). Both literal — the child alone is invisible to
        // a `tag:#agent/message` query.
        tags: [AGENT_MESSAGE_TAG, AGENT_MESSAGE_INBOUND_TAG],
        metadata,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `vault transport: write inbound failed (${res.status}) ${detail}`.trim(),
      );
    }

    let noteId: string = id;
    try {
      const created = (await res.json()) as { id?: string; note?: { id?: string } };
      noteId = created?.id ?? created?.note?.id ?? id;
    } catch {
      // Non-JSON / empty body — keep the proposed id.
    }
    return { id: noteId };
  }

  /**
   * Inject an inbound message AUTHORED BY THE RUNNER (a scheduled job firing) —
   * design `2026-06-17-runner-scheduled-agent-turns.md`. This is the runner's
   * ONLY seam into the transport: a scheduled job is "an automated human," so
   * firing it = writing an inbound note exactly like a human typing in chat. The
   * existing vault trigger → agent-turn → outbound flow does the rest; the runner
   * never touches the turn.
   *
   * Mechanically this is `writeInbound` with runner provenance: BOTH the parent
   * `#agent/message` (queryable) and the inbound child `#agent/message/inbound`
   * (the trigger discriminator that wakes the session), `direction: "inbound"`,
   * and `sender` defaulting to a `runner:<jobId>` marker so the transcript shows
   * who authored it. We deliberately do NOT stamp `channel_inbound_rendered_at`
   * (so the trigger fires), and we do NOT `ctx.emit` (the trigger is the single
   * wake path — emitting too would double-wake). Reuses the channel's existing
   * `vault:<name>:write` token — the runner mints nothing and adds no authority.
   *
   * Returns the created note id (for logging / the "run now" response). Kept a
   * thin wrapper over `writeInbound` so the inbound write path has ONE
   * implementation; only the default sender differs.
   */
  async injectInbound(opts: {
    content: string;
    sender?: string;
    /**
     * SUBJECT (roles×threads NOW slice) — the thread axis for a runner-fired turn.
     * When a job carries a subject, the runner threads it here; it's stamped onto the
     * inbound note's `metadata.subject` (via {@link writeInbound}'s `extraMeta`) so the
     * turn's composed prompt + (NEXT) thread routing can read it. Absent/empty → NO
     * `subject` field on the note (today's behavior exactly — the weave job is unaffected).
     */
    subject?: string;
  }): Promise<{ id: string }> {
    const subject = opts.subject?.trim();
    const extraMeta = subject ? { subject } : undefined;
    return this.writeInbound(opts.content, opts.sender ?? "runner", extraMeta);
  }

  /**
   * Write an agent-to-agent CALLBACK as an INBOUND note on THIS channel — the "reply_to"
   * substrate. A recipient agent's drain, on turn completion, calls this on the SENDER's
   * channel transport (resolved by the daemon's buildWriteCallback) so the sender is woken
   * with a completion notification through the NORMAL inbound path: this writes a
   * `#agent/message/inbound` note (parent + inbound child tags), the vault trigger fires,
   * webhooks back, and the daemon routes it to the sender's agent — exactly like a human's
   * chat send. The callback `content` is a brief notification + link; the metadata is the
   * {@link CallbackMetadata} contract (`source_*` for the orchestrator to PULL the result).
   *
   * LOOP GUARD (structural): we stamp the callback metadata but NEVER a `reply_to` — a
   * callback is terminal, so handling it can't auto-trigger another callback. We defensively
   * STRIP any `reply_to` from the incoming meta to make that invariant impossible to violate
   * even if a caller mistakenly supplied one. `sender` is a `callback:<source_channel>`
   * marker so the transcript shows who/what authored it.
   *
   * Reuses {@link writeInbound} (the one inbound-write implementation), passing the callback
   * fields as its `extraMeta`. Returns the written note id.
   */
  async writeCallback(content: string, meta: CallbackMetadata): Promise<{ sent: string[] }> {
    // Defense-in-depth: never let a `reply_to` ride on a callback note (the terminal-callback
    // loop guard). The CallbackMetadata type has no reply_to, but we strip explicitly in case
    // a future caller widens the shape — a callback that carries reply_to would ping-pong.
    const { reply_to: _stripReplyTo, ...safe } = meta as CallbackMetadata & { reply_to?: string };
    void _stripReplyTo;
    const extraMeta: Record<string, string> = {
      callback: safe.callback,
      status: safe.status,
      source_channel: safe.source_channel,
      source_thread: safe.source_thread,
      delegation_depth: safe.delegation_depth,
      ...(safe.source_message ? { source_message: safe.source_message } : {}),
      ...(safe.correlation_id ? { correlation_id: safe.correlation_id } : {}),
    };
    const { id } = await this.writeInbound(content, `callback:${safe.source_channel}`, extraMeta);
    return { sent: [id] };
  }

  // -------------------------------------------------------------------------
  // Channel-queue inbound notes — the durable queue a CHANNEL-backend agent's
  // connected session pulls from (design 2026-06-18-channel-backend.md). The
  // inbound `#agent/message/inbound` notes themselves ARE the queue; the claim
  // `status` (pending | in-flight | handled) lives on each note so the vault is
  // the source of truth (restart-safe). These methods own the vault I/O (URL +
  // token + encoding) so the AttachedQueueRegistry stays storage-agnostic — the
  // same separation jobs.ts has from the job-note I/O. The channel's existing
  // `vault:<name>:write` token covers GET + the status PATCH; no new mint.
  // -------------------------------------------------------------------------

  /**
   * List THIS channel's INBOUND queue notes (the `#agent/message/inbound` notes),
   * ascending by `ts` (oldest first), carrying the claim `status`/`claimedAt`/`updatedAt`.
   * The query is index-free, mirroring {@link loadTranscript}: query by the inbound
   * CHILD tag (we want inbound only — outbound replies are not queue items) and
   * filter to this channel CLIENT-SIDE on `metadata.channel` (we don't assume a
   * `channel` index). A note with NO `status` field reads as `pending` (a fresh
   * inbound the trigger just created). Throws on a non-ok vault response so the
   * caller surfaces a clear error rather than a silently-empty queue.
   *
   * QUEUE-CAP TRUNCATION FIX (agent#103). Over time `handled` notes accumulate; the
   * tag query is capped (the vault limit), so once enough `handled` notes precede the
   * still-`pending` ones, the pending notes fall OUTSIDE the cap and are never claimed
   * (a silently-stuck queue). The vault's `status` metadata isn't indexed (we can't
   * assume a per-vault schema), so we can't filter `status:pending` server-side. So we
   * EXCLUDE `handled` notes CLIENT-SIDE — the live queue is only `pending` + `in-flight`
   * — and additionally REQUEST the cap descending (newest first) so when the raw note
   * count itself exceeds the cap, it's the OLDEST `handled` notes that get dropped, never
   * a recent `pending`. The two together keep the actionable queue (pending + in-flight)
   * intact regardless of how many `handled` notes have piled up. (Declaring `status`
   * indexed for a true server-side `status != handled` filter is a future scale
   * optimization, not a correctness requirement.)
   */
  async listInboundQueue(opts?: { limit?: number }): Promise<InboundQueueNote[]> {
    const channel = this.channel;
    const limit = opts?.limit ?? 200;
    // Overfetch (the tag query spans all channels) then keep this channel's items.
    const fetchLimit = Math.min(Math.max(limit * 4, 500), 2000);
    const params = new URLSearchParams();
    params.set("tag", AGENT_MESSAGE_INBOUND_TAG); // → agent%2Fmessage%2Finbound
    params.set("include_content", "true");
    params.set("limit", String(fetchLimit));
    // NEWEST-first at the vault (default order_by is `updated_at`) so a hard cap drops
    // the OLDEST notes (the long-settled `handled` ones), never a recent pending. We
    // re-sort ascending below for the queue. The vault param is `sort` (asc|desc).
    params.set("sort", "desc");
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: list inbound queue failed (${res.status}) ${detail}`.trim());
    }
    type RawNote = {
      id?: string;
      content?: string;
      metadata?: Record<string, unknown>;
      updated_at?: string;
      updatedAt?: string;
    };
    let notes: RawNote[];
    try {
      const parsed = (await res.json()) as unknown;
      notes = Array.isArray(parsed)
        ? (parsed as RawNote[])
        : ((parsed as { notes?: RawNote[] })?.notes ?? []);
    } catch (err) {
      throw new Error(
        `vault transport: list inbound queue — bad JSON from vault: ${(err as Error).message}`,
      );
    }
    const out: InboundQueueNote[] = [];
    for (const note of notes) {
      if (typeof note.id !== "string" || !note.id) continue;
      const meta = note.metadata ?? {};
      if (noteAgentKey(meta) !== channel) continue; // client-side filter (index-free); noteAgentKey reads `agent` (channel fallback for stragglers).
      const status = coerceInboundStatus(meta[STATUS_META_KEY]);
      // Drop `handled` notes — they are not queue items (#103). Only pending + in-flight
      // make up the actionable queue; counting/returning handled would let them crowd
      // the live queue out of the cap.
      if (status === "handled") continue;
      const updatedAt =
        typeof note.updated_at === "string"
          ? note.updated_at
          : typeof note.updatedAt === "string"
            ? note.updatedAt
            : undefined;
      out.push({
        id: note.id,
        text: typeof note.content === "string" ? note.content : "",
        sender: typeof meta.sender === "string" ? meta.sender : "",
        ts: typeof meta.ts === "string" ? meta.ts : "",
        status,
        ...(typeof meta[CLAIMED_AT_META_KEY] === "string"
          ? { claimedAt: meta[CLAIMED_AT_META_KEY] as string }
          : {}),
        ...(updatedAt ? { updatedAt } : {}),
      });
    }
    // Ascending by ts; blank-ts notes sort first (stable, deterministic).
    out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return out;
  }

  /**
   * PATCH an inbound note's claim status (+ optionally `claimedAt`), by note id.
   * Sends ONLY the changed metadata; the vault MERGES it, so the channel/direction/
   * sender/ts are preserved. Passing `claimedAt: null` CLEARS the field (written as
   * an empty string) — used on release/handled so a stale claim timestamp doesn't
   * linger.
   *
   * COMPARE-AND-SWAP (agent#101). When `ifUpdatedAt` is given, the PATCH carries
   * `if_updated_at` (the note's last-seen `updated_at`) as the vault's optimistic-
   * concurrency precondition instead of `force: true` — so a CLAIM only lands if the
   * note hasn't changed since it was read. A STALE precondition (another session
   * already claimed it) makes the vault return **409** (`conflict`); an ABSENT one (if
   * the note carried no `updated_at` to send) would 428 — either way we throw
   * {@link InboundClaimConflictError} so the caller re-lists and skips to the next
   * pending message rather than double-claiming. When `ifUpdatedAt` is OMITTED (the
   * release/handled/sweep paths, which are last-write-wins by design) the PATCH uses
   * `force: true` as before. Any OTHER non-ok status throws a plain Error.
   */
  async setInboundStatus(
    id: string,
    status: InboundStatus,
    claimedAt?: string | null,
    ifUpdatedAt?: string,
  ): Promise<void> {
    const metadata: Record<string, string> = { [STATUS_META_KEY]: status };
    if (claimedAt !== undefined) {
      metadata[CLAIMED_AT_META_KEY] = claimedAt === null ? "" : claimedAt;
    }
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(id)}`;
    // CAS when an `ifUpdatedAt` precondition is supplied; otherwise last-write-wins via
    // `force` (the prior behavior, kept for release/handled/sweep).
    const body =
      ifUpdatedAt !== undefined
        ? { metadata, if_updated_at: ifUpdatedAt }
        : { metadata, force: true };
    const res = await fetch(url, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 409 (stale precondition) / 428 (precondition required) on a CAS attempt = the
      // claim race was lost → a typed conflict the caller re-lists on.
      if (ifUpdatedAt !== undefined && (res.status === 409 || res.status === 428)) {
        throw new InboundClaimConflictError(id, res.status);
      }
      const detail = await res.text().catch(() => "");
      throw new Error(
        `vault transport: set inbound status ${id} failed (${res.status}) ${detail}`.trim(),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Scheduled-job notes — the runner's VAULT-NATIVE job store (design
  // 2026-06-17). A job IS a `#agent/job` note in THIS channel's vault. These
  // methods own the vault I/O (URL + token + encoding) so jobs.ts stays a thin,
  // storage-agnostic facade — token handling lives in ONE place (the transport),
  // mirroring loadTranscript / writeInbound. The channel's existing
  // `vault:<name>:write` token covers all of GET/POST/PATCH/DELETE — no new mint.
  // -------------------------------------------------------------------------

  /**
   * List the scheduled-job notes in THIS channel's vault. Queries by the parent
   * `#agent/job` tag (URLSearchParams encodes `/`→`%2F`) and returns ALL job
   * notes in the vault — the CALLER filters by `metadata.channel` (same index-free
   * pattern as loadTranscript; we don't assume a `channel` index exists). Throws
   * on a non-ok vault response so the API surfaces a clear error rather than a
   * silently-empty list.
   */
  async listJobNotes(opts?: { limit?: number }): Promise<JobNote[]> {
    const limit = opts?.limit ?? 500;
    const params = new URLSearchParams();
    params.set("tag", AGENT_JOB_TAG); // → agent%2Fjob
    params.set("include_content", "true");
    params.set("limit", String(limit));
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: list jobs failed (${res.status}) ${detail}`.trim());
    }
    let notes: Array<{ id?: string; content?: string; metadata?: Record<string, unknown> }>;
    try {
      const parsed = (await res.json()) as unknown;
      notes = Array.isArray(parsed)
        ? (parsed as typeof notes)
        : ((parsed as { notes?: typeof notes })?.notes ?? []);
    } catch (err) {
      throw new Error(`vault transport: list jobs — bad JSON from vault: ${(err as Error).message}`);
    }
    const jobs: JobNote[] = [];
    for (const note of notes) {
      if (typeof note.id !== "string" || !note.id) continue;
      const m = note.metadata ?? {};
      const channel = noteAgentKey(m) ?? ""; // routing key via noteAgentKey (`agent`, channel fallback for stragglers).
      const cron = typeof m.cron === "string" ? m.cron : "";
      if (!channel || !cron) continue; // not a well-formed job note; skip.
      // The operator-facing id is the slug in `metadata.jobId`; fall back to the
      // note id for a note written before that field existed.
      const slug = typeof m.jobId === "string" && m.jobId ? m.jobId : note.id;
      const job: JobNote = {
        id: slug,
        noteId: note.id,
        message: typeof note.content === "string" ? note.content : "",
        channel,
        cron,
        // The vault stores metadata as strings; "false" (and only "false") disables.
        enabled: String(m.enabled) !== "false",
      };
      if (typeof m.tz === "string" && m.tz) job.tz = m.tz;
      if (typeof m.createdAt === "string") job.createdAt = m.createdAt;
      if (typeof m.lastRunAt === "string") job.lastRunAt = m.lastRunAt;
      if (typeof m.lastStatus === "string") job.lastStatus = m.lastStatus;
      // roles×threads NOW slice: read the thread subject back (absent/blank → undefined).
      // Trim-guarded symmetrically with the write side (upsertJobNote) so a whitespace-only
      // value that somehow landed in the vault can't propagate downstream as a "subject".
      if (typeof m.subject === "string" && m.subject.trim()) job.subject = m.subject.trim();
      jobs.push(job);
    }
    return jobs;
  }

  /**
   * Create OR replace a job note at a deterministic path (`Channels/<ch>/jobs/<id>`)
   * so an upsert by the same job id overwrites in place. The vault upserts by path
   * on POST. Returns the created/updated note id. `nextRunAt` is NEVER written
   * (recomputed in memory by the runner).
   */
  async upsertJobNote(job: {
    id: string;
    message: string;
    channel: string;
    cron: string;
    tz?: string;
    enabled: boolean;
    createdAt: string;
    lastRunAt?: string;
    lastStatus?: string;
    /** The thread subject a fire carries (roles×threads NOW slice); absent → no field. */
    subject?: string;
  }): Promise<{ id: string }> {
    const safeId = job.id.replace(/[^a-zA-Z0-9_-]/g, "-");
    const safeChannel = job.channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `${JOB_PATH_PREFIX}/${safeChannel}/jobs/${safeId}`;
    const metadata: JobNoteMetadata = {
      jobId: job.id, // the operator-facing slug, so it survives the vault's note-id assignment.
      // The routing key under `metadata.agent` ONLY (the channel→agent CONTRACT).
      agent: job.channel,
      cron: job.cron,
      enabled: job.enabled ? "true" : "false",
      createdAt: job.createdAt,
    };
    if (job.tz) metadata.tz = job.tz;
    if (job.lastRunAt) metadata.lastRunAt = job.lastRunAt;
    if (job.lastStatus) metadata.lastStatus = job.lastStatus;
    // roles×threads NOW slice: persist a non-empty subject; absent → no field (the weave
    // job writes none, so its note is byte-identical to HEAD).
    if (typeof job.subject === "string" && job.subject.trim().length > 0) {
      metadata.subject = job.subject.trim();
    }

    const res = await fetch(`${this.vaultUrl}/vault/${this.vault}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ content: job.message, path, tags: [AGENT_JOB_TAG], metadata }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: write job failed (${res.status}) ${detail}`.trim());
    }
    let noteId = path;
    try {
      const created = (await res.json()) as { id?: string; note?: { id?: string } };
      noteId = created?.id ?? created?.note?.id ?? path;
    } catch {
      // Non-JSON / empty body — keep the path as the addressable id.
    }
    return { id: noteId };
  }

  /**
   * PATCH a job note's bookkeeping metadata (lastRunAt / lastStatus) after a fire,
   * by note id. We send ONLY the changed metadata fields; the vault merges them.
   * Best-effort on the runner's side (a failed status-write is logged, not fatal),
   * so this throws and the caller decides — the runner swallows it.
   */
  async patchJobNote(
    id: string,
    fields: { lastRunAt?: string; lastStatus?: string; enabled?: boolean },
  ): Promise<void> {
    const metadata: Record<string, string> = {};
    if (fields.lastRunAt !== undefined) metadata.lastRunAt = fields.lastRunAt;
    if (fields.lastStatus !== undefined) metadata.lastStatus = fields.lastStatus;
    if (fields.enabled !== undefined) metadata.enabled = fields.enabled ? "true" : "false";
    const res = await fetch(
      `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        // `force: true` satisfies the vault's mutation precondition (428 without
        // `if_updated_at`/`force`). Safe: lastRunAt/lastStatus/enabled are the
        // runner's OWN bookkeeping fields, no content in the body, and the vault
        // MERGES metadata so the job's cron/message/etc. are preserved. (Without
        // this the runner's status-write silently 428'd.)
        body: JSON.stringify({ metadata, force: true }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: patch job failed (${res.status}) ${detail}`.trim());
    }
  }

  /** Delete a job note by id. Throws on a non-ok vault response. */
  async deleteJobNote(id: string): Promise<void> {
    const res = await fetch(
      `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(id)}`,
      { method: "DELETE", headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`vault transport: delete job failed (${res.status}) ${detail}`.trim());
    }
  }

  // -------------------------------------------------------------------------
  // Inbound — the daemon's webhook hands us a new inbound note to deliver.
  // -------------------------------------------------------------------------

  /**
   * Fetch the attachment list for an inbound note from the vault REST API
   * (`GET <vaultUrl>/vault/<vault>/api/notes/<id>/attachments`, Bearer the channel's
   * existing vault token). Returns the surfaced {@link InboundAttachment} refs (one per
   * vault attachment that carries a usable `path`), or `[]` on ANY failure (best-effort —
   * a missing/unreachable attachment list must NEVER drop the inbound message; the turn
   * still runs with the text). The note id is percent-encoded as one path segment.
   *
   * Phase 1: the bytes are NOT fetched here — the programmatic backend stages them from
   * `<vaultUrl>/.../api/storage/<path>` into the agent's private workspace. This method
   * only surfaces the refs (path/mimeType/filename).
   */
  async fetchInboundAttachments(noteId: string): Promise<InboundAttachment[]> {
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes/${encodeURIComponent(noteId)}/attachments`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.token}` } });
    } catch (err) {
      console.warn(
        `parachute-agent: fetch attachments for inbound note ${noteId} errored (proceeding ` +
          `with text only): ${(err as Error).message}`,
      );
      return [];
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(
        `parachute-agent: fetch attachments for inbound note ${noteId} failed (${res.status}) ` +
          `${detail} — proceeding with text only`.trim(),
      );
      return [];
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      console.warn(
        `parachute-agent: fetch attachments for inbound note ${noteId} — bad JSON (proceeding ` +
          `with text only): ${(err as Error).message}`,
      );
      return [];
    }
    // Tolerate a bare array OR an `{ attachments: [...] }` envelope.
    const list: Array<{ path?: unknown; mimeType?: unknown; mime_type?: unknown }> = Array.isArray(raw)
      ? (raw as typeof list)
      : (((raw as { attachments?: unknown }).attachments as typeof list | undefined) ?? []);
    const out: InboundAttachment[] = [];
    for (const a of list) {
      const path = typeof a.path === "string" ? a.path : "";
      if (!path) continue; // no storage path → nothing to fetch later; skip.
      const mimeType =
        typeof a.mimeType === "string"
          ? a.mimeType
          : typeof a.mime_type === "string"
            ? a.mime_type
            : "application/octet-stream";
      out.push({ path, mimeType, filename: basenameOf(path) });
    }
    return out;
  }

  /**
   * Deliver an inbound `#agent/message/inbound` note onto this channel: emit it
   * so the subscribed bridge / MCP session wakes. Called by the daemon's
   * `/api/vault/inbound` webhook after it has resolved the channel.
   *
   * Belt-and-suspenders over the trigger predicate: a note tagged outbound
   * (`#agent/message/outbound`) OR explicitly `direction: "outbound"` is IGNORED —
   * we never wake on our own reply, even if a mis-wired trigger delivers one.
   *
   * ATTACHMENTS (Phase 1). When the note carries attachments inline (the vault
   * `send: "json"` trigger payload includes `note.attachments`), we fetch the
   * authoritative attachment list (REST) and surface the refs on the emitted
   * {@link InboundMessage.attachments} so the programmatic backend can stage the
   * bytes for the turn. The fetch is best-effort: a failure logs + the message is
   * still emitted with the text (never dropped). When the note has NO attachments
   * inline, NO fetch happens and emit is SYNCHRONOUS (today's behavior unchanged) —
   * the only async path is the attachments-present case.
   */
  async ingestInbound(note: InboundNote): Promise<void> {
    if (!this.ctx) throw new Error("vault transport: not started");
    const meta = note.metadata ?? {};
    const tags = note.tags ?? [];
    if (tags.includes(AGENT_MESSAGE_OUTBOUND_TAG) || meta.direction === "outbound") {
      return; // our own reply — never wake on it.
    }
    // Flatten the note's metadata into the inbound meta (string-valued), then
    // stamp our own provenance fields. `source`/`note_id`/`direction` are set
    // explicitly so they win over anything in the note's metadata. `subject` is
    // SKIPPED here and handled explicitly below (normalized to non-empty-or-absent),
    // so a blank `subject: "   "` can't slip through the raw spread — absent and
    // whitespace-only must be indistinguishable downstream (the null-subject invariant).
    const flatMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (k === "subject") continue;
      flatMeta[k] = typeof v === "string" ? v : String(v);
    }

    // Only reach for the attachment list when the inline payload signals there ARE
    // attachments — so the no-attachment path emits WITHOUT a network round-trip (and
    // stays synchronous-before-await, preserving the existing fire-and-forget callers).
    const hasInline =
      Array.isArray(note.attachments) &&
      note.attachments.some((a) => typeof a?.path === "string" && a.path.length > 0);
    let attachments: InboundAttachment[] = [];
    if (hasInline) {
      attachments = await this.fetchInboundAttachments(note.id);
    }

    // SUBJECT (roles×threads NOW slice). The thread axis: when the inbound note
    // carries a non-empty string `metadata.subject`, surface it onto the emitted
    // event meta so it can flow through the queue → composed prompt → (NEXT) thread
    // routing. ABSENT/empty → no `subject` field on the emitted meta, so the emit is
    // BYTE-IDENTICAL to HEAD (the null-subject invariant — the weave path is untouched).
    // `subject` is deliberately SKIPPED in the `flatMeta` spread above and re-added here
    // ONLY when non-empty, so an empty/whitespace-only value can never leak through —
    // absent and blank are indistinguishable downstream.
    const rawSubject = meta.subject;
    const subject =
      typeof rawSubject === "string" && rawSubject.trim().length > 0 ? rawSubject : undefined;

    this.ctx.emit({
      // `channel` here is the in-memory InboundMessage.channel TS field (NOT serialized
      // note metadata) — left as the channel name. The routing key rides in `meta.agent`.
      channel: this.ctx.channel,
      content: note.content ?? "",
      meta: {
        ...flatMeta,
        // The routing key on the in-memory event meta under `agent` ONLY (the
        // channel→agent CONTRACT dropped the `channel` dual-write).
        agent: this.ctx.channel,
        source: "vault",
        note_id: note.id,
        sender: typeof meta.sender === "string" ? meta.sender : "",
        direction: "inbound",
        ...(subject ? { subject } : {}),
      },
      source: "vault",
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }
}
