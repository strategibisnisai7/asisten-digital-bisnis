import "server-only";
import { createHmac } from "node:crypto";
import type { StockChangeIntent } from "../parser/intents";
import { equalSecret } from "./config";
import type { InlineButton, TelegramEvent } from "./types";

/** Static navigation buttons. They carry no data, so they need no signature. */
export const MENU_ACTIONS = ["menu", "check", "search", "update", "upd_search", "stock_confirm", "stock_cancel", "supplier"] as const;
export type MenuAction = typeof MENU_ACTIONS[number];

export type CallbackAction =
  | { kind: "pick"; value: string; page: 0 }
  | { kind: "search" | "low"; value: string; page: number }
  | { kind: "menu"; value: MenuAction; page: 0 }
  // Picks a product for item `page` of a pending free-text stock request.
  | { kind: "resolve"; value: string; page: number; request: string }
  // Product-first Update Stok flow, bound to the chat and the user who started it.
  | { kind: "upd_pick"; sku: string }
  | { kind: "upd_action"; sku: string; intent: StockChangeIntent }
  | { kind: "upd_detail"; sku: string }
  | { kind: "upd_results"; query: string }
  // Supplier directory (read-only, public within the bot).
  | { kind: "supplier"; code: string };

type SignedAction = Extract<CallbackAction, { kind: "pick" | "search" | "low" }>;

// Telegram limits callback_data to 64 bytes.
const MAX_CALLBACK_BYTES = 64;
// Separates a product name from its SKU in a fallback button label.
const LABEL_SKU_SEPARATOR = " · ";

function sign(action: SignedAction, chatId: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify([chatId, action.kind, action.value, action.page]))
    .digest("base64url").slice(0, 22);
}

export function callbackData(action: SignedAction | Extract<CallbackAction, { kind: "menu" }>, chatId: number, secret: string): string {
  if (action.kind === "menu") return `m:${action.value}`;
  return `${action.kind}:${action.page}:${sign(action, chatId, secret)}`;
}

export function menuButton(text: string, action: MenuAction): InlineButton {
  return { text, callback_data: `m:${action}` };
}

/**
 * The signed SKU travels in callback_data so the label can show the product name.
 * An SKU too long for 64 bytes falls back to "<label> · <SKU>" in the label itself.
 */
export function productButton(label: string, sku: string, chatId: number, secret: string): InlineButton {
  const signature = sign({ kind: "pick", value: sku, page: 0 }, chatId, secret);
  const data = `sku:${signature}:${sku}`;
  if (Buffer.byteLength(data) <= MAX_CALLBACK_BYTES) return { text: label, callback_data: data };
  return { text: `${label}${LABEL_SKU_SEPARATOR}${sku}`, callback_data: `pick:0:${signature}` };
}

// The search query is signed together with the first line of the result message,
// so pagination needs no server-side session.
const SEARCH_HEADER = /^🔎 Saya menemukan \d+ barang untuk "(.+)"\.$/;
const LEGACY_SEARCH_PREFIX = "Pencarian: ";

export function searchHeader(count: number, query: string): string {
  return `🔎 Saya menemukan ${count} barang untuk "${query}".`;
}

export function readSearchQuery(text: string): string {
  const firstLine = text.split("\n")[0];
  const match = firstLine.match(SEARCH_HEADER);
  if (match) return match[1];
  return firstLine.startsWith(LEGACY_SEARCH_PREFIX) ? firstLine.slice(LEGACY_SEARCH_PREFIX.length) : "";
}

export function supplierButton(label: string, code: string): InlineButton {
  return { text: label, callback_data: `sp:${code}`.slice(0, MAX_CALLBACK_BYTES) };
}

// ---------------------------------------------------------------- Update Stok (product-first)

/**
 * The flow's state lives in Telegram itself: each button carries the selected SKU
 * (and action) signed together with the chat and user, so no server session is
 * needed and one user cannot act on another user's buttons.
 */
const UPDATE_ACTION_CODES: Record<StockChangeIntent, string> = { ADD_STOCK: "i", REDUCE_STOCK: "o", SET_STOCK: "k" };
const UPDATE_ACTIONS = Object.fromEntries(Object.entries(UPDATE_ACTION_CODES).map(([intent, code]) => [code, intent])) as Record<string, StockChangeIntent>;

