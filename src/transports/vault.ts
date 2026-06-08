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
 *    `/api/vault/inbound` webhook when a new inbound `#channel-message` note
 *    appears; the daemon resolves the channel from `note.metadata.channel` and
 *    calls this transport's `ingestInbound(note)`, which `ctx.emit(...)`s →
 *    routes to the bridge / MCP session subscribed to that channel and wakes it.
 *  - Outbound (session → human): when the session calls the `reply` tool, the
 *    bridge POSTs `/api/reply {channel,...}`; the daemon dispatches to this
 *    transport's `reply()`, which writes an OUTBOUND `#channel-message` note via
 *    the vault REST API (`POST <vaultUrl>/vault/<vault>/api/notes`).
 *
 * Loop avoidance (load-bearing). An outbound reply is itself a new
 * `#channel-message` note — if the trigger fired on it, the session would wake
 * on its own reply forever. The vault trigger predicate can only match on
 * key-PRESENCE (`has_metadata`/`missing_metadata`), NOT on a value
 * (`direction == "inbound"`). So every outbound note carries a presence marker
 * `outbound: "1"`, and the trigger is configured to EXCLUDE notes that have it.
 * As belt-and-suspenders over the trigger predicate, `ingestInbound` also drops
 * any note that is outbound-marked (or `direction: "outbound"`) — so even a
 * mis-wired trigger can never wake us on our own reply.
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
  metadata?: Record<string, unknown>;
}

const DEFAULT_VAULT_URL = "http://127.0.0.1:1940";
const DEFAULT_PATH_PREFIX = "channel";
const CHANNEL_MESSAGE_TAG = "#channel-message";

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
      direction: "outbound",
      sender: "session",
      // PRESENCE MARKER — the trigger excludes notes that have this key, so an
      // outbound reply never wakes the session (loop avoidance). Load-bearing.
      outbound: "1",
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
        tags: [CHANNEL_MESSAGE_TAG],
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
   * Deliver an inbound `#channel-message` note onto this channel: emit it so the
   * subscribed bridge / MCP session wakes. Called by the daemon's
   * `/api/vault/inbound` webhook after it has resolved the channel.
   *
   * Belt-and-suspenders over the trigger predicate: a note that is
   * outbound-marked (`metadata.outbound` present) OR explicitly
   * `direction: "outbound"` is IGNORED — we never wake on our own reply, even if
   * a mis-wired trigger delivers one.
   */
  ingestInbound(note: InboundNote): void {
    if (!this.ctx) throw new Error("vault transport: not started");
    const meta = note.metadata ?? {};
    if (meta.outbound !== undefined || meta.direction === "outbound") {
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
