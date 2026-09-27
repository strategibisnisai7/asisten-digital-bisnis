import "server-only";
import { getTelegramToken, TelegramError } from "./config";
import type { TelegramBot } from "./types";

export function createTelegramBot(fetcher: typeof fetch = fetch): TelegramBot {
  async function call(method: "sendMessage" | "answerCallbackQuery", payload: object): Promise<void> {
    const token = getTelegramToken();
    try {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json() as { ok?: boolean };
      if (!response.ok || body.ok !== true) throw new Error("Telegram request failed");
    } catch {
      // Never retain the upstream error: its URL can contain the bot token.
      throw new TelegramError("API", "Pengiriman respons Telegram gagal.");
    }
  }
  return {
    async sendMessage(chatId, reply) {
      if (!reply.text || reply.text.length > 4096) throw new TelegramError("API", "Panjang pesan Telegram tidak valid.");
      await call("sendMessage", { chat_id: chatId, ...reply, link_preview_options: { is_disabled: true } });
    },
    async answerCallbackQuery(id) {
      await call("answerCallbackQuery", { callback_query_id: id });
    },
  };
}
