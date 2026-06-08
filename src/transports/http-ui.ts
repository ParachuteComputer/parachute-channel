/**
 * http-ui transport for parachute-channel.
 *
 * The freestanding "make sure message sending works" surface: a human talks to
 * a Claude Code session through a browser, with NO Telegram and NO vault.
 *
 * How it differs from telegram — the "external party" is a browser:
 *  - Inbound (human → session): the UI POSTs to
 *    `/api/channels/<name>/send {text}`; this transport calls `ctx.emit(...)`,
 *    which routes to the bridge subscribed to that channel and wakes the
 *    session.
 *  - Outbound (session → human): when the session calls the `reply` tool, the
 *    bridge POSTs `/api/reply {channel,...}`; the daemon dispatches to this
 *    transport's `reply()`. Since the browser can't be POSTed to, this transport
 *    holds its own set of **UI SSE clients** per channel and `reply()` enqueues
 *    to them (mirroring the daemon's `/events` SSE pattern for bridges).
 *
 * It owns two HTTP surfaces via `ingestHttp` (scoped to ITS OWN channel name):
 *   1. POST /api/channels/<name>/send   — body {text} → ctx.emit(...) → {ok:true}
 *   2. GET  /ui/events?channel=<name>    — SSE stream the browser subscribes to
 * The static `/ui` chat page itself is global and served by the daemon, since
 * it's a channel picker across all http-ui channels.
 */

import type {
  Transport,
  TransportContext,
  ReplyArgs,
  EditArgs,
  PermissionArgs,
} from "../transport.ts";
import { sseFrame } from "../routing.ts";

/** A connected browser SSE client (one per open chat page on this channel). */
interface UiClient {
  enqueue(payload: string): void;
}

/** Config for an http-ui transport instance (no secret needed — just a name). */
export interface HttpUiTransportConfig {
  /** Optional override for the channel name; normally taken from ctx.channel. */
  channel?: string;
}

export class HttpUiTransport implements Transport {
  readonly kind = "http-ui";

  /** Captured in start() — the channel this instance is bound to. */
  private ctx: TransportContext | undefined;
  /** Connected browser SSE clients for this channel, keyed by client id. */
  private uiClients = new Map<string, UiClient>();

  constructor(_config: HttpUiTransportConfig = {}) {
    // http-ui needs no secret. Config is accepted for forward-compat.
  }

  async start(ctx: TransportContext): Promise<void> {
    this.ctx = ctx;
  }

  async stop(): Promise<void> {
    // Close all browser SSE streams. Enqueue can throw on an already-closed
    // stream; swallow per-client so one bad client doesn't block the rest.
    for (const client of this.uiClients.values()) {
      try {
        client.enqueue(sseFrame("close", {}));
      } catch {}
    }
    this.uiClients.clear();
  }

  /** The channel name this transport is bound to (after start). */
  private get channel(): string {
    if (!this.ctx) throw new Error("http-ui transport: not started");
    return this.ctx.channel;
  }

  /** Push an SSE frame to every connected browser client. Returns delivery count. */
  private pushToUi(event: string, data: unknown): number {
    const payload = sseFrame(event, data);
    let delivered = 0;
    for (const [id, client] of this.uiClients) {
      try {
        client.enqueue(payload);
        delivered++;
      } catch {
        this.uiClients.delete(id);
      }
    }
    return delivered;
  }

  // -------------------------------------------------------------------------
  // Outbound — the session → browser direction
  // -------------------------------------------------------------------------

  async reply(args: ReplyArgs): Promise<{ sent: string[] }> {
    // The browser can't be POSTed to, so we push the reply over the UI SSE
    // stream(s). A message with no connected UI client still succeeds — it just
    // has no listener (return an empty sent list).
    const id = crypto.randomUUID();
    const delivered = this.pushToUi("reply", {
      id,
      text: args.text ?? "",
      files: args.files ?? [],
    });
    return { sent: delivered > 0 ? [id] : [] };
  }

  async edit(args: EditArgs): Promise<void> {
    this.pushToUi("edit", { id: args.message_id, text: args.text });
  }

  async sendPermission(args: PermissionArgs): Promise<{ sent: string[] }> {
    // Surface the permission prompt in the chat so the human sees it. There's no
    // verdict affordance wired in the minimal UI yet (Stage 1), but the prompt
    // is visible — better than the daemon's methodMissing 400.
    const delivered = this.pushToUi("permission", {
      request_id: args.request_id,
      tool_name: args.tool_name,
      description: args.description,
      input_preview: args.input_preview,
    });
    return { sent: delivered > 0 ? [args.request_id] : [] };
  }

  // -------------------------------------------------------------------------
  // HTTP routes this transport owns (only for ITS OWN channel name)
  // -------------------------------------------------------------------------

  async ingestHttp(req: Request, url: URL): Promise<Response | null> {
    const channel = this.channel; // getter throws a clear error if not started
    const ctx = this.ctx!; // safe: the getter above guarantees ctx is set

    // 1. Inbound: POST /api/channels/<channel>/send  body {text}
    if (
      req.method === "POST" &&
      url.pathname === `/api/channels/${channel}/send`
    ) {
      let text: string;
      try {
        const body = (await req.json()) as { text?: unknown };
        if (typeof body.text !== "string" || body.text.length === 0) {
          return json({ error: "body must be { text: <non-empty string> }" }, 400);
        }
        text = body.text;
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      ctx.emit({
        channel,
        content: text,
        meta: { source: "http-ui", ts: new Date().toISOString() },
        source: "http-ui",
      });
      return json({ ok: true });
    }

    // 2. Outbound stream: GET /ui/events?channel=<channel>
    if (
      req.method === "GET" &&
      url.pathname === "/ui/events" &&
      url.searchParams.get("channel") === channel
    ) {
      const clientId = crypto.randomUUID();
      const clients = this.uiClients;
      const stream = new ReadableStream<string>({
        start(controller) {
          clients.set(clientId, {
            enqueue: (payload) => controller.enqueue(payload),
          });
          controller.enqueue(": connected\n\n");
        },
        cancel() {
          clients.delete(clientId);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    return null;
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
