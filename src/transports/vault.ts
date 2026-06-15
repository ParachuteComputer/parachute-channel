/**
 * vault transport for parachute-channel.
 *
 * A channel backed by `#channel-message` notes in a Parachute vault. The vault
 * becomes the persistence layer + the inter-module event bus; the channel is the
 * adapter that wakes a session on a new note and writes the session's reply back
 * as a note.
 *
 * How it differs from telegram / http-ui — the "external party" is the vault:
 *  - Inbound (human → session): a vault trigger POSTs the daemon's
 *    `/api/vault/inbound` webhook when a new `#channel-message/inbound` note
 *    appears; the daemon resolves the channel from `note.metadata.channel` and
 *    calls this transport's `ingestInbound(note)`, which `ctx.emit(...)`s →
 *    routes to the bridge / MCP session subscribed to that channel and wakes it.
 *  - Outbound (session → human): when the session calls the `reply` tool, the
 *    bridge POSTs `/api/reply {channel,...}`; the daemon dispatches to this
 *    transport's `reply()`, which writes a `#channel-message/outbound` note via
 *    the vault REST API (`POST <vaultUrl>/vault/<vault>/api/notes`).
 *
 * Tagging model — two ORTHOGONAL axes (this was a footgun; read carefully).
 * In a Parachute vault a slash in a tag NAME is a namespace convention only —
 * it implies NOTHING about query inheritance. `query-notes { tag: "X" }` matches
 * descendants by the `tags.parent_names` graph, which is declared explicitly via
 * `update-tag`, NOT inferred from the name. So a note tagged ONLY
 * `#channel-message/inbound` is INVISIBLE to a `tag: "#channel-message"` query
 * unless that inheritance was separately declared. We don't want to depend on
 * per-vault schema setup, so every note carries BOTH tags literally:
 *  - the parent `#channel-message` — the QUERYABLE membership tag (a UI lists a
 *    channel's whole transcript, both directions, with one `tag: "#channel-message"`
 *    + `metadata.channel` query, because the parent is literally present);
 *  - a directional child — the trigger DISCRIMINATOR (`#channel-message/inbound`
 *    on inbound, `#channel-message/outbound` on outbound).
 *
 * Loop avoidance (load-bearing). An outbound reply is itself a `#channel-message`
 * note; if the trigger fired on it the session would wake on its own reply forever.
 * The vault trigger predicate does EXACT tag membership, so it's keyed on the
 * inbound child only — `tags: ["#channel-message/inbound"]` — which an outbound
 * note (parent + `/outbound`) never carries, so a reply can't wake its own session.
 * As belt-and-suspenders, `ingestInbound` also drops any note tagged
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
  /** The note's tags — carries `#channel-message/{inbound,outbound}` for loop avoidance. */
  tags?: string[];
  metadata?: Record<string, unknown>;
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
/** Parent tag — carried LITERALLY on every note; query this + metadata.channel to
 *  see BOTH directions of a channel (the slash children are namespace, not inheritance). */
const CHANNEL_MESSAGE_TAG = "#channel-message";
/** Inbound child — the vault trigger fires on this exact tag (never matches outbound → no loop). */
const CHANNEL_MESSAGE_INBOUND_TAG = "#channel-message/inbound";
/** Outbound child — replies carry this; the trigger's exact-match predicate excludes it. */
const CHANNEL_MESSAGE_OUTBOUND_TAG = "#channel-message/outbound";

