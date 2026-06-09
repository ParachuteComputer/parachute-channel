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
  /** Shared secret the inbound webhook must present (validated by the daemon). */
  webhookSecret: string;
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

const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";
const DEFAULT_PATH_PREFIX = "channel";
/** Parent tag — carried LITERALLY on every note; query this + metadata.channel to
 *  see BOTH directions of a channel (the slash children are namespace, not inheritance). */
const CHANNEL_MESSAGE_TAG = "#channel-message";
/** Inbound child — the vault trigger fires on this exact tag (never matches outbound → no loop). */
const CHANNEL_MESSAGE_INBOUND_TAG = "#channel-message/inbound";
/** Outbound child — replies carry this; the trigger's exact-match predicate excludes it. */
const CHANNEL_MESSAGE_OUTBOUND_TAG = "#channel-message/outbound";

export class VaultTransport implements Transport {
  readonly kind = "vault";

  private ctx: TransportContext | undefined;
  private readonly vault: string;
  private readonly vaultUrl: string;
  private readonly token: string;
  /** Shared secret the daemon validates on the inbound webhook (read by the daemon). */
  readonly webhookSecret: string;
  private readonly pathPrefix: string;

  constructor(config: VaultTransportConfig) {
    if (!config.vault) {
      throw new Error("VaultTransport: config.vault (vault name) is required");
    }
    if (!config.token) {
      throw new Error("VaultTransport: config.token (vault:<name>:write JWT) is required");
    }
    if (!config.webhookSecret) {
      throw new Error("VaultTransport: config.webhookSecret is required");
    }
    this.vault = config.vault;
    this.vaultUrl = (config.vaultUrl ?? DEFAULT_VAULT_URL).replace(/\/$/, "");
    this.token = config.token;
    this.webhookSecret = config.webhookSecret;
    this.pathPrefix = (config.notePathPrefix ?? DEFAULT_PATH_PREFIX).replace(/\/$/, "");
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
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
