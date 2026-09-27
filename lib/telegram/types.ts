import { stripFooter } from "./footer";

export interface InlineButton { text: string; callback_data: string }
export interface UrlButton { text: string; url: string }
export interface InlineKeyboard { inline_keyboard: (InlineButton | UrlButton)[][] }
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard: boolean;
  is_persistent: boolean;
}
/** Opens the reply box on the prompt, so the answer carries the prompt as context. */
export interface ForceReply { force_reply: true; input_field_placeholder?: string }
export interface TelegramReply {
  text: string;
  reply_markup?: InlineKeyboard | ReplyKeyboard | ForceReply;
  message_thread_id?: number;
}
export interface TelegramDocument { filename: string; bytes: Uint8Array; mimeType: string; caption?: string }
export interface TelegramBot {
  sendMessage(chatId: number, reply: TelegramReply): Promise<void>;
  sendDocument(chatId: number, document: TelegramDocument, threadId?: number): Promise<void>;
  answerCallbackQuery(id: string): Promise<void>;
  /** Replaces the buttons of a sent message; an empty list removes them. */
  setInlineKeyboard?(chatId: number, messageId: number, rows: (InlineButton | UrlButton)[][]): Promise<void>;
  /** Replaces the text and inline buttons of a sent message (pagination). */
  editMessage?(chatId: number, messageId: number, reply: TelegramReply): Promise<void>;
}
/** `userId` is the Telegram user (sender); `user` is a readable label for the history. */
export type TelegramEvent =
  | { kind: "message"; chatId: number; userId: number; text?: string; threadId?: number; replyToText?: string; user: string }
  | { kind: "callback"; chatId: number; userId: number; id: string; data: string; text: string; buttons: InlineButton[]; threadId?: number; messageId?: number; user: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// A readable label for the transaction history, e.g. "@budi (123456)".
function userId(from: Record<string, unknown>, chatId: number): number {
  return typeof from.id === "number" && Number.isSafeInteger(from.id) ? from.id : chatId;
}

function userLabel(from: Record<string, unknown>, chatId: number): string {
  const id = userId(from, chatId);
  const name = typeof from.username === "string" && from.username ? `@${from.username}`
    : [from.first_name, from.last_name].filter((part) => typeof part === "string" && part).join(" ");
  return `${name ? `${name.slice(0, 64)} ` : ""}(${id})`;
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
    const messageId = typeof message.message_id === "number" && Number.isSafeInteger(message.message_id) ? message.message_id : undefined;
    return {
      kind: "callback", chatId: chat.id, id: callback.id, data: typeof callback.data === "string" ? callback.data : "",
      text: typeof message.text === "string" ? stripFooter(message.text) : "", buttons, threadId, messageId,
      userId: userId(record(callback.from), chat.id), user: userLabel(record(callback.from), chat.id),
    };
  }
  const from = record(message.from);
  if (from.is_bot === true) return null;
  const replyTo = record(message.reply_to_message);
  // Bot messages come back with the shared footer; it is not part of their content.
  const replyToText = typeof replyTo.text === "string" ? stripFooter(replyTo.text) : undefined;
  return {
    kind: "message", chatId: chat.id, userId: userId(from, chat.id), text: typeof message.text === "string" ? message.text : undefined,
    threadId, replyToText, user: userLabel(from, chat.id),
  };
}
