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
 * conversation turn), `#agent/job` (a scheduled trigger). Vault-native agents
 * (Phase 4a) moved the flat `#agent-message*` / `#agent-job` tags into this
 * namespace (`#agent/message*` / `#agent/job`).
 *
 * TAG RENAME — DUAL-READ (the EARLIER channel→agent rename,
 * `parachute-patterns/migrations/2026-06-17-channel-to-agent.md` rule 2). The
 * message tag first moved `#channel-message*` → `#agent-message*`, and now
 * `#agent-message*` → `#agent/message*`. We WRITE only the NEWEST `#agent/message*`
 * tags going forward, but on READ we recognize BOTH the legacy `#channel-message*`
 * AND the interim `#agent-message*` tags — so all pre-namespace history still loads
 * in the transcript and a still-live legacy trigger (delivering an old-tagged note)
 * still routes. A one-time re-tag run + the legacy trigger's re-registration are
 * Aaron's-hand cutover steps; dual-read keeps everything working until then.
 *
 * How it differs from telegram / http-ui — the "external party" is the vault:
 *  - Inbound (human → session): a vault trigger POSTs the daemon's
 *    `/api/vault/inbound` webhook when a new `#agent/message/inbound` note
 *    appears; the daemon resolves the channel from `note.metadata.channel` and
 *    calls this transport's `ingestInbound(note)`, which `ctx.emit(...)`s →
 *    routes to the bridge / MCP session subscribed to that channel and wakes it.
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
 * `#agent/message/outbound` / the interim `#agent-message/outbound` / the legacy
 * `#channel-message/outbound` (or `direction: "outbound"`) — so even a mis-wired
 * trigger can never wake us on our own reply.
 */

import type {
  Transport,
  TransportContext,
  ReplyArgs,
} from "../transport.ts";

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
}

/** The note shape the daemon hands `ingestInbound` (a subset of the trigger payload). */
export interface InboundNote {
  id: string;
  content?: string;
  /** The note's tags — carries `#agent/message/{inbound,outbound}` (or the prior
   *  `#agent-message/*` / `#channel-message/*` on pre-namespace notes) for loop avoidance. */
  tags?: string[];
  metadata?: Record<string, unknown>;
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
}

