#!/usr/bin/env bun
/**
 * parachute-channel bridge — a stdio MCP server that Claude Code spawns.
 *
 * Connects to the parachute-channel daemon via SSE for inbound messages
 * and proxies outbound tool calls (reply, react, edit, download) to the
 * daemon's HTTP API. This is the only file Claude Code interacts with.
 *
 * The bridge is stateless and lightweight — safe to spawn in multiple
 * sessions simultaneously because it never touches the Telegram API.
 * The daemon handles all platform communication.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const DAEMON_URL = process.env.PARACHUTE_CHANNEL_URL ?? "http://127.0.0.1:1941";

// ---------------------------------------------------------------------------
// MCP server setup
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "parachute-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "The sender reads Telegram, not this session. Anything you want them to see must go through the reply tool — your transcript output never reaches their chat.",
      "",
      'Messages from Telegram arrive as <channel source="parachute-channel" chat_id="..." message_id="..." user="..." ts="...">.',
      "Reply with the reply tool — pass chat_id back. Use reply_to (message_id) to thread a specific message; omit it for normal responses.",
      "",
      "If the tag has an image_path attribute, Read that file — it is a photo the sender attached.",
      "If the tag has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.",
      "",
      "Use react to add emoji reactions. Use edit_message for interim progress updates (edits do not push notifications — send a new reply when a long task completes so the user's device pings).",
      "",
      'reply accepts file paths (files: ["/abs/path.png"]) for attachments.',
    ].join("\n"),
  },
);

// ---------------------------------------------------------------------------
// Permission relay — receive permission_request from CC, forward to daemon
// ---------------------------------------------------------------------------

mcp.setNotificationHandler(
  z.object({
    method: z.literal("notifications/claude/channel/permission_request"),
    params: z.object({
      request_id: z.string(),
      tool_name: z.string(),
      description: z.string(),
      input_preview: z.string(),
    }),
  }),
  async ({ params }) => {
    try {
      await fetch(`${DAEMON_URL}/api/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (err) {
      process.stderr.write(`parachute-channel bridge: failed to relay permission request: ${err}\n`);
    }
  },
);

// ---------------------------------------------------------------------------
// Tools — match the official plugin's tool surface
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a message to a Telegram chat. Supports text, file attachments (images sent as photos, .ogg as voice, others as documents), and quote-reply threading.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID to send to" },
          text: { type: "string", description: "Message text (optional if files provided)" },
          reply_to: { type: "string", description: "Message ID to quote-reply (optional)" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach (optional)",
          },
        },
        required: ["chat_id"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a Telegram message. Only Telegram's fixed emoji whitelist is accepted (👍 👎 ❤ 🔥 👀 etc).",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID" },
          message_id: { type: "string", description: "Message ID to react to" },
          emoji: { type: "string", description: "Emoji reaction" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a message the bot previously sent. Useful for progress updates. Edits don't trigger push notifications.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "Telegram chat ID" },
          message_id: { type: "string", description: "Message ID to edit" },
          text: { type: "string", description: "New text" },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description: "Download a Telegram file attachment by file_id. Returns the local path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "Telegram file_id from the attachment_file_id attribute" },
        },
        required: ["file_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments as Record<string, unknown>;

  switch (req.params.name) {
    case "reply": {
      const res = await fetch(`${DAEMON_URL}/api/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `reply failed: ${err}` }], isError: true };
      }
      const data = (await res.json()) as { sent: number[] };
      const ids = data.sent;
      const parts = ids.length === 1 ? `(id: ${ids[0]})` : `(ids: ${ids.join(", ")})`;
      return { content: [{ type: "text", text: `sent ${ids.length} part${ids.length > 1 ? "s" : ""} ${parts}` }] };
    }

    case "react": {
      const res = await fetch(`${DAEMON_URL}/api/react`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `react failed: ${err}` }], isError: true };
      }
      return { content: [{ type: "text", text: "reacted" }] };
    }

    case "edit_message": {
      const res = await fetch(`${DAEMON_URL}/api/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `edit failed: ${err}` }], isError: true };
      }
      return { content: [{ type: "text", text: "edited" }] };
    }

    case "download_attachment": {
      const res = await fetch(`${DAEMON_URL}/api/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      if (!res.ok) {
        const err = await res.text();
        return { content: [{ type: "text", text: `download failed: ${err}` }], isError: true };
      }
      const data = (await res.json()) as { path: string };
      return { content: [{ type: "text", text: data.path }] };
    }

    default:
      return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
  }
});

// ---------------------------------------------------------------------------
// SSE connection to daemon — forward inbound messages as MCP notifications
// ---------------------------------------------------------------------------

async function connectToEvents(): Promise<void> {
  while (true) {
    try {
      const res = await fetch(`${DAEMON_URL}/events`);
      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        let currentData = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            currentData += line.slice(6);
          } else if (line === "") {
            // End of event
            if (currentEvent === "message" && currentData) {
              try {
                const parsed = JSON.parse(currentData) as {
                  content: string;
                  meta: Record<string, string>;
                  source: string;
                };
                await mcp.notification({
                  method: "notifications/claude/channel",
                  params: {
                    content: parsed.content,
                    meta: { source: "parachute-channel", ...parsed.meta },
                  },
                });
              } catch (err) {
                process.stderr.write(`parachute-channel bridge: failed to parse/forward event: ${err}\n`);
              }
            } else if (currentEvent === "permission_verdict" && currentData) {
              try {
                const parsed = JSON.parse(currentData) as {
                  request_id: string;
                  behavior: string;
                };
                await mcp.notification({
                  method: "notifications/claude/channel/permission",
                  params: {
                    request_id: parsed.request_id,
                    behavior: parsed.behavior,
                  },
                });
              } catch (err) {
                process.stderr.write(`parachute-channel bridge: failed to forward permission verdict: ${err}\n`);
              }
            }
            currentEvent = "";
            currentData = "";
          }
        }
      }
    } catch (err) {
      process.stderr.write(`parachute-channel bridge: SSE error, reconnecting in 3s: ${err}\n`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---------------------------------------------------------------------------
// Missing-subscription warning
//
// If Claude Code attaches to this bridge but didn't opt into the
// experimental `claude/channel` capability (e.g. forgot
// `--dangerously-load-development-channels=server:<name>`), the MCP tools
// register fine but every inbound notification the bridge emits is silently
// dropped. That looks identical to a working setup until a message arrives
// and nothing lands in the session.
//
// Signals, in priority order:
//   1. On `oninitialized`, read `getClientCapabilities().experimental` — the
//      canonical MCP hook. If `claude/channel` is missing, warn.
//   2. If no initialize ever arrives (bridge is running but no client
//      connected), warn after a grace period so `bun src/bridge.ts` invoked
//      standalone tells you so.
//
// The warning doesn't exit — outbound tool calls still work in degraded mode.
// Gated on NODE_ENV !== "test" so tests can import this module silently.
// ---------------------------------------------------------------------------

const SUBSCRIPTION_WARN_MS = 15_000;
const IS_TEST = process.env.NODE_ENV === "test";

let initReceived = false;
const warnIfNoInit = setTimeout(() => {
  if (initReceived || IS_TEST) return;
  process.stderr.write(
    "parachute-channel bridge: no MCP initialize received after 15s — " +
    "the bridge is running but no client has connected.\n",
  );
}, SUBSCRIPTION_WARN_MS);
if (typeof warnIfNoInit.unref === "function") warnIfNoInit.unref();

mcp.oninitialized = () => {
  initReceived = true;
  clearTimeout(warnIfNoInit);
  if (IS_TEST) return;
  const caps = mcp.getClientCapabilities();
  const hasChannel = caps?.experimental?.["claude/channel"] !== undefined;
  if (!hasChannel) {
    process.stderr.write(
      [
        "parachute-channel bridge: WARNING — client did not advertise claude/channel support.",
        "  Inbound Telegram messages will not reach this session.",
        "  Did you launch Claude Code with:",
        "      --dangerously-load-development-channels=server:parachute-channel",
        "  (See https://github.com/ParachuteComputer/parachute-channel/issues/8)",
        "",
      ].join("\n"),
    );
  }
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport());
process.stderr.write("parachute-channel bridge: connected to Claude Code, connecting to daemon...\n");

// Start SSE listener (runs forever, reconnects on failure)
connectToEvents();
