/**
 * Minimal Telegram Bot API client. Only the methods we actually use.
 */

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number; first_name: string; username?: string; is_bot: boolean };
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string };
  from?: { id: number; first_name: string; username?: string; is_bot: boolean };
  date: number;
  text?: string;
  voice?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; file_unique_id: string; duration: number; mime_type?: string; file_size?: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  caption?: string;
}

export class TelegramApi {
  private base: string;

  constructor(private token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset?: number, timeout = 30): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({ timeout: String(timeout) });
    if (offset !== undefined) params.set("offset", String(offset));
    const res = await fetch(`${this.base}/getUpdates?${params}`);
    if (!res.ok) throw new Error(`getUpdates ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
    if (!json.ok) throw new Error(`getUpdates not ok: ${JSON.stringify(json)}`);
    return json.result;
  }

  async sendMessage(chatId: number | string, text: string, opts?: { reply_to_message_id?: number; reply_markup?: unknown }): Promise<number> {
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts?.reply_to_message_id) body.reply_to_message_id = opts.reply_to_message_id;
    if (opts?.reply_markup) body.reply_markup = opts.reply_markup;
    const res = await fetch(`${this.base}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`sendMessage ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { message_id: number } };
    return json.result.message_id;
  }

  async sendDocument(chatId: number | string, filePath: string, caption?: string): Promise<number> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const file = Bun.file(filePath);
    form.append("document", file);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${this.base}/sendDocument`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendDocument ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { message_id: number } };
    return json.result.message_id;
  }

  async sendPhoto(chatId: number | string, filePath: string, caption?: string): Promise<number> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const file = Bun.file(filePath);
    form.append("photo", file);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${this.base}/sendPhoto`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendPhoto ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { message_id: number } };
    return json.result.message_id;
  }

  async sendVoice(chatId: number | string, filePath: string, caption?: string): Promise<number> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const file = Bun.file(filePath);
    form.append("voice", file);
    if (caption) form.append("caption", caption);
    const res = await fetch(`${this.base}/sendVoice`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`sendVoice ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { message_id: number } };
    return json.result.message_id;
  }

  async setMessageReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    const res = await fetch(`${this.base}/setMessageReaction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
    if (!res.ok) throw new Error(`setMessageReaction ${res.status}: ${await res.text()}`);
  }

  async editMessageText(chatId: number | string, messageId: number, text: string, opts?: { reply_markup?: unknown }): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
    if (opts?.reply_markup) body.reply_markup = opts.reply_markup;
    const res = await fetch(`${this.base}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`editMessageText ${res.status}: ${await res.text()}`);
  }

  async answerCallbackQuery(callbackQueryId: string, opts?: { text?: string }): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
    if (opts?.text) body.text = opts.text;
    const res = await fetch(`${this.base}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`answerCallbackQuery ${res.status}: ${await res.text()}`);
  }

  async getFile(fileId: string): Promise<{ file_path: string }> {
    const res = await fetch(`${this.base}/getFile?file_id=${fileId}`);
    if (!res.ok) throw new Error(`getFile ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { file_path: string } };
    return json.result;
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`downloadFile ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getMe(): Promise<{ username: string; first_name: string }> {
    const res = await fetch(`${this.base}/getMe`);
    if (!res.ok) throw new Error(`getMe ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { ok: boolean; result: { username: string; first_name: string } };
    return json.result;
  }
}
