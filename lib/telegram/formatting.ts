import type { InventoryProduct, InventoryResult } from "../inventory/inventory-engine";
import { callbackData, QUERY_PREFIX } from "./callbacks";
import type { InlineButton, ReplyKeyboard, TelegramReply } from "./types";

export const MAIN_MENU: ReplyKeyboard = {
  keyboard: [
    [{ text: "🔍 Cek Stok" }, { text: "⚠️ Stok Menipis" }],
    [{ text: "📋 Cari Barang" }, { text: "❓ Bantuan" }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const HELP_TEXT = [
  "Stok? Tinggal Chat.",
  "Ketik nama barang atau SKU, atau gunakan menu di bawah.",
  "", "Contoh:", "• stok minyak goreng", "• minyak goreng", "• cari beras",
  "• barang apa yang hampir habis", "• bantuan",
  "", "Bot saat ini hanya membaca inventory. Perubahan stok dan pesanan belum tersedia.",
].join("\n");

export function menuReply(text: string): TelegramReply {
  return { text, reply_markup: MAIN_MENU };
}

function compact(value: string, limit = 160): string {
  const text = value.replace(/\s+/g, " ").trim() || "—";
  return text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

export function formatProduct(product: InventoryProduct): TelegramReply {
  // Plain text deliberately avoids Markdown/HTML injection from sheet content.
  return menuReply([
    `📦 ${compact(product.name, 240)}`,
    `SKU: ${compact(product.sku, 240)}`,
    `Stok: ${product.currentStock}`,
    `Satuan: ${compact(product.unit)}`,
    `Stok Minimum: ${product.minimumStock ?? "Belum ditentukan"}`,
    `Status: ${compact(product.status)}`,
    `Lokasi Rak: ${compact(product.rack)}`,
    `Supplier: ${compact(product.supplier)}`,
  ].join("\n"));
}

export interface FormatContext { chatId: number; secret: string; query: string; page?: number }
export const PAGE_SIZE = 8;

export function formatInventoryResult(result: InventoryResult, context: FormatContext): TelegramReply {
  if (result.status === "NOT_FOUND") return menuReply("Produk tidak ditemukan.");
  if (result.status === "INVALID_QUERY") return menuReply("Ketik nama barang atau SKU yang ingin dicek/dicari. Contoh: minyak goreng.");
  if (result.status === "UNSUPPORTED_INTENT") return menuReply("Perubahan stok dan pembuatan pesanan belum tersedia. Gunakan menu untuk membaca inventory.");
  if ("product" in result) return formatProduct(result.product);

  const low = result.intent === "LOW_STOCK";
  const products = result.products;
  if (products.length === 0) return menuReply(low ? "Tidak ada barang dengan stok di bawah atau sama dengan stok minimum." : "Produk tidak ditemukan.");
  if (!low && products.length === 1) return formatProduct(products[0]);

  const pageCount = Math.ceil(products.length / PAGE_SIZE);
  const page = Math.max(0, Math.min(Math.floor(context.page ?? 0), pageCount - 1));
  const visible = products.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lines = [low ? "⚠️ Stok Menipis" : `${QUERY_PREFIX}${context.query}`, `${products.length} barang • Halaman ${page + 1}/${pageCount}`, ""];
  const keyboard: InlineButton[][] = [];
  for (const [index, product] of visible.entries()) {
    lines.push(`${page * PAGE_SIZE + index + 1}. ${compact(product.name, 100)}`);
    lines.push(`SKU: ${compact(product.sku, 80)} • Stok: ${product.currentStock} ${compact(product.unit, 20)}${low ? ` • Minimum: ${product.minimumStock}` : ""}`);
    keyboard.push([{ text: product.sku, callback_data: callbackData({ kind: "pick", value: product.sku, page: 0 }, context.chatId, context.secret) }]);
  }
  lines.push("", "Pilih tombol SKU untuk melihat detail terbaru.");
  const navigation: InlineButton[] = [];
  for (const [label, target] of [["‹ Sebelumnya", page - 1], ["Berikutnya ›", page + 1]] as const) {
    if (target >= 0 && target < pageCount) {
      navigation.push({ text: label, callback_data: callbackData({ kind: low ? "low" : "search", value: low ? "" : context.query, page: target }, context.chatId, context.secret) });
    }
  }
  if (navigation.length) keyboard.push(navigation);
  return { text: lines.join("\n"), reply_markup: { inline_keyboard: keyboard } };
}
