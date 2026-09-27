export interface InlineButton { text: string; callback_data: string }
export interface InlineKeyboard { inline_keyboard: InlineButton[][] }
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard: boolean;
  is_persistent: boolean;
}
export interface TelegramReply {
  text: string;
  reply_markup?: InlineKeyboard | ReplyKeyboard;
  message_thread_id?: number;
}
export interface TelegramBot {
  sendMessage(chatId: number, reply: TelegramReply): Promise<void>;
  answerCallbackQuery(id: string): Promise<void>;
}
export type TelegramEvent =
  | { kind: "message"; chatId: number; text?: string; threadId?: number }
  | { kind: "callback"; chatId: number; id: string; data: string; text: string; buttons: InlineButton[]; threadId?: number };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Whitelist the small subset of Telegram Update fields the adapter needs. */
export function parseTelegramEvent(value: unknown): TelegramEvent | null {
  const update = record(value);
  const callback = record(update.callback_query);
  const message = record(callback.message ?? update.message);
  const chat = record(message.chat);
  if (typeof chat.id !== "number" || !Number.isSafeInteger(chat.id)) return null;
  const threadId = typeof message.message_thread_id === "number" && Number.isSafeInteger(message.message_thread_id) ? message.message_thread_id : undefined;
  if (typeof callback.id === "string") {
    const keyboard = record(message.reply_markup).inline_keyboard;
    const buttons: InlineButton[] = [];
    if (Array.isArray(keyboard)) {
      for (const row of keyboard) {
        if (!Array.isArray(row)) continue;
        for (const raw of row) {
          const button = record(raw);
          if (typeof button.text === "string" && typeof button.callback_data === "string") {
            buttons.push({ text: button.text, callback_data: button.callback_data });
          }
        }
      }
    }
    return { kind: "callback", chatId: chat.id, id: callback.id, data: typeof callback.data === "string" ? callback.data : "", text: typeof message.text === "string" ? message.text : "", buttons, threadId };
  }
  if (record(message.from).is_bot === true) return null;
  return { kind: "message", chatId: chat.id, text: typeof message.text === "string" ? message.text : undefined, threadId };
}