function updateSignature(chatId: number, userId: number, parts: readonly string[], secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([chatId, userId, "update", ...parts])).digest("base64url").slice(0, 16);
}

function fits(data: string): string | null {
  return Buffer.byteLength(data) <= MAX_CALLBACK_BYTES ? data : null;
}

export interface UpdateScope { chatId: number; userId: number; secret: string }

export function updatePickButton(label: string, sku: string, scope: UpdateScope): InlineButton | null {
  const data = fits(`up:${updateSignature(scope.chatId, scope.userId, ["pick", sku], scope.secret)}:${sku}`);
  return data ? { text: label, callback_data: data } : null;
}

export function updateActionButton(label: string, intent: StockChangeIntent, sku: string, scope: UpdateScope): InlineButton | null {
  const code = UPDATE_ACTION_CODES[intent];
  const data = fits(`ua:${code}:${updateSignature(scope.chatId, scope.userId, ["action", code, sku], scope.secret)}:${sku}`);
  return data ? { text: label, callback_data: data } : null;
}

/** Back to the product detail (cancel on the quantity step or on the preview). */
export function updateDetailButton(label: string, sku: string, scope: UpdateScope): InlineButton | null {
  const data = fits(`ux:${updateSignature(scope.chatId, scope.userId, ["detail", sku], scope.secret)}:${sku}`);
  return data ? { text: label, callback_data: data } : null;
}

/** Back to the search results; a query too long for callback_data returns to the search prompt. */
export function updateResultsButton(label: string, query: string, scope: UpdateScope): InlineButton {
  const data = fits(`ub:${updateSignature(scope.chatId, scope.userId, ["results", query], scope.secret)}:${query}`);
  return { text: label, callback_data: data ?? "m:upd_search" };
}

// ---------------------------------------------------------------- sealed messages

/**
 * A sealed message carries its own pending state: the text lists what will happen
 * and the last line holds the issue time and an HMAC over the chat, the user, and
 * the text. Replies and buttons re-read that text instead of a server session.
 * "UPD" seals a stock summary awaiting confirmation; "QTY" a quantity prompt.
 */
export type SealKind = "UPD" | "QTY";
export const SEAL_TTL_MS = 30 * 60 * 1000;

function canonical(text: string): string {
  return text.split("\n").map((line) => line.trim()).join("\n").trim();
}

function sealSignature(kind: SealKind, body: string, issued: string, chatId: number, userId: number, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([chatId, userId, kind, issued, canonical(body)])).digest("hex").slice(0, 12).toUpperCase();
}

export function sealMessage(kind: SealKind, body: string, scope: UpdateScope, now = Date.now()): string {
  const issued = Math.floor(now / 1000).toString(36).toUpperCase();
  return `${body}\n\nKode: ${kind}-${issued}-${sealSignature(kind, body, issued, scope.chatId, scope.userId, scope.secret)}`;
}

export type OpenedSeal = { status: "VALID"; body: string } | { status: "EXPIRED" } | { status: "INVALID" };

export function openSealedMessage(kind: SealKind, text: string, scope: UpdateScope, now = Date.now()): OpenedSeal {
  const lines = canonical(text).split("\n");
  const match = lines.at(-1)?.match(/^Kode: (UPD|QTY)-([0-9A-Z]{1,10})-([0-9A-F]{12})$/);
  if (!match || match[1] !== kind) return { status: "INVALID" };
  const body = lines.slice(0, -1).join("\n");
  if (!equalSecret(match[3], sealSignature(kind, body, match[2], scope.chatId, scope.userId, scope.secret))) return { status: "INVALID" };
  const issuedMs = parseInt(match[2], 36) * 1000;
  if (!Number.isFinite(issuedMs) || now - issuedMs > SEAL_TTL_MS || issuedMs - now > 60_000) return { status: "EXPIRED" };
  return { status: "VALID", body };
}

// ---------------------------------------------------------------- free-text stock requests

// A pending free-text request is written into the choice message after this label, so
// the request can continue after a product is picked without any stored session.
export const STOCK_REQUEST_LABEL = "Permintaan:";

