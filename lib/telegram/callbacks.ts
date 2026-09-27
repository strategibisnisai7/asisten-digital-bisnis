import "server-only";
import { createHmac } from "node:crypto";
import { equalSecret } from "./config";
import type { TelegramEvent } from "./types";

export type CallbackAction = { kind: "pick"; value: string; page: 0 } | { kind: "search" | "low"; value: string; page: number };
export const QUERY_PREFIX = "Pencarian: ";

export function callbackData(action: CallbackAction, chatId: number, secret: string): string {
  const signature = createHmac("sha256", secret)
    .update(JSON.stringify([chatId, action.kind, action.value, action.page]))
    .digest("base64url").slice(0, 22);
  return `${action.kind}:${action.page}:${signature}`;
}

// The signed SKU lives in its button label; the signed search query in the first
// message line. No process-local sessions or 64-byte SKU encoding are needed.
export function readCallback(event: Extract<TelegramEvent, { kind: "callback" }>, secret: string): CallbackAction | null {
  const match = event.data.match(/^(pick|search|low):(\d{1,6}):[A-Za-z0-9_-]{22}$/);
  if (!match) return null;
  const kind = match[1] as CallbackAction["kind"];
  const page = Number(match[2]);
  let value = "";
  if (kind === "pick") {
    if (page !== 0) return null;
    value = event.buttons.find((button) => button.callback_data === event.data)?.text ?? "";
    if (!value) return null;
  } else if (kind === "search") {
    const firstLine = event.text.split("\n")[0];
    if (!firstLine.startsWith(QUERY_PREFIX)) return null;
    value = firstLine.slice(QUERY_PREFIX.length);
    if (!value) return null;
  }
  const action: CallbackAction = kind === "pick" ? { kind, value, page: 0 } : { kind, value, page };
  return equalSecret(event.data, callbackData(action, event.chatId, secret)) ? action : null;
}
