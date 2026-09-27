import "server-only";
import { getTelegramToken, TelegramError } from "./config";
import { visibleLength, withFooter } from "./footer";
import type { TelegramBot } from "./types";

type Method = "sendMessage" | "answerCallbackQuery" | "editMessageReplyMarkup" | "editMessageText" | "sendDocument";

// Telegram accepts documents up to 50 MB through the Bot API.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export function createTelegramBot(fetcher: typeof fetch = fetch): TelegramBot {
  async function call(method: Method, body: string | FormData, timeoutMs = 10_000): Promise<void> {
    const token = getTelegramToken();
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        // FormData sets its own multipart boundary header.
        headers: typeof body === "string" ? { "Content-Type": "application/json" } : undefined,
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      const result = await response.json() as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error("Telegram request failed");
    } catch {
      // Never retain the upstream error: its URL can contain the bot token.
      throw new TelegramError("API", "Pengiriman respons Telegram gagal.");
    }
  }
  return {
    async sendMessage(chatId, reply) {
      if (!reply.text || visibleLength(reply.text) > 4096) throw new TelegramError("API", "Panjang pesan Telegram tidak valid.");
      // The message is escaped for HTML mode and gets the shared footer exactly once.
      await call("sendMessage", JSON.stringify({
        chat_id: chatId, ...reply, text: withFooter(reply.text), parse_mode: "HTML", link_preview_options: { is_disabled: true },
      }));
    },
    async sendDocument(chatId, document, threadId) {
      if (!document.bytes.byteLength || document.bytes.byteLength > MAX_DOCUMENT_BYTES) {
        throw new TelegramError("API", "Ukuran dokumen Telegram tidak valid.");
      }
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (threadId !== undefined) form.set("message_thread_id", String(threadId));
      if (document.caption) {
        form.set("caption", withFooter(document.caption.slice(0, 900)));
        form.set("parse_mode", "HTML");
      }
      form.set("document", new Blob([document.bytes as Uint8Array<ArrayBuffer>], { type: document.mimeType }), document.filename);
      await call("sendDocument", form, 30_000);
    },
    async answerCallbackQuery(id) {
      await call("answerCallbackQuery", JSON.stringify({ callback_query_id: id }));
    },
    async editMessage(chatId, messageId, reply) {
      if (!reply.text || visibleLength(reply.text) > 4096) throw new TelegramError("API", "Panjang pesan Telegram tidak valid.");
      // Only inline keyboards can be edited in place; the footer is added the same way as for new messages.
      const markup = reply.reply_markup && "inline_keyboard" in reply.reply_markup ? { reply_markup: reply.reply_markup } : {};
      await call("editMessageText", JSON.stringify({
        chat_id: chatId, message_id: messageId, text: withFooter(reply.text), parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...markup,
      }));
    },
    async setInlineKeyboard(chatId, messageId, rows) {
      await call("editMessageReplyMarkup", JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows } }));
    },
  };
}