/**
 * The tag schema this module manages in any vault it's connected to.
 *
 * This is the declarative complement to the "tag both parent + child" fail-safe
 * in `reply()` / inbound writes. A slash in a Parachute tag NAME is namespace-only
 * — it carries NO query inheritance. Inheritance is the `parent_names` graph,
 * declared via the vault's tag-schema API. By DECLARING that
 * `#channel-message/{inbound,outbound}` have parent `#channel-message`, a default
 * `tag:#channel-message` query expands to include the children semantically — so
 * a UI listing a channel's transcript works off the parent even for notes that
 * only carry the child tag.
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
export const CHANNEL_VAULT_TAG_SCHEMA: ReadonlyArray<{
  name: string;
  description?: string;
  parent_names?: string[];
}> = [
  {
    name: CHANNEL_MESSAGE_TAG,
    description: "A message in a Parachute channel (parent of /inbound + /outbound).",
  },
  {
    name: CHANNEL_MESSAGE_INBOUND_TAG,
    parent_names: [CHANNEL_MESSAGE_TAG],
    description: "Human→session message; the vault trigger fires on this.",
  },
  {
    name: CHANNEL_MESSAGE_OUTBOUND_TAG,
    parent_names: [CHANNEL_MESSAGE_TAG],
    description: "Session→human reply.",
  },
];

/**
 * The vault trigger the hub registers to wake this channel on inbound notes.
 *
 * This is MODULE-OWNED DATA: the channel owns the shape of the trigger it needs,
 * rather than the hub hardcoding it. The hub fetches this template (via
 * `GET /.parachute/config` → `triggerTemplate`), substitutes the channel name
 * into the placeholders, fills the webhook origin + the `action.auth.bearer`
 * (a `channel:send` hub JWT, per the keystone vault PR's `action.auth.bearer`
 * support), and registers it through the vault's runtime trigger-registration API.
 *
 * Placeholders the hub substitutes:
 *  - `<channel>` in `name` → the channel name (e.g. `channel_inbound_eng`);
 *  - `<hub-origin>` in `action.webhook` → the hub's public origin.
 * The hub also injects `action.auth.bearer` (not in the template — it's a secret
 * the hub mints).
 *
 * The predicate matches a NEW inbound note (`#channel-message/inbound`) that
 * carries a `channel` metadata field and hasn't been rendered yet. Loop avoidance
 * is by the inbound CHILD tag: an outbound (reply) note carries
 * `#channel-message/outbound`, never the inbound child, so it never fires this.
 */
