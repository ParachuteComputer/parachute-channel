/**
 * Telegram transport for parachute-channel.
 *
 * Owns everything Telegram: the getUpdates long-poll, message + callback-query
 * handling, attachment download, access control (access.json), the permission
 * inline-keyboard + y/n verdict intercept, and 4096-char chunking.
 *
 * This is the reference Transport implementation. Behavior is preserved
 * verbatim from the pre-refactor daemon — the only change is that inbound
 * messages and permission verdicts now go through `ctx.emit` /
 * `ctx.emitPermissionVerdict` instead of a global broadcast, so the daemon can
 * route them to the right channel's subscribers.
 */

import { TelegramApi, type TelegramMessage, type TelegramCallbackQuery } from "../telegram/api.ts";
import type {
  Transport,
  TransportContext,
  ReplyArgs,
  ReactArgs,
  EditArgs,
  PermissionArgs,
  DownloadArgs,
} from "../transport.ts";
import { ChannelConfigError } from "../transport.ts";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ---------------------------------------------------------------------------
// Access control — reuse the official plugin's access.json format, plus one
// parachute-channel extension: `allowInChats`.
//
// Fields (all inherited from the official plugin except `allowInChats`):
//   dmPolicy      — "open" short-circuits all gating; anything else requires
//                   the user to pass `allowFrom`.
//   allowFrom     — user-ID allowlist. Checked against `msg.from.id` /
//                   `cq.from.id`.
//   allowInChats  — OPTIONAL chat-ID allowlist. Two roles:
//                   (1) For DMs (positive chat_id === user_id), the chat must
//                       be listed AND the user must pass `allowFrom`.
//                   (2) For groups (negative chat_id), inclusion grants entry
//                       to ANY member of that group — `allowFrom` is bypassed.
//                       This lets the agent participate in shared spaces
//                       without enumerating every member.
//                   Absent → user-allowlist only (backwards-compatible, no
//                   per-chat gating, no group bypass). Empty array → FAIL-
//                   CLOSED: no chats allowed. To permit a DM while gating
//                   groups, list the user's own ID in `allowInChats`.
//   groups, pending — used by the official plugin's pairing flow; read but
//                     not otherwise acted on here.
// ---------------------------------------------------------------------------

export interface AccessConfig {
  dmPolicy: "open" | "pairing" | "allowlist";
  allowFrom: string[];
  allowInChats?: string[];
  groups: Record<string, unknown>;
  pending: Record<string, unknown>;
}

export function loadAccess(accessFile: string): AccessConfig {
  try {
    return JSON.parse(readFileSync(accessFile, "utf8"));
  } catch {
    return { dmPolicy: "open", allowFrom: [], groups: {}, pending: {} };
  }
}

/**
 * Pure access decision, factored out so the policy is unit-testable without a
 * live Telegram connection. See telegram.test.ts.
 */
export function isAllowedFor(
  access: AccessConfig,
  userId: number,
  chatId: number | string | undefined,
): boolean {
  if (access.dmPolicy === "open") return true;

  // Group-chat bypass: if a group chat (negative chat_id, Telegram convention)
  // is explicitly allowlisted via `allowInChats`, any user who can post in
  // that group may reach the bot. This lets the agent participate in shared
  // spaces like Regen Hub working groups without having to enumerate every
  // member in `allowFrom`. DMs (chat_id === user_id, positive) are NOT
  // covered by this bypass — they still require `allowFrom`.
  const chatIdStr = chatId === undefined ? undefined : String(chatId);
  const isGroup = chatIdStr !== undefined && chatIdStr.startsWith("-");
  if (isGroup && access.allowInChats?.includes(chatIdStr!)) return true;

  if (!access.allowFrom.includes(String(userId))) return false;
  if (access.allowInChats !== undefined) {
    if (chatIdStr === undefined) return false;
    if (!access.allowInChats.includes(chatIdStr)) return false;
  }
  return true;
}

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
const CALLBACK_DATA_RE = /^perm_(allow|deny)_([a-km-z]{5})$/;

/** Config for a Telegram transport instance. */
export interface TelegramTransportConfig {
  /** Bot token. Falls back to TELEGRAM_BOT_TOKEN env when omitted. */
  token?: string;
  /** Directory holding access.json + inbox/. Defaults to the channel state dir. */
  stateDir?: string;
}

export class TelegramTransport implements Transport {
  readonly kind = "telegram";

  private api: TelegramApi;
  private accessFile: string;
  private inboxDir: string;
  private offset: number | undefined;
  private pollActive = false;
  private pollTask: Promise<void> | undefined;