/** The metadata payload written for a job note (all string-typed, per the vault). */
export interface JobNoteMetadata {
  /** The operator-facing slug (so the displayed id survives the vault's note-id assignment). */
  jobId: string;
  channel: string;
  cron: string;
  tz?: string;
  /** "true" | "false" — the vault stores metadata as strings. */
  enabled: string;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: string;
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

const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";
const DEFAULT_PATH_PREFIX = "channel";
/** Parent tag (NEW, namespaced) — carried LITERALLY on every note WE write; query
 *  this + metadata.channel to see BOTH directions of a channel (the slash children
 *  are namespace, not inheritance). */
const AGENT_MESSAGE_TAG = "#agent/message";
/** Inbound child (NEW) — the vault trigger fires on this exact tag (never matches outbound → no loop). */
const AGENT_MESSAGE_INBOUND_TAG = "#agent/message/inbound";
/** Outbound child (NEW) — replies carry this; the trigger's exact-match predicate excludes it. */
const AGENT_MESSAGE_OUTBOUND_TAG = "#agent/message/outbound";

// ---------------------------------------------------------------------------
// PRIOR tags (pre-namespace) — DUAL-READ only. We never WRITE these going forward,
// but we recognize them on READ so pre-namespace history loads + a still-live prior
// trigger keeps routing. See the file header (dual-read).
//
//  - LEGACY  `#channel-message*` — the original channel-era tag (the earliest
//    rename's prior layer).
//  - INTERIM `#agent-message*`    — the flat agent tag that preceded the `#agent/*`
//    namespace (the namespace migration's prior layer).
// ---------------------------------------------------------------------------
const LEGACY_MESSAGE_TAG = "#channel-message";
const LEGACY_MESSAGE_INBOUND_TAG = "#channel-message/inbound";
const LEGACY_MESSAGE_OUTBOUND_TAG = "#channel-message/outbound";
const INTERIM_MESSAGE_TAG = "#agent-message";
const INTERIM_MESSAGE_INBOUND_TAG = "#agent-message/inbound";
const INTERIM_MESSAGE_OUTBOUND_TAG = "#agent-message/outbound";

/** The message parent tags we recognize on READ (new + interim + legacy) — the
 *  transcript query unions all so pre-namespace history still appears. */
const READ_MESSAGE_TAGS = [AGENT_MESSAGE_TAG, INTERIM_MESSAGE_TAG, LEGACY_MESSAGE_TAG] as const;
/** The outbound child tags we recognize on READ (new + interim + legacy) for
 *  direction / loop-avoidance detection. */
const READ_OUTBOUND_TAGS = [
  AGENT_MESSAGE_OUTBOUND_TAG,
  INTERIM_MESSAGE_OUTBOUND_TAG,
  LEGACY_MESSAGE_OUTBOUND_TAG,
] as const;

/**
 * The module-owned root namespace tag. Declared (with the three children rolling up
 * to it via `parent_names`) so a human `tag:#agent` query expands to EVERYTHING the
 * module owns — definitions, messages, jobs. The module itself never queries by this
 * (it always queries the exact leaf tag); it exists for the nice human rollup, per
 * the design's namespacing decision.
 */
export const AGENT_ROOT_TAG = "#agent";

/**
 * Agent-definition tag — a vault-native agent IS a `#agent/definition` note (design
 * `2026-06-17-vault-native-agents.md`). The note BODY is the system prompt; the note
 * METADATA is the config (name, backend, workspace, isolation, the def-vault binding).
 * The module reads these notes from a def-vault and instantiates each as a live agent.
 */
export const AGENT_DEFINITION_TAG = "#agent/definition";

/**
 * Scheduled-job tag — the runner's vault-native job store (design
 * `2026-06-17-runner-scheduled-agent-turns.md`). A job IS a vault note carrying
 * this parent tag; queryable + durable + surface-renderable, exactly like
 * `#agent/message`. Introduced in Phase 2 as the flat `#agent-job`; moved into the
 * `#agent/*` namespace (`#agent/job`) by the vault-native-agents work (Phase 4a).
 */
const AGENT_JOB_TAG = "#agent/job";
/** Default path prefix under which job notes are written: `Channels/<ch>/jobs/<id>`. */
const JOB_PATH_PREFIX = "Channels";

/**
 * The tag schema this module manages in any vault it's connected to.
 *
 * This is the declarative complement to the "tag both parent + child" fail-safe
 * in `reply()` / inbound writes. A slash in a Parachute tag NAME is namespace-only
 * — it carries NO query inheritance. Inheritance is the `parent_names` graph,
 * declared via the vault's tag-schema API. We declare the full `#agent/*`
 * namespace rollup (design `2026-06-17-vault-native-agents.md`):
 *   - `#agent/definition`        → parent `#agent`
 *   - `#agent/message`           → parent `#agent`
 *   - `#agent/message/inbound`   → parent `#agent/message`
 *   - `#agent/message/outbound`  → parent `#agent/message`
 *   - `#agent/job`               → parent `#agent`
 * so a human `tag:#agent` query rolls up to EVERYTHING the module owns, and
 * `tag:#agent/message` rolls up to both directions — without the module's own
 * exact-leaf queries depending on per-vault schema.
 *
 * DUAL-READ: we ALSO keep declaring the prior `#agent-message*` (interim) and
 * `#channel-message*` (legacy) schema. Their parent/children inheritance must stay
 * declared so a UI querying an old parent still expands to pre-namespace children
 * until the one-time re-tag run completes. New writes use the namespaced tags; the
 * prior entries are read-side scaffolding, retired in a later contract cycle.
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
    name: AGENT_MESSAGE_TAG,
    parent_names: [AGENT_ROOT_TAG],
    description: "A message in a Parachute channel (parent of /inbound + /outbound).",
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
  },
  // --- Interim (dual-read) — the flat `#agent-message*` tags that preceded the
  //     `#agent/*` namespace. Declared so pre-namespace history keeps its
  //     inheritance until the one-time re-tag run lands. Never written going forward. ---
  {
    name: INTERIM_MESSAGE_TAG,
    description: "Interim flat message tag (pre #agent/* namespace); read-only — see #agent/message.",
  },
  {
    name: INTERIM_MESSAGE_INBOUND_TAG,
    parent_names: [INTERIM_MESSAGE_TAG],
    description: "Interim inbound message tag (pre-namespace); read-only.",
  },
  {
    name: INTERIM_MESSAGE_OUTBOUND_TAG,
    parent_names: [INTERIM_MESSAGE_TAG],
    description: "Interim outbound message tag (pre-namespace); read-only.",
  },
  // --- Legacy (dual-read) — declared so pre-rename history keeps its inheritance
  //     until the one-time re-tag run lands. Never written going forward. ---
  {
    name: LEGACY_MESSAGE_TAG,
    description: "Legacy message tag (pre channel→agent rename); read-only — see #agent/message.",
  },
  {
    name: LEGACY_MESSAGE_INBOUND_TAG,
    parent_names: [LEGACY_MESSAGE_TAG],
    description: "Legacy inbound message tag (pre-rename); read-only.",
  },
  {
    name: LEGACY_MESSAGE_OUTBOUND_TAG,
    parent_names: [LEGACY_MESSAGE_TAG],
    description: "Legacy outbound message tag (pre-rename); read-only.",
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
 * carries a `channel` metadata field and hasn't been rendered yet. Loop avoidance
 * is by the inbound CHILD tag: an outbound (reply) note carries
 * `#agent/message/outbound`, never the inbound child, so it never fires this.
 * (The `channel` metadata field + `channel_inbound_rendered_at` marker are the
 * internal routing plumbing — UNCHANGED by the rename; only the TAG moved.)
 */
export const AGENT_VAULT_TRIGGER_TEMPLATE = {
  name: "channel_inbound_<channel>", // hub substitutes the channel name
  events: ["created"],
  when: {
    tags: ["#agent/message/inbound"],
    has_metadata: ["channel"],
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
    tags: ["#agent/definition"],
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
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
    // Declare the tag schema this module manages in the connected vault. Strictly
    // best-effort: `ensureSchema` swallows all of its own errors, so an unreachable
    // vault or a failing PUT can NEVER block (or reject out of) `start()`. The
    // "tag both parent + child" floor in the note writes is the fail-safe, so the
    // channel works even if this declaration never lands. Fire-and-forget — no
    // reason to delay the channel coming up on a schema upsert.
    void this.ensureSchema();
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
   * and decodes it, the tag name — which contains BOTH `#` and `/`
   * (`#agent/message/inbound`) — must be `encodeURIComponent`'d so the `#`
   * becomes `%23` and the `/` becomes `%2F`; the route then decodes that back to
   * the literal name. A bare `/` in the URL would fail the `[^/]+` match → 404,
   * silently dropping the declaration. The PUT body is `{ description?, parent_names? }`.
   *
   * Best-effort + non-fatal by contract: every failure is caught and `console.warn`'d,
   * never thrown — the tag-both write floor is the fallback.
   */
  async ensureSchema(): Promise<void> {
    for (const entry of AGENT_VAULT_TAG_SCHEMA) {
      try {
        // Single-segment, percent-encoded name: `#agent/message/inbound` →
        // `%23agent%2Fmessage%2Finbound`. The vault decodes it back to the literal.
        const url = `${this.vaultUrl}/vault/${this.vault}/api/tags/${encodeURIComponent(entry.name)}`;
        const body: { description?: string; parent_names?: string[] } = {};
        if (entry.description !== undefined) body.description = entry.description;
        if (entry.parent_names !== undefined) body.parent_names = entry.parent_names;

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
      channel,
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
        // We WRITE only the NEW tags; dual-read recognizes legacy on read.
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
   * `metadata.channel == <this channel>` filter. Because the parent is on every
   * note, this returns BOTH inbound and outbound — the slash children are
   * namespace, not query inheritance, so we never key off them here.
   *
   * DUAL-READ: we union the NEW `#agent/message` parent, the interim
   * `#agent-message` parent, and the legacy `#channel-message` parent — three
   * queries deduped by note id — so pre-namespace history still appears alongside
   * new messages. We WRITE only the namespaced tag; this read-side union is dropped
   * in a later contract cycle.
   *
   *   GET <vaultUrl>/vault/<vault>/api/notes
   *       ?tag=%23agent%2Fmessage             (the `#` + `/` MUST be percent-encoded)
   *       &include_content=true               (we need the bodies)
   *       &limit=<n>                          (default 200)
   *   ... and again with ?tag=%23agent-message + ?tag=%23channel-message, unioned client-side.
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
      params.set("tag", tag); // URLSearchParams encodes `#` → `%23`
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

    // DUAL-READ: union the new + legacy parent tags, deduped by note id (a note
    // re-tagged to carry both must not appear twice).
    const byId = new Map<string, RawNote>();
    for (const tag of READ_MESSAGE_TAGS) {
      for (const note of await fetchByTag(tag)) {
        if (typeof note.id === "string" && note.id && !byId.has(note.id)) {
          byId.set(note.id, note);
        }
      }
    }
    const notes = [...byId.values()];

    const messages: ChannelMessage[] = [];
    for (const note of notes) {
      if (typeof note.id !== "string" || !note.id) continue;
      const meta = note.metadata ?? {};
      // Client-side channel filter (see the index-free note above): keep only
      // notes whose metadata.channel matches this channel.
      if (meta.channel !== channel) continue;
      const tags = note.tags ?? [];
      // Direction: prefer the explicit metadata field; fall back to the child tag
      // (new OR legacy outbound — dual-read).
      let direction: "inbound" | "outbound";
      if (meta.direction === "inbound" || meta.direction === "outbound") {
        direction = meta.direction;
      } else if (READ_OUTBOUND_TAGS.some((t) => tags.includes(t))) {
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
  async writeInbound(text: string, sender?: string): Promise<{ id: string }> {
    const channel = this.channel;
    const ts = new Date().toISOString();
    const id = crypto.randomUUID();
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `${this.pathPrefix}/${safeChannel}/${id}`;

    const metadata: Record<string, string> = {
      channel,
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
        // a `tag:#agent/message` query. We WRITE only the NEW tags.
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
  async injectInbound(opts: { content: string; sender?: string }): Promise<{ id: string }> {
    return this.writeInbound(opts.content, opts.sender ?? "runner");
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
   * `#agent/job` tag (URLSearchParams encodes `#`→`%23`, `/`→`%2F`) and returns ALL job
   * notes in the vault — the CALLER filters by `metadata.channel` (same index-free
   * pattern as loadTranscript; we don't assume a `channel` index exists). Throws
   * on a non-ok vault response so the API surfaces a clear error rather than a
   * silently-empty list.
   */
  async listJobNotes(opts?: { limit?: number }): Promise<JobNote[]> {
    const limit = opts?.limit ?? 500;
    const params = new URLSearchParams();
    params.set("tag", AGENT_JOB_TAG); // → %23agent%2Fjob
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
      const channel = typeof m.channel === "string" ? m.channel : "";
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
  }): Promise<{ id: string }> {
    const safeId = job.id.replace(/[^a-zA-Z0-9_-]/g, "-");
    const safeChannel = job.channel.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `${JOB_PATH_PREFIX}/${safeChannel}/jobs/${safeId}`;
    const metadata: JobNoteMetadata = {
      jobId: job.id, // the operator-facing slug, so it survives the vault's note-id assignment.
      channel: job.channel,
      cron: job.cron,
      enabled: job.enabled ? "true" : "false",
      createdAt: job.createdAt,
    };
    if (job.tz) metadata.tz = job.tz;
    if (job.lastRunAt) metadata.lastRunAt = job.lastRunAt;
    if (job.lastStatus) metadata.lastStatus = job.lastStatus;

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
        body: JSON.stringify({ metadata }),
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
   * Deliver an inbound `#agent/message/inbound` note onto this channel: emit it
   * so the subscribed bridge / MCP session wakes. Called by the daemon's
   * `/api/vault/inbound` webhook after it has resolved the channel.
   *
   * Belt-and-suspenders over the trigger predicate: a note tagged outbound — the
   * new `#agent/message/outbound` OR (dual-read) the interim `#agent-message/outbound`
   * / the legacy `#channel-message/outbound` — OR explicitly `direction: "outbound"`
   * is IGNORED — we never wake on our own reply, even if a mis-wired trigger delivers one.
   */
  ingestInbound(note: InboundNote): void {
    if (!this.ctx) throw new Error("vault transport: not started");
    const meta = note.metadata ?? {};
    const tags = note.tags ?? [];
    if (READ_OUTBOUND_TAGS.some((t) => tags.includes(t)) || meta.direction === "outbound") {
      return; // our own reply — never wake on it.
    }
    // Flatten the note's metadata into the inbound meta (string-valued), then
    // stamp our own provenance fields. `source`/`note_id`/`direction` are set
    // explicitly so they win over anything in the note's metadata.
    const flatMeta: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta)) {
      flatMeta[k] = typeof v === "string" ? v : String(v);
    }
    this.ctx.emit({
      channel: this.ctx.channel,
      content: note.content ?? "",
      meta: {
        ...flatMeta,
        source: "vault",
        note_id: note.id,
        sender: typeof meta.sender === "string" ? meta.sender : "",
        direction: "inbound",
      },
      source: "vault",
    });
  }
}