function readStockRequest(text: string): string {
  const lines = text.split("\n").map((line) => line.trim());
  const index = lines.indexOf(STOCK_REQUEST_LABEL);
  return index === -1 ? "" : lines[index + 1] ?? "";
}

function signResolve(chatId: number, request: string, index: number, sku: string, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([chatId, "resolve", request, index, sku])).digest("base64url").slice(0, 22);
}

export function resolveButton(label: string, request: string, index: number, sku: string, chatId: number, secret: string): InlineButton {
  const data = `rs:${index}:${signResolve(chatId, request, index, sku, secret)}:${sku}`;
  // Callback data is limited to 64 bytes; an SKU too long for it cannot be offered here.
  if (Buffer.byteLength(data) > MAX_CALLBACK_BYTES) throw new RangeError("SKU terlalu panjang untuk tombol pilihan.");
  return { text: label, callback_data: data };
}

// ---------------------------------------------------------------- reading callbacks

export function readCallback(event: Extract<TelegramEvent, { kind: "callback" }>, secret: string): CallbackAction | null {
  const menu = event.data.match(/^m:([a-z_]{1,20})$/);
  if (menu) {
    return (MENU_ACTIONS as readonly string[]).includes(menu[1]) ? { kind: "menu", value: menu[1] as MenuAction, page: 0 } : null;
  }

  const supplier = event.data.match(/^sp:(.{1,60})$/);
  if (supplier) return { kind: "supplier", code: supplier[1] };

  const update = event.data.match(/^(up|ux|ub):([A-Za-z0-9_-]{16}):(.+)$/) ?? event.data.match(/^(ua):([iok]):([A-Za-z0-9_-]{16}):(.+)$/);
  if (update) {
    const valid = (parts: string[], signature: string) =>
      equalSecret(signature, updateSignature(event.chatId, event.userId, parts, secret));
    if (update[1] === "ua") {
      const [, , code, signature, sku] = update;
      return valid(["action", code, sku], signature) ? { kind: "upd_action", sku, intent: UPDATE_ACTIONS[code] } : null;
    }
    const [, prefix, signature, value] = update;
    if (prefix === "up") return valid(["pick", value], signature) ? { kind: "upd_pick", sku: value } : null;
    if (prefix === "ux") return valid(["detail", value], signature) ? { kind: "upd_detail", sku: value } : null;
    return valid(["results", value], signature) ? { kind: "upd_results", query: value } : null;
  }

  const resolve = event.data.match(/^rs:(\d{1,2}):([A-Za-z0-9_-]{22}):(.+)$/);
  if (resolve) {
    const request = readStockRequest(event.text);
    const index = Number(resolve[1]);
    if (!request || !equalSecret(resolve[2], signResolve(event.chatId, request, index, resolve[3], secret))) return null;
    return { kind: "resolve", value: resolve[3], page: index, request };
  }

  let action: SignedAction;
  let signature: string;
  const skuData = event.data.match(/^sku:([A-Za-z0-9_-]{22}):(.+)$/);
  const signed = event.data.match(/^(pick|search|low):(\d{1,6}):([A-Za-z0-9_-]{22})$/);
  if (skuData) {
    action = { kind: "pick", value: skuData[2], page: 0 };
    signature = skuData[1];
  } else if (signed) {
    const kind = signed[1] as SignedAction["kind"];
    const page = Number(signed[2]);
    signature = signed[3];
    if (kind === "pick") {
      if (page !== 0) return null;
      // Older messages used the bare SKU as the label.
      const label = event.buttons.find((button) => button.callback_data === event.data)?.text ?? "";
      const separator = label.lastIndexOf(LABEL_SKU_SEPARATOR);
      const value = separator === -1 ? label : label.slice(separator + LABEL_SKU_SEPARATOR.length);
      if (!value) return null;
      action = { kind, value, page: 0 };
    } else {
      const value = kind === "search" ? readSearchQuery(event.text) : "";
      if (kind === "search" && !value) return null;
      action = { kind, value, page };
    }
  } else {
    return null;
  }
  return equalSecret(signature, sign(action, event.chatId, secret)) ? action : null;
}
