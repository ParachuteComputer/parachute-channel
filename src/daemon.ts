#!/usr/bin/env bun
/**
 * parachute-channel daemon — the transport-agnostic orchestrator.
 *
 * Runs as a long-lived HTTP server (launchd, systemd, or manual). It loads a
 * channel registry (name → transport), starts each transport, and routes
 * inbound traffic to the bridges subscribed to that channel. Bridges connect
 * via SSE (`/events?channel=<name>`) for inbound and POST outbound to the HTTP
 * API with a `channel` field.
 *
 * Telegram is one transport behind the registry; the daemon core touches no
 * platform API directly.
 *
 * Default port: 1941 (PARACHUTE_CHANNEL_PORT env).
 */

import { mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  Transport,
  TransportContext,
  InboundMessage,
  ReplyArgs,
  ReactArgs,
  EditArgs,
  PermissionArgs,
  DownloadArgs,
} from "./transport.ts";
import { ChannelConfigError } from "./transport.ts";
import { loadRegistry, defaultStateDir, type Channel } from "./registry.ts";
import { ClientRegistry } from "./routing.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = defaultStateDir();
const INBOX_DIR = join(STATE_DIR, "inbox");
const PORT = parseInt(process.env.PARACHUTE_CHANNEL_PORT ?? "1941", 10);

