import "server-only";
import { createHmac } from "node:crypto";
import { equalSecret } from "./config";
import type { InlineButton, TelegramEvent } from "./types";

/** Static navigation buttons. They carry no data, so they need no signature. */
export const MENU_ACTIONS = [
  "menu", "check", "search", "update", "stock_in", "stock_out", "stock_fix", "stock_confirm", "stock_cancel",
  "supplier", "supplier_order", "supplier_list", "supplier_cancel",
] as const;
export type MenuAction = typeof MENU_ACTIONS[number];

export type CallbackAction =
  | { kind: "pick"; value: string; page: 0 }
  | { kind: "search" | "low"; value: string; page: number }
  | { kind: "menu"; value: MenuAction; page: 0 }
  // Picks a product for item `page` of a pending stock request.
  | { kind: "resolve"; value: string; page: number; request: string };

type SignedAction = Exclude<CallbackAction, { kind: "menu" | "resolve" }>;

// Telegram limits callback_data to 64 bytes.
const MAX_CALLBACK_BYTES = 64;
// Separates a product name from its SKU in a fallback button label.
const LABEL_SKU_SEPARATOR = " · ";

function sign(action: SignedAction, chatId: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify([chatId, action.kind, action.value, action.page]))
    .digest("base64url").slice(0, 22);
}

export function callbackData(action: Exclude<CallbackAction, { kind: "resolve" }>, chatId: number, secret: string): string {
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

function readSearchQuery(text: string): string {
  const firstLine = text.split("\n")[0];
  const match = firstLine.match(SEARCH_HEADER);
  if (match) return match[1];
  return firstLine.startsWith(LEGACY_SEARCH_PREFIX) ? firstLine.slice(LEGACY_SEARCH_PREFIX.length) : "";
}

// ---------------------------------------------------------------- stock updates

// A pending stock request is written into the choice message after this label, so the
// request can continue after a product is picked without any stored session.
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

/**
 * The stock summary is the pending transaction: its text lists SKU and before/after
 * values, and the last line carries a reference with the issue time and an HMAC over
 * the chat and the text. Confirming (button, or replying "ya") re-reads this text.
 */
const SUMMARY_REF_PREFIX = "Kode: UPD-";
export const STOCK_SUMMARY_TTL_MS = 30 * 60 * 1000;

function canonical(text: string): string {
  return text.split("\n").map((line) => line.trim()).join("\n").trim();
}

function summarySignature(body: string, issued: string, chatId: number, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify([chatId, "stock", issued, canonical(body)])).digest("hex").slice(0, 12).toUpperCase();
}

export function sealStockSummary(body: string, chatId: number, secret: string, now = Date.now()): string {
  const issued = Math.floor(now / 1000).toString(36).toUpperCase();
  return `${body}\n\n${SUMMARY_REF_PREFIX}${issued}-${summarySignature(body, issued, chatId, secret)}`;
}

export type OpenedSummary = { status: "VALID"; body: string } | { status: "EXPIRED" } | { status: "INVALID" };

export function openStockSummary(text: string, chatId: number, secret: string, now = Date.now()): OpenedSummary {
  const lines = canonical(text).split("\n");
  const match = lines.at(-1)?.match(/^Kode: UPD-([0-9A-Z]{1,10})-([0-9A-F]{12})$/);
  if (!match) return { status: "INVALID" };
  const body = lines.slice(0, -1).join("\n");
  if (!equalSecret(match[2], summarySignature(body, match[1], chatId, secret))) return { status: "INVALID" };
  const issuedMs = parseInt(match[1], 36) * 1000;
  if (!Number.isFinite(issuedMs) || now - issuedMs > STOCK_SUMMARY_TTL_MS || issuedMs - now > 60_000) return { status: "EXPIRED" };
  return { status: "VALID", body };
}

export function readCallback(event: Extract<TelegramEvent, { kind: "callback" }>, secret: string): CallbackAction | null {
  const menu = event.data.match(/^m:([a-z_]{1,20})$/);
  if (menu) {
    return (MENU_ACTIONS as readonly string[]).includes(menu[1]) ? { kind: "menu", value: menu[1] as MenuAction, page: 0 } : null;
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