  constructor(config: TelegramTransportConfig = {}) {
    const token = config.token ?? process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        "TelegramTransport: bot token required (config.token or TELEGRAM_BOT_TOKEN)",
      );
    }
    const stateDir =
      config.stateDir ??
      process.env.PARACHUTE_CHANNEL_STATE_DIR ??
      join(homedir(), ".parachute", "channel");
    this.api = new TelegramApi(token);
    this.accessFile = join(stateDir, "access.json");
    this.inboxDir = join(stateDir, "inbox");
    mkdirSync(this.inboxDir, { recursive: true });
  }

  private isAllowed(userId: number, chatId: number | string | undefined): boolean {
    return isAllowedFor(loadAccess(this.accessFile), userId, chatId);
  }

  async start(ctx: TransportContext): Promise<void> {
    this.pollActive = true;
    this.pollTask = this.pollLoop(ctx);
    // Don't await the loop — it runs forever.
  }

  async stop(): Promise<void> {
    this.pollActive = false;
    // The current getUpdates long-poll may still be in flight; we don't await
    // it (it returns within the 30s timeout and then sees pollActive=false).
  }

  private async pollLoop(ctx: TransportContext): Promise<void> {
    try {
      const me = await this.api.getMe();
      console.log(`parachute-channel[${ctx.channel}]: polling as @${me.username}`);
    } catch (err) {
      console.error(`parachute-channel[${ctx.channel}]: getMe failed:`, err);
    }

    while (this.pollActive) {
      try {
        const updates = await this.api.getUpdates(this.offset, 30);
        for (const update of updates) {
          this.offset = update.update_id + 1;
          if (update.callback_query) {
            await this.handleCallbackQuery(ctx, update.callback_query);
          } else if (update.message) {
            await this.handleMessage(ctx, update.message);
          }
        }
      } catch (err) {
        console.error(`parachute-channel[${ctx.channel}]: poll error:`, err);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async handleCallbackQuery(
    ctx: TransportContext,
    cq: TelegramCallbackQuery,
  ): Promise<void> {
    const userId = cq.from.id;
    if (!this.isAllowed(userId, cq.message?.chat.id)) {
      await this.api.answerCallbackQuery(cq.id).catch(() => {});
      return;
    }

    const data = cq.data ?? "";
    const match = CALLBACK_DATA_RE.exec(data);
    if (!match) {
      await this.api.answerCallbackQuery(cq.id).catch(() => {});
      return;
    }

    const behavior = match[1] as "allow" | "deny";
    const requestId = match[2]!;
    ctx.emitPermissionVerdict({ request_id: requestId, behavior });

    // Answer the callback query (stops button loading spinner)
    const label = behavior === "allow" ? "✅ Allowed" : "❌ Denied";
    await this.api.answerCallbackQuery(cq.id, { text: label }).catch(() => {});

    // Edit the original message to show the outcome and remove buttons
    if (cq.message) {
      const chatId = String(cq.message.chat.id);
      const originalText = cq.message.text ?? "";
      await this.api
        .editMessageText(chatId, cq.message.message_id, `${label}\n\n${originalText}`)
        .catch(() => {});
    }
  }

  private async handleMessage(ctx: TransportContext, msg: TelegramMessage): Promise<void> {
    const userId = msg.from?.id;
    if (!userId || !this.isAllowed(userId, msg.chat.id)) return;

    const userTag = msg.from?.username
      ? `@${msg.from.username}`
      : msg.from?.first_name ?? `user ${userId}`;
    console.log(
      `parachute-channel[${ctx.channel}]: rx from ${userTag} in chat ${msg.chat.id}`,
    );

    // Permission-reply intercept: if this looks like "yes xxxxx" or "no xxxxx"
    // for a pending permission request, emit a permission_verdict instead of
    // forwarding as a chat message.
    const text = msg.text ?? "";
    const permMatch = PERMISSION_REPLY_RE.exec(text);
    if (permMatch) {
      const requestId = permMatch[2]!.toLowerCase();
      const behavior = permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny";
      ctx.emitPermissionVerdict({ request_id: requestId, behavior });
      // React to confirm receipt
      const emoji = behavior === "allow" ? "✅" : "❌";
      try {
        await this.api.setMessageReaction(String(msg.chat.id), msg.message_id, emoji);
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
      const largest = msg.photo[msg.photo.length - 1]!;
      attachmentKind = "photo";
      attachmentFileId = largest.file_id;
      attachmentSize = largest.file_size;
      attachmentMime = "image/jpeg";
      try {
        const fileInfo = await this.api.getFile(largest.file_id);
        const data = await this.api.downloadFile(fileInfo.file_path);
        const ext = fileInfo.file_path.split(".").pop() ?? "jpg";
        const localPath = join(this.inboxDir, `${Date.now()}-${largest.file_unique_id}.${ext}`);
        writeFileSync(localPath, data);
        imagePath = localPath;
      } catch (err) {
        console.error(`parachute-channel[${ctx.channel}]: failed to download photo:`, err);
      }
    }

    // Service events (new_chat_members, left_chat_member, pinned_message,
    // migrate_*, chat-title changes, etc.) arrive as messages with no text,
    // no caption, and no media. We have no way for the agent to act on them,
    // and the previous "(voice message)" placeholder caused the agent to
    // report a nonexistent voice memo on every bot-add. Drop silently.
    if (!msg.text && !msg.caption && !attachmentKind) return;
    const content = msg.text ?? msg.caption ?? `(${attachmentKind})`;
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

    ctx.emit({ channel: ctx.channel, content, meta, source: "telegram" });
  }

  // -------------------------------------------------------------------------
  // Outbound — Telegram chat_id travels in args.meta.chat_id
  // -------------------------------------------------------------------------

  private chatIdFrom(meta: Record<string, string> | undefined, field = "chat_id"): string {
    const chatId = meta?.[field];
    if (!chatId) {
      throw new Error(`telegram transport: meta.${field} is required`);
    }
    return chatId;
  }

  async reply(args: ReplyArgs): Promise<{ sent: string[] }> {
    const chatId = this.chatIdFrom(args.meta);
    const sentIds: string[] = [];

    if (args.text) {
      // Chunk long messages (Telegram 4096 char limit)
      const chunks = chunkText(args.text, 4096);
      for (const chunk of chunks) {
        const id = await this.api.sendMessage(
          chatId,
          chunk,
          args.reply_to ? { reply_to_message_id: parseInt(args.reply_to) } : undefined,
        );
        sentIds.push(String(id));
      }
    }

    if (args.files) {
      for (const filePath of args.files) {
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        const imageExts = ["jpg", "jpeg", "png", "gif", "webp"];
        const voiceExts = ["ogg", "oga", "opus"];
        let id: number;
        if (imageExts.includes(ext)) {
          id = await this.api.sendPhoto(chatId, filePath);
        } else if (voiceExts.includes(ext)) {
          id = await this.api.sendVoice(chatId, filePath);
        } else {
          id = await this.api.sendDocument(chatId, filePath);
        }
        sentIds.push(String(id));
      }
    }

    return { sent: sentIds };
  }

  async react(args: ReactArgs): Promise<void> {
    const chatId = this.chatIdFrom(args.meta);
    await this.api.setMessageReaction(chatId, parseInt(args.message_id), args.emoji);
  }

  async edit(args: EditArgs): Promise<void> {
    const chatId = this.chatIdFrom(args.meta);
    await this.api.editMessageText(chatId, parseInt(args.message_id), args.text);
  }

  async sendPermission(args: PermissionArgs): Promise<{ sent: string[] }> {
    const access = loadAccess(this.accessFile);
    const targets = access.allowFrom;
    if (targets.length === 0) {
      throw new ChannelConfigError("no allowlisted users to send permission prompt to");
    }
    const text =
      `🔐 Permission: ${args.tool_name}\n\n` +
      `${args.description}\n\n` +
      `${args.input_preview}`;
    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "✅ Allow", callback_data: `perm_allow_${args.request_id}` },
          { text: "❌ Deny", callback_data: `perm_deny_${args.request_id}` },
        ],
      ],
    };
    const sent: string[] = [];
    for (const chatId of targets) {
      try {
        const id = await this.api.sendMessage(chatId, text, { reply_markup: replyMarkup });
        sent.push(String(id));
      } catch (err) {
        console.error(`parachute-channel: permission prompt to ${chatId} failed:`, err);
      }
    }
    return { sent };
  }

  async download(args: DownloadArgs): Promise<{ path: string }> {
    const fileInfo = await this.api.getFile(args.file_id);
    const data = await this.api.downloadFile(fileInfo.file_path);
    const ext = fileInfo.file_path.split(".").pop() ?? "bin";
    const localPath = join(this.inboxDir, `${Date.now()}-${args.file_id.slice(-10)}.${ext}`);
    writeFileSync(localPath, data);
    return { path: localPath };
  }
}

/** Split text into <=maxLen chunks, preferring newline breaks. Exported for tests. */
export function chunkText(text: string, maxLen: number): string[] {
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
