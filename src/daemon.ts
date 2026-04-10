#!/usr/bin/env bun
/**
 * parachute-channel daemon — the single process that owns messaging platform
 * connections. Telegram today, anything tomorrow.
 *
 * Runs as a long-lived HTTP server (launchd, systemd, or manual). Bridges
 * connect to it via SSE (/events) to receive inbound messages and via HTTP
 * endpoints to send outbound messages. The daemon is the ONLY process that
 * touches the Telegram API — no races, no multi-consumer conflicts.
 *
 * Default port: 1941 (PARACHUTE_CHANNEL_PORT env).
 */

import { TelegramApi, type TelegramMessage, type TelegramCallbackQuery, type TelegramUpdate } from "./telegram/api.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.PARACHUTE_CHANNEL_STATE_DIR ??
  join(homedir(), ".parachute", "channel");
const ENV_FILE = join(STATE_DIR, ".env");
const ACCESS_FILE = join(STATE_DIR, "access.json");
const INBOX_DIR = join(STATE_DIR, "inbox");
const PORT = parseInt(process.env.PARACHUTE_CHANNEL_PORT ?? "1941", 10);

mkdirSync(STATE_DIR, { recursive: true });
mkdirSync(INBOX_DIR, { recursive: true });

// Load .env (same pattern as the official plugin)
try {
  if (existsSync(ENV_FILE)) {
    chmodSync(ENV_FILE, 0o600);
    for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  }
} catch {}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error(
    `parachute-channel: TELEGRAM_BOT_TOKEN required\n` +
    `  set in ${ENV_FILE} or shell env\n` +
    `  format: TELEGRAM_BOT_TOKEN=123456789:AAH...`
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Access control — reuse the official plugin's access.json format
// ---------------------------------------------------------------------------

// Matches the official telegram plugin's access.json format
interface AccessConfig {
  dmPolicy: "open" | "pairing" | "allowlist";
  allowFrom: string[];
  groups: Record<string, unknown>;
  pending: Record<string, unknown>;
}

function loadAccess(): AccessConfig {
  try {
    return JSON.parse(readFileSync(ACCESS_FILE, "utf8"));
  } catch {
    return { dmPolicy: "open", allowFrom: [], groups: {}, pending: {} };
  }
}

function isAllowed(userId: number): boolean {
  const access = loadAccess();
  if (access.dmPolicy === "open") return true;
  return access.allowFrom.includes(String(userId));
}

// ---------------------------------------------------------------------------
// SSE clients (bridges)
// ---------------------------------------------------------------------------

type SSEClient = {
  id: string;
  controller: ReadableStreamDefaultController<string>;
  connectedAt: number;
};

const clients = new Map<string, SSEClient>();

function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of clients) {
    try {
      client.controller.enqueue(payload);
    } catch {
      clients.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram polling
// ---------------------------------------------------------------------------

const api = new TelegramApi(TOKEN);
let offset: number | undefined;
let pollActive = true;

async function pollLoop(): Promise<void> {
  const me = await api.getMe();
  console.log(`parachute-channel: polling as @${me.username}`);

  while (pollActive) {
    try {
      const updates = await api.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        } else if (update.message) {
          await handleMessage(update.message);
        }
      }
    } catch (err) {
      console.error("parachute-channel: poll error:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------------------------------------------------------------------------
// Permission relay — text-reply intercept
// ---------------------------------------------------------------------------

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const CALLBACK_DATA_RE = /^perm_(allow|deny)_([a-km-z]{5})$/;

async function handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
  const userId = cq.from.id;
  if (!isAllowed(userId)) {
    await api.answerCallbackQuery(cq.id).catch(() => {});
    return;
  }

  const data = cq.data ?? "";
  const match = CALLBACK_DATA_RE.exec(data);
  if (!match) {
    await api.answerCallbackQuery(cq.id).catch(() => {});
    return;
  }

  const behavior = match[1] as "allow" | "deny";
  const requestId = match[2];
  broadcastEvent("permission_verdict", { request_id: requestId, behavior });

  // Answer the callback query (stops button loading spinner)
  const label = behavior === "allow" ? "✅ Allowed" : "❌ Denied";
  await api.answerCallbackQuery(cq.id, { text: label }).catch(() => {});

  // Edit the original message to show the outcome and remove buttons
  if (cq.message) {
    const chatId = String(cq.message.chat.id);
    const originalText = cq.message.text ?? "";
    await api.editMessageText(chatId, cq.message.message_id, `${label}\n\n${originalText}`).catch(() => {});
  }
}

async function handleMessage(msg: TelegramMessage): Promise<void> {
  const userId = msg.from?.id;
  if (!userId || !isAllowed(userId)) return;

  // Permission-reply intercept: if this looks like "yes xxxxx" or "no xxxxx"
  // for a pending permission request, emit a permission_verdict SSE event
  // instead of forwarding as a chat message.
  const text = msg.text ?? "";
  const permMatch = PERMISSION_REPLY_RE.exec(text);
  if (permMatch) {
    const requestId = permMatch[2]!.toLowerCase();
    const behavior = permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny";
    broadcastEvent("permission_verdict", { request_id: requestId, behavior });
    // React to confirm receipt
    const emoji = behavior === "allow" ? "✅" : "❌";
    try {
      await api.setMessageReaction(String(msg.chat.id), msg.message_id, emoji);
    } catch {}
    return;
  }

  // Determine attachment info
  let attachmentKind: string | undefined;
  let attachmentFileId: string | undefined;
  let attachmentSize: number | undefined;
  let attachmentMime: string | undefined;
  let imagePath: string | undefined;

  if (msg.voice) {
    attachmentKind = "voice";
    attachmentFileId = msg.voice.file_id;
    attachmentSize = msg.voice.file_size;
    attachmentMime = msg.voice.mime_type ?? "audio/ogg";
  } else if (msg.audio) {
    attachmentKind = "audio";
    attachmentFileId = msg.audio.file_id;
    attachmentSize = msg.audio.file_size;
    attachmentMime = msg.audio.mime_type;
  } else if (msg.document) {
    attachmentKind = "document";
    attachmentFileId = msg.document.file_id;
    attachmentSize = msg.document.file_size;
    attachmentMime = msg.document.mime_type;
  } else if (msg.photo && msg.photo.length > 0) {
    // Download the largest photo variant and save to inbox
    const largest = msg.photo[msg.photo.length - 1];
    attachmentKind = "photo";
    attachmentFileId = largest.file_id;
    attachmentSize = largest.file_size;
    attachmentMime = "image/jpeg";
    try {
      const fileInfo = await api.getFile(largest.file_id);
      const data = await api.downloadFile(fileInfo.file_path);
      const ext = fileInfo.file_path.split(".").pop() ?? "jpg";
      const localPath = join(INBOX_DIR, `${Date.now()}-${largest.file_unique_id}.${ext}`);
      writeFileSync(localPath, data);
      imagePath = localPath;
    } catch (err) {
      console.error("parachute-channel: failed to download photo:", err);
    }
  }

  const content = msg.text ?? msg.caption ?? "(voice message)";
  const ts = new Date(msg.date * 1000).toISOString();

  // Build the channel notification payload — matches the official plugin's shape
  const meta: Record<string, string> = {
    chat_id: String(msg.chat.id),
    message_id: String(msg.message_id),
    user: msg.from?.username ?? msg.from?.first_name ?? "unknown",
    user_id: String(userId),
    ts,
  };
  if (attachmentKind) meta.attachment_kind = attachmentKind;
  if (attachmentFileId) meta.attachment_file_id = attachmentFileId;
  if (attachmentSize) meta.attachment_size = String(attachmentSize);
  if (attachmentMime) meta.attachment_mime = attachmentMime;
  if (imagePath) meta.image_path = imagePath;

  // Broadcast to all connected bridges
  broadcastEvent("message", { content, meta, source: "telegram" });
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

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0,

  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/health") {
      return json({
        status: "ok",
        clients: clients.size,
        polling: pollActive,
      });
    }

    // SSE event stream — bridges connect here
    if (req.method === "GET" && url.pathname === "/events") {
      const clientId = crypto.randomUUID();
      const stream = new ReadableStream<string>({
        start(controller) {
          clients.set(clientId, {
            id: clientId,
            controller,
            connectedAt: Date.now(),
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

    // Reply
    if (req.method === "POST" && url.pathname === "/api/reply") {
      try {
        const body = (await req.json()) as {
          chat_id: string;
          text?: string;
          reply_to?: string;
          files?: string[];
        };

        const sentIds: number[] = [];

        // Send text if provided
        if (body.text) {
          // Chunk long messages (Telegram 4096 char limit)
          const chunks = chunkText(body.text, 4096);
          for (const chunk of chunks) {
            const id = await api.sendMessage(
              body.chat_id,
              chunk,
              body.reply_to ? { reply_to_message_id: parseInt(body.reply_to) } : undefined,
            );
            sentIds.push(id);
          }
        }

        // Send files if provided
        if (body.files) {
          for (const filePath of body.files) {
            const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
            const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
            const voiceExts = ["ogg", "oga", "opus"];
            let id: number;
            if (imageExts.includes(ext)) {
              id = await api.sendPhoto(body.chat_id, filePath);
            } else if (voiceExts.includes(ext)) {
              id = await api.sendVoice(body.chat_id, filePath);
            } else {
              id = await api.sendDocument(body.chat_id, filePath);
            }
            sentIds.push(id);
          }
        }

        return json({ sent: sentIds });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // React
    if (req.method === "POST" && url.pathname === "/api/react") {
      try {
        const body = (await req.json()) as {
          chat_id: string;
          message_id: string;
          emoji: string;
        };
        await api.setMessageReaction(body.chat_id, parseInt(body.message_id), body.emoji);
        return json({ ok: true });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // Edit message
    if (req.method === "POST" && url.pathname === "/api/edit") {
      try {
        const body = (await req.json()) as {
          chat_id: string;
          message_id: string;
          text: string;
        };
        await api.editMessageText(body.chat_id, parseInt(body.message_id), body.text);
        return json({ ok: true });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // Permission prompt — bridge forwards permission_request here, daemon
    // sends to all allowlisted Telegram users.
    if (req.method === "POST" && url.pathname === "/api/permission") {
      try {
        const body = (await req.json()) as {
          request_id: string;
          tool_name: string;
          description: string;
          input_preview: string;
        };
        const access = loadAccess();
        const targets = access.allowFrom;
        if (targets.length === 0) {
          return json({ error: "no allowlisted users to send permission prompt to" }, 400);
        }
        const text =
          `🔐 Permission: ${body.tool_name}\n\n` +
          `${body.description}\n\n` +
          `${body.input_preview}`;
        const replyMarkup = {
          inline_keyboard: [[
            { text: "✅ Allow", callback_data: `perm_allow_${body.request_id}` },
            { text: "❌ Deny", callback_data: `perm_deny_${body.request_id}` },
          ]],
        };
        const sent: number[] = [];
        for (const chatId of targets) {
          try {
            const id = await api.sendMessage(chatId, text, { reply_markup: replyMarkup });
            sent.push(id);
          } catch (err) {
            console.error(`parachute-channel: permission prompt to ${chatId} failed:`, err);
          }
        }
        return json({ sent });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    // Download attachment
    if (req.method === "POST" && url.pathname === "/api/download") {
      try {
        const body = (await req.json()) as { file_id: string };
        const fileInfo = await api.getFile(body.file_id);
        const data = await api.downloadFile(fileInfo.file_path);
        const ext = fileInfo.file_path.split(".").pop() ?? "bin";
        const localPath = join(INBOX_DIR, `${Date.now()}-${body.file_id.slice(-10)}.${ext}`);
        writeFileSync(localPath, data);
        return json({ path: localPath });
      } catch (err) {
        return json({ error: String(err) }, 500);
      }
    }

    return json({ error: "not found" }, 404);
  },
});

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) breakAt = maxLen; // no good newline, hard break
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

console.log(`parachute-channel: daemon listening on http://127.0.0.1:${PORT}`);
console.log(`parachute-channel: state dir: ${STATE_DIR}`);
console.log(`parachute-channel: ${clients.size} bridge(s) connected`);

// Graceful shutdown
process.on("SIGINT", () => { pollActive = false; server.stop(); process.exit(0); });
process.on("SIGTERM", () => { pollActive = false; server.stop(); process.exit(0); });

// Start polling (runs forever)
pollLoop().catch((err) => {
  console.error("parachute-channel: poll loop fatal:", err);
  process.exit(1);
});