export const CHANNEL_VAULT_TRIGGER_TEMPLATE = {
  name: "channel_inbound_<channel>", // hub substitutes the channel name
  events: ["created"],
  when: {
    tags: ["#channel-message/inbound"],
    has_metadata: ["channel"],
    missing_metadata: ["channel_inbound_rendered_at"],
  },
  action: {
    webhook: "<hub-origin>/channel/api/vault/inbound", // hub fills origin + the auth.bearer
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
   * Idempotently upsert `CHANNEL_VAULT_TAG_SCHEMA` into the connected vault via
   * the vault's tag-schema REST API. The vault route is
   *   PUT /vault/<vault>/api/tags/:name
   * where `:name` is matched by `subpath.match(/^\/([^/]+)$/)` then
   * `decodeURIComponent`'d (parachute-vault `src/routes.ts` handleTags, the
   * "Routes with tag name" block + `routing.ts` `apiPath.startsWith("/tags")`).
   * Because the route matches a SINGLE path segment (`[^/]+`, no literal slash)
   * and decodes it, the tag name — which contains BOTH `#` and `/`
   * (`#channel-message/inbound`) — must be `encodeURIComponent`'d so the `#`
   * becomes `%23` and the `/` becomes `%2F`; the route then decodes that back to
   * the literal name. A bare `/` in the URL would fail the `[^/]+` match → 404,
   * silently dropping the declaration. The PUT body is `{ description?, parent_names? }`.
   *
   * Best-effort + non-fatal by contract: every failure is caught and `console.warn`'d,
   * never thrown — the tag-both write floor is the fallback.
   */
  async ensureSchema(): Promise<void> {
    for (const entry of CHANNEL_VAULT_TAG_SCHEMA) {
      try {
        // Single-segment, percent-encoded name: `#channel-message/inbound` →
        // `%23channel-message%2Finbound`. The vault decodes it back to the literal.
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
      // source of truth is now the `#channel-message/outbound` TAG below — the
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
        tags: [CHANNEL_MESSAGE_TAG, CHANNEL_MESSAGE_OUTBOUND_TAG],
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
   * tagging model: ONE `tag=#channel-message` (the parent, carried literally on
   * every note) + a `metadata.channel == <this channel>` filter. Because the
   * parent is on every note, this returns BOTH inbound and outbound — the slash
   * children are namespace, not query inheritance, so we never key off them here.
   *
   *   GET <vaultUrl>/vault/<vault>/api/notes
   *       ?tag=%23channel-message              (the `#` MUST be percent-encoded)
   *       &metadata={"channel":{"eq":"<ch>"}}  (JSON `?metadata=` alias, URI-encoded)
   *       &include_content=true                (we need the bodies)
   *       &limit=<n>                           (default 200)
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
    // `?tag=` takes the literal tag; the `#` must be percent-encoded (`%23`) or
    // the route never sees it. `?metadata=` is the JSON-object alias the vault
    // parses into a `{field:{op:value}}` filter (parachute-vault routes.ts
    // parseMetadataJsonAlias) — encode the whole JSON value.
    const metaFilter = JSON.stringify({ channel: { eq: channel } });
    const params = new URLSearchParams();
    params.set("tag", CHANNEL_MESSAGE_TAG); // URLSearchParams encodes `#` → `%23`
    params.set("metadata", metaFilter);
    params.set("include_content", "true");
    params.set("limit", String(limit));
    const url = `${this.vaultUrl}/vault/${this.vault}/api/notes?${params.toString()}`;

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `vault transport: load transcript failed (${res.status}) ${detail}`.trim(),
      );
    }

    let notes: Array<{
      id?: string;
      content?: string;
      tags?: string[];
      metadata?: Record<string, unknown>;
    }>;
    try {
      const parsed = (await res.json()) as unknown;
      // The structured-query route returns a bare array; tolerate a `{notes:[]}`
      // envelope too in case a future shape wraps it.
      notes = Array.isArray(parsed)
        ? (parsed as typeof notes)
        : ((parsed as { notes?: typeof notes })?.notes ?? []);
    } catch (err) {
      throw new Error(
        `vault transport: load transcript — bad JSON from vault: ${(err as Error).message}`,
      );
    }

    const messages: ChannelMessage[] = [];
    for (const note of notes) {
      if (typeof note.id !== "string" || !note.id) continue;
      const meta = note.metadata ?? {};
      const tags = note.tags ?? [];
      // Direction: prefer the explicit metadata field; fall back to the child tag.
      let direction: "inbound" | "outbound";
      if (meta.direction === "inbound" || meta.direction === "outbound") {
        direction = meta.direction;
      } else if (tags.includes(CHANNEL_MESSAGE_OUTBOUND_TAG)) {
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
    return messages;
  }

  /**
   * Write a human→session INBOUND note — the chat's "send". This mirrors
   * `reply()` exactly except the tags + direction: the inbound CHILD tag
   * (`#channel-message/inbound`) is what the vault trigger fires on, so writing
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
        // a `tag:#channel-message` query.
        tags: [CHANNEL_MESSAGE_TAG, CHANNEL_MESSAGE_INBOUND_TAG],
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

  // -------------------------------------------------------------------------
  // Inbound — the daemon's webhook hands us a new inbound note to deliver.
  // -------------------------------------------------------------------------

  /**
   * Deliver an inbound `#channel-message/inbound` note onto this channel: emit it
   * so the subscribed bridge / MCP session wakes. Called by the daemon's
   * `/api/vault/inbound` webhook after it has resolved the channel.
   *
   * Belt-and-suspenders over the trigger predicate: a note tagged
   * `#channel-message/outbound` OR explicitly `direction: "outbound"` is IGNORED
   * — we never wake on our own reply, even if a mis-wired trigger delivers one.
   */
  ingestInbound(note: InboundNote): void {
    if (!this.ctx) throw new Error("vault transport: not started");
    const meta = note.metadata ?? {};
    const tags = note.tags ?? [];
    if (tags.includes(CHANNEL_MESSAGE_OUTBOUND_TAG) || meta.direction === "outbound") {
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