/** Channel a bridge subscribes to when `?channel=` is omitted (back-compat). */
const DEFAULT_CHANNEL = "telegram";

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(INBOX_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Registry + routing
// ---------------------------------------------------------------------------

let channels: Map<string, Channel>;
try {
  channels = loadRegistry({ stateDir: STATE_DIR });
} catch (err) {
  console.error(`parachute-channel: failed to load channel registry: ${err}`);
  process.exit(1);
}

if (channels.size === 0) {
  console.error(
    `parachute-channel: no channels configured.\n` +
      `  Add ${join(STATE_DIR, "channels.json")} or set TELEGRAM_BOT_TOKEN\n` +
      `  (env or ${join(STATE_DIR, ".env")}) for a default telegram channel.`,
  );
  process.exit(1);
}

const registry = new ClientRegistry();

/** Build the per-channel context a transport routes through. */
function contextFor(channel: string): TransportContext {
  return {
    channel,
    emit(msg: InboundMessage): void {
      // Route on the bound `channel`, NOT msg.channel — the transport's own
      // channel is authoritative. This makes it impossible for a transport to
      // emit onto another channel (closing a silent cross-channel-leak footgun)
      // even if a future transport sets msg.channel incorrectly.
      registry.routeToChannel(channel, "message", {
        content: msg.content,
        meta: msg.meta,
        source: msg.source,
      });
    },
    emitPermissionVerdict(v): void {
      registry.routeToChannel(channel, "permission_verdict", v);
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Resolve the transport for a channel from a request body, or null on miss. */
function transportFor(channel: string | undefined): Transport | null {
  if (!channel) return null;
  return channels.get(channel)?.transport ?? null;
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check — per-channel client counts.
    if (url.pathname === "/health") {
      return json({
        status: "ok",
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          kind: c.transport.kind,
          clients: registry.countForChannel(c.name),
        })),
        total_clients: registry.size,
      });
    }

    // Self-describing config (runner pattern) — read-only, no secrets.
    if (req.method === "GET" && url.pathname === "/.parachute/config") {
      return json({
        channels: [...channels.values()].map((c) => ({
          name: c.name,
          transport: c.transport.kind,
        })),
      });
    }

    if (req.method === "GET" && url.pathname === "/.parachute/config/schema") {
      return json({
        title: "parachute-channel config",
        description: "Named channels, each bound to a transport.",
        type: "object",
        properties: {
          channels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Unique channel name bridges subscribe to." },
                transport: {
                  type: "string",
                  enum: ["telegram"],
                  description: "Transport kind backing this channel.",
                },
                config: {
                  type: "object",
                  description: "Transport-specific config (secrets live here, not returned by /config).",
                },
              },
              required: ["name", "transport"],
            },
          },
        },
        required: ["channels"],
      });
    }

    // SSE event stream — bridges subscribe by channel.
    if (req.method === "GET" && url.pathname === "/events") {
      let channel = url.searchParams.get("channel") ?? undefined;
      if (!channel) {
        channel = DEFAULT_CHANNEL;
        console.warn(
          `parachute-channel: /events without ?channel= — defaulting to "${DEFAULT_CHANNEL}". ` +
            `This back-compat default is deprecated; pass ?channel=<name>.`,
        );
      }
      const subscribedChannel = channel;
      const clientId = crypto.randomUUID();
      const stream = new ReadableStream<string>({
        start(controller) {
          registry.add(clientId, {
            channel: subscribedChannel,
            enqueue: (payload) => controller.enqueue(payload),
          });
          controller.enqueue(": connected\n\n");
        },
        cancel() {
          registry.remove(clientId);
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

    // Reply
    if (req.method === "POST" && url.pathname === "/api/reply") {
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          text?: string;
          reply_to?: string;
          files?: string[];
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        const result = await transport.reply(toReplyArgs(body));
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // React
    if (req.method === "POST" && url.pathname === "/api/react") {
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          emoji: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.react) return methodMissing(body.channel!, "react");
        const args: ReactArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          emoji: body.emoji,
          meta: mergeMeta(body),
        };
        await transport.react(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Edit message
    if (req.method === "POST" && url.pathname === "/api/edit") {
      try {
        const body = (await req.json()) as {
          channel?: string;
          chat_id?: string;
          message_id: string;
          text: string;
          meta?: Record<string, string>;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.edit) return methodMissing(body.channel!, "edit");
        const args: EditArgs = {
          channel: body.channel!,
          message_id: body.message_id,
          text: body.text,
          meta: mergeMeta(body),
        };
        await transport.edit(args);
        return json({ ok: true });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Permission prompt — bridge forwards permission_request here.
    if (req.method === "POST" && url.pathname === "/api/permission") {
      try {
        const body = (await req.json()) as {
          channel?: string;
          request_id: string;
          tool_name: string;
          description: string;
          input_preview: string;
        };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.sendPermission) return methodMissing(body.channel!, "sendPermission");
        const args: PermissionArgs = {
          channel: body.channel!,
          request_id: body.request_id,
          tool_name: body.tool_name,
          description: body.description,
          input_preview: body.input_preview,
        };
        const result = await transport.sendPermission(args);
        return json({ sent: result.sent });
      } catch (err) {
        return errResponse(err);
      }
    }

    // Download attachment
    if (req.method === "POST" && url.pathname === "/api/download") {
      try {
        const body = (await req.json()) as { channel?: string; file_id: string };
        const transport = transportFor(body.channel);
        if (!transport) return channelError(body.channel);
        if (!transport.download) return methodMissing(body.channel!, "download");
        const args: DownloadArgs = { channel: body.channel!, file_id: body.file_id };
        const result = await transport.download(args);
        return json({ path: result.path });
      } catch (err) {
        return errResponse(err);
      }
    }

    return json({ error: "not found" }, 404);
  },
});

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/**
 * Map a thrown error to a response: ChannelConfigError → 400 (operator must fix
 * config), anything else → 500 (runtime fault). Lets callers distinguish the two.
 */
function errResponse(err: unknown): Response {
  if (err instanceof ChannelConfigError) return json({ error: err.message }, 400);
  return json({ error: String(err) }, 500);
}

function channelError(channel: string | undefined): Response {
  if (!channel) {
    return json({ error: "missing 'channel' field in request body" }, 400);
  }
  return json(
    {
      error: `unknown channel "${channel}" — known channels: ${[...channels.keys()].join(", ") || "(none)"}`,
    },
    400,
  );
}

function methodMissing(channel: string, method: string): Response {
  const kind = channels.get(channel)?.transport.kind ?? "unknown";
  return json(
    { error: `transport "${kind}" for channel "${channel}" does not support ${method}` },
    400,
  );
}

/**
 * Build the meta map for outbound calls. Telegram addressing historically came
 * in as a top-level `chat_id`; preserve that by folding it into `meta.chat_id`
 * while letting an explicit `meta` object take precedence/extend.
 */
function mergeMeta(body: { chat_id?: string; meta?: Record<string, string> }): Record<string, string> {
  const meta: Record<string, string> = { ...(body.meta ?? {}) };
  if (body.chat_id !== undefined && meta.chat_id === undefined) meta.chat_id = body.chat_id;
  return meta;
}

function toReplyArgs(body: {
  channel?: string;
  chat_id?: string;
  text?: string;
  reply_to?: string;
  files?: string[];
  meta?: Record<string, string>;
}): ReplyArgs {
  return {
    channel: body.channel!,
    text: body.text,
    files: body.files,
    reply_to: body.reply_to,
    meta: mergeMeta(body),
  };
}

// ---------------------------------------------------------------------------
// Startup — start every transport
// ---------------------------------------------------------------------------

console.log(`parachute-channel: daemon listening on http://127.0.0.1:${PORT}`);
console.log(`parachute-channel: state dir: ${STATE_DIR}`);
console.log(
  `parachute-channel: ${channels.size} channel(s): ${[...channels.values()]
    .map((c) => `${c.name}→${c.transport.kind}`)
    .join(", ")}`,
);

for (const channel of channels.values()) {
  channel.transport.start(contextFor(channel.name)).catch((err) => {
    console.error(`parachute-channel: transport "${channel.name}" start failed:`, err);
  });
}

// Graceful shutdown — stop all transports.
async function shutdown(): Promise<void> {
  await Promise.allSettled([...channels.values()].map((c) => c.transport.stop()));
  server.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
