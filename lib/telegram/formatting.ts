// Telegram presentation layer: every user-facing text and button is built here.
// Business modules return data; this module turns it into plain-text messages. The
// transport escapes every message and adds the shared footer (see footer.ts).
import { getAppConfig } from "../config/app";
import { stockLevel, type InventoryProduct, type InventoryResult, type StockLevel } from "../inventory/inventory-engine";
import { supplierKey, type Supplier } from "../supplier/supplier-service";
import { whatsappLink } from "../supplier/whatsapp";
import type { RestockRecommendation } from "../restock/restock-service";
import {
  MAX_STOCK_QUANTITY, MAX_TRANSACTION_ITEMS,
  type AppliedChange, type ApplyResult, type ConfirmedChange, type PlanLine, type PlannedChange, type QuantityProblem, type StockPlan,
} from "../inventory/stock-update";
import type { HelpTopic, StockChangeIntent, StockFilter, StockItemRequest } from "../parser/intents";
import type { AnalysisResult, HistoryResult } from "../inventory/insights";
import type { TransactionEntry } from "../inventory/transaction-service";
import { STOCK_COMMAND_WORDS } from "../parser/rule-parser";
import {
  callbackData, clarifyButton, menuButton, opnameCountButton, type MenuAction, opnameDetailButton, opnamePickButton, opnameResultsButton,
  productButton, resolveButton, sealMessage, searchHeader, STOCK_REQUEST_LABEL, supplierButton,
  updateActionButton, updateDetailButton, updatePickButton, updateResultsButton, type UpdateScope,
} from "./callbacks";
import type { InlineButton, ReplyKeyboard, TelegramReply, UrlButton } from "./types";

// Separates a product name from its SKU in a stock summary line.
const SKU_SEPARATOR = " · ";

export const MENU_LABELS = {
  check: "🔍 Cek Stok",
  update: "📝 Update Stok",
  low: "⚠️ Stok Menipis",
  opname: "🔄 Stock Opname",
  restock: "🛒 Rekomendasi Restock",
  search: "📋 Cari Barang",
  supplier: "📞 Hubungi Supplier",
  report: "📊 Laporan",
  help: "❓ Bantuan",
  interest: "💡 Berminat?",
} as const;

export const MAIN_MENU: ReplyKeyboard = {
  keyboard: [
    [{ text: MENU_LABELS.check }, { text: MENU_LABELS.update }],
    [{ text: MENU_LABELS.low }, { text: MENU_LABELS.opname }],
    [{ text: MENU_LABELS.restock }],
    [{ text: MENU_LABELS.search }, { text: MENU_LABELS.supplier }],
    // Three short labels fit one row on a phone; five rows keep the keyboard low.
    [{ text: MENU_LABELS.report }, { text: MENU_LABELS.help }, { text: MENU_LABELS.interest }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const PAGE_SIZE = 8;

/** `userId` enables the per-user action buttons (Barang Masuk/Keluar/Koreksi) on product details. */
export interface FormatContext { chatId: number; secret: string; userId?: number; query?: string; page?: number; now?: number; notificationsEnabled?: boolean | null }

function scopeOf(context: FormatContext): UpdateScope | null {
  return context.userId === undefined ? null : { chatId: context.chatId, userId: context.userId, secret: context.secret };
}

// ---------------------------------------------------------------- helpers

function text(...lines: (string | false | null | undefined)[]): string {
  return lines.filter((line): line is string => typeof line === "string").join("\n");
}

function menuReply(body: string): TelegramReply {
  return { text: body, reply_markup: MAIN_MENU };
}

function inlineReply(body: string, rows: (InlineButton | UrlButton)[][]): TelegramReply {
  return { text: body, reply_markup: { inline_keyboard: rows } };
}

function compact(value: string, limit = 160): string {
  const clean = value.replace(/\s+/g, " ").trim() || "—";
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

function number(value: number): string {
  return value.toLocaleString("id-ID", { maximumFractionDigits: 6 });
}

function amount(value: number, unit: string): string {
  return `${number(value)} ${compact(unit, 20)}`.replace(/ —$/, "");
}

function rackValue(rack: string): string {
  return compact(rack, 60).replace(/^rak\s+/i, "");
}

const STATUS_LABELS: Record<StockLevel, string> = {
  OUT_OF_STOCK: "🔴 Habis",
  LOW: "🟡 Menipis",
  SAFE: "🟢 Aman",
  NO_MINIMUM: "⚪ Stok minimum belum ditentukan",
};

function minimumText(product: InventoryProduct): string {
  return product.minimumStock === null ? "Belum ditentukan" : amount(product.minimumStock, product.unit);
}

// ---------------------------------------------------------------- menus and prompts

export function startReply(): TelegramReply {
  const { assistantName, companyName } = getAppConfig();
  return menuReply(text(
    `👋 Halo! Saya ${assistantName} ${companyName}.`,
    "",
    "Saya bisa membantu Anda mengecek stok, mencatat barang masuk dan keluar, melihat laporan, hingga menghubungi supplier.",
    "",
    "Ada yang ingin Anda lakukan?",
  ));
}

export function mainMenuReply(): TelegramReply {
  return menuReply(text("📦 Menu Utama", "", "Pilih kebutuhanmu dari menu di bawah, atau langsung ketik nama barang."));
}

export const HELP_EXAMPLES = [
  ["🔍", "stok minyak goreng"],
  ["🔍", "beras tinggal berapa?"],
  ["⚠️", "barang apa yang hampir habis?"],
  ["📋", "cari BRG0006"],
  ["📝", "tambah stok minyak 20, gula 30"],
  ["📞", "hubungi supplier"],
] as const;

const HELP_TOPIC_BUTTONS: [string, MenuAction][] = [
  ["🔍 Cek & Cari", "help_stock"], ["📝 Update Stok", "help_update"],
  ["🔄 Stock Opname", "help_opname"], ["📊 Laporan & Riwayat", "help_report"],
];

function helpKeyboard(): InlineButton[][] {
  const buttons = HELP_TOPIC_BUTTONS.map(([label, action]) => menuButton(label, action));
  return [[buttons[0], buttons[1]], [buttons[2], buttons[3]], [menuButton("⬅️ Menu Utama", "menu")]];
}

export function helpReply(): TelegramReply {
  return inlineReply(text(
    "❓ Bantuan",
    "",
    "Kamu bisa langsung bertanya seperti:",
    "",
    ...HELP_EXAMPLES.map(([icon, example]) => `${icon} "${example}"`),
    "",
    "Pilih topik di bawah untuk contoh lainnya, atau gunakan tombol menu.",
  ), helpKeyboard());
}

/** Every example here is parsed as described; tests keep it that way. */
export const HELP_TOPICS: Record<HelpTopic, { title: string; intro: string; examples: string[]; tip: string }> = {
  stock: {
    title: "🔍 Bantuan Cek & Cari Barang",
    intro: "Ketik nama barang atau SKU. Susunan kata bebas.",
    examples: ["stok minyak", "berapa sisa beras?", "gula tinggal berapa?", "cari minyak goreng", "barang di bawah 10", "stok antara 10 sampai 20"],
    tip: "Salah ketik sedikit tidak apa-apa, saya akan memberi saran nama barang.",
  },
  update: {
    title: "📝 Bantuan Update Stok",
    intro: "Tekan 📝 Update Stok, atau ketik langsung:",
    examples: ["minyak masuk 20", "tambah beras 5 kg", "beras terjual 10", "kurangi gula 2", "stok minyak sekarang 25", "tambah minyak 20, gula 30"],
    tip: "Setiap perubahan ditampilkan dulu. Stok baru disimpan setelah Anda menekan ✅ Konfirmasi.",
  },
  opname: {
    title: "🔄 Bantuan Stock Opname",
    intro: "Untuk mencocokkan stok di sistem dengan hasil hitung fisik:",
    examples: ["Tekan 🔄 Stock Opname", "Ketik nama barang", "Masukkan jumlah hasil hitung"],
    tip: "Saya hitung selisihnya dan menunggu konfirmasi sebelum menyimpan.",
  },
  report: {
    title: "📊 Bantuan Laporan & Riwayat",
    intro: "Laporan PDF bulan ini ada di tombol 📊 Laporan. Untuk riwayat, ketik:",
    examples: ["riwayat minyak", "transaksi hari ini", "barang masuk kemarin", "barang paling banyak keluar minggu ini", "produk terlaris bulan ini"],
    tip: "Periode yang dikenali: hari ini, kemarin, minggu ini, minggu lalu, bulan ini, bulan lalu, 7 hari terakhir, atau tanggal 1 sampai 15.",
  },
};

export function helpTopicReply(topic: HelpTopic): TelegramReply {
  const help = HELP_TOPICS[topic];
  const typed = topic !== "opname";
  return inlineReply(text(
    help.title,
    "",
    help.intro,
    "",
    ...help.examples.map((example, index) => typed ? `• "${example}"` : `${index + 1}. ${example}`),
    "",
    `💡 ${help.tip}`,
  ), [[menuButton("⬅️ Bantuan", "help"), menuButton("🏠 Menu Utama", "menu")]]);
}

export function interestReply(): TelegramReply {
  return menuReply(text(
    "💡 Berminat dengan FASTSTOCK?",
    "",
    "Silakan hubungi admin yang membagikan bot ini untuk informasi penerapan FASTSTOCK pada bisnis Anda.",
  ));
}

export function checkStockPromptReply(): TelegramReply {
  return menuReply(text(
    "🔍 Cek Stok",
    "",
    "Ketik nama barang atau SKU yang ingin dicek.",
    "",
    "Contoh:",
    "• minyak goreng",
    "• beras premium",
    "• BRG0001",
  ));
}

export function searchPromptReply(): TelegramReply {
  return menuReply(text(
    "📋 Cari Barang",
    "",
    "Ketik nama barang atau SKU yang ingin dicari.",
    "",
    "Contoh:",
    "• minyak",
    "• gula",
    "• BRG0006",
  ));
}

// ---------------------------------------------------------------- report

export function reportProgressReply(): TelegramReply {
  return { text: "📊 Sedang menyiapkan laporan bulan ini..." };
}

export function reportReadyReply(hasTransactions: boolean): TelegramReply {
  return menuReply(text(
    "✅ Laporan bulan ini sudah selesai.",
    !hasTransactions && "",
    !hasTransactions && "ℹ️ Belum ada transaksi yang tercatat bulan ini.",
    !hasTransactions && "Laporan tetap dibuat berdasarkan kondisi stok yang tersedia.",
  ));
}

export function reportErrorReply(): TelegramReply {
  return menuReply("Maaf, laporan belum dapat dibuat saat ini.\nSilakan coba beberapa saat lagi.");
}

// ---------------------------------------------------------------- supplier directory

/** The supplier list; each supplier opens its own detail. Read-only. */
export function supplierListReply(suppliers: readonly Supplier[]): TelegramReply {
  if (!suppliers.length) return menuReply(text("📞 Hubungi Supplier", "", "Belum ada data supplier."));
  const shown = suppliers.slice(0, 40);
  const rows: InlineButton[][] = shown.map((supplier, index) => [supplierButton(`🏢 ${compact(supplier.name, 50)}`, supplierKey(supplier, index))]);
  rows.push([menuButton("⬅️ Kembali", "menu")]);
  return inlineReply(text(
    "📞 Hubungi Supplier",
    "",
    "Pilih supplier:",
    suppliers.length > shown.length && `Menampilkan ${shown.length} dari ${suppliers.length} supplier.`,
  ), rows);
}

export function supplierDetailReply(supplier: Supplier): TelegramReply {
  const rows: (InlineButton | UrlButton)[][] = [];
  if (supplier.whatsapp) rows.push([{ text: "💬 Hubungi via WhatsApp", url: whatsappLink(supplier.whatsapp) }]);
  rows.push([menuButton("⬅️ Kembali", "supplier")]);
  return inlineReply(text(
    `🏢 ${compact(supplier.name, 100)}`,
    "",
    `Kota: ${supplier.city ? compact(supplier.city, 60) : "-"}`,
    `Kontak: ${supplier.contact ? compact(supplier.contact, 40) : "-"}`,
    `Keterangan: ${supplier.note ? compact(supplier.note, 160) : "-"}`,
    !supplier.whatsapp && "",
    !supplier.whatsapp && "Kontak WhatsApp belum tersedia.",
  ), rows);
}

export function supplierNotFoundReply(): TelegramReply {
  return inlineReply(text("Supplier tidak ditemukan.", "", "Silakan pilih dari daftar supplier."), [[menuButton("📞 Hubungi Supplier", "supplier")]]);
}

// ---------------------------------------------------------------- conversation and errors

export function unknownReply(): TelegramReply {
  return menuReply(text(
    "🤔 Maaf, saya belum paham maksudnya.",
    "",
    "Coba ketik seperti ini:",
    "• stok minyak goreng",
    "• cari beras",
    "• barang apa yang hampir habis?",
    "",
    "Atau pilih menu di bawah.",
  ));
}

export function cancelReply(): TelegramReply {
  return menuReply(text("👌 Oke, dibatalkan.", "", "Silakan pilih menu atau ketik nama barang."));
}

export function nothingToConfirmReply(): TelegramReply {
  return menuReply(text(
    "Tidak ada yang perlu dikonfirmasi dari pesan ini.",
    "",
    "Tekan tombol ✅ Konfirmasi di bawah ringkasan, atau balas (reply) ringkasan itu dengan \"ya\".",
  ));
}

export function textOnlyReply(): TelegramReply {
  return menuReply(text("Saya hanya bisa membaca pesan teks.", "", "Ketik nama barang, misalnya: stok minyak goreng"));
}

export function expiredChoiceReply(): TelegramReply {
  return menuReply(text("Pilihan ini sudah tidak berlaku.", "", "Silakan cari barangnya lagi."));
}

export function errorReply(): TelegramReply {
  return menuReply("😔 Maaf, saya sedang mengalami kendala saat mengambil data stok. Silakan coba lagi.");
}

// ---------------------------------------------------------------- products

/**
 * Stock actions for a product the user is looking at, so a change never needs a
 * second search. Rows: [Masuk, Keluar], [Koreksi], then navigation.
 */
function productActionRows(sku: string, scope: UpdateScope, back: InlineButton): InlineButton[][] {
  const [add, reduce, set] = STOCK_INTENTS.map((intent) => updateActionButton(STOCK_TITLES[intent], intent, sku, scope));
  const rows: InlineButton[][] = [];
  const pair = [add, reduce].filter((button): button is InlineButton => button !== null);
  if (pair.length) rows.push(pair);
  if (set) rows.push([set]);
  rows.push([back]);
  return rows;
}

/** Full detail after the user picks a product: the stock amount leads. */
export function productDetailReply(product: InventoryProduct, scope?: UpdateScope | null): TelegramReply {
  if (!scope) return menuReply(text(...productDetailLines(product)));
  return inlineReply(text(...productDetailLines(product)), productActionRows(product.sku, scope, menuButton("⬅️ Menu Utama", "menu")));
}

function productDetailLines(product: InventoryProduct): string[] {
  return [
    `📦 ${compact(product.name, 240)}`,
    "",
    "Stok saat ini",
    amount(product.currentStock, product.unit),
    "",
    STATUS_LABELS[stockLevel(product)],
    "",
    "Stok minimum",
    minimumText(product),
    ...(product.rack.trim() ? ["", "Lokasi", `Rak ${rackValue(product.rack)}`] : []),
    "",
    "SKU",
    compact(product.sku, 240),
    ...(product.supplier.trim() ? ["", "Supplier", compact(product.supplier)] : []),
  ];
}

/** A search with exactly one match skips the choice step. */
export function productFoundReply(product: InventoryProduct, scope?: UpdateScope | null): TelegramReply {
  const body = text(
    "🔎 Ditemukan",
    "",
    `📦 ${compact(product.name, 240)}`,
    "",
    `Stok: ${amount(product.currentStock, product.unit)}`,
    `Status: ${STATUS_LABELS[stockLevel(product)]}`,
    `Minimum: ${minimumText(product)}`,
    product.rack.trim() && `Rak: ${rackValue(product.rack)}`,
    `SKU: ${compact(product.sku, 240)}`,
    product.supplier.trim() && `Supplier: ${compact(product.supplier)}`,
  );
  return scope ? inlineReply(body, productActionRows(product.sku, scope, menuButton("⬅️ Menu Utama", "menu"))) : menuReply(body);
}

/** Nothing matched. Close spellings are offered as buttons; nothing is picked automatically. */
export function notFoundReply(query: string, suggestions: readonly InventoryProduct[] = [], context?: FormatContext): TelegramReply {
  const shown = context ? suggestions.slice(0, 5) : [];
  const rows: InlineButton[][] = shown.map((product) => [productButton(`📦 ${compact(product.name, 60)}`, product.sku, context!.chatId, context!.secret)]);
  rows.push([menuButton(MENU_LABELS.search, "search"), menuButton("⬅️ Menu", "menu")]);
  return inlineReply(text(
    "🔎 Barang tidak ditemukan",
    "",
    "Saya belum menemukan barang dengan nama:",
    `"${compact(query, 200)}"`,
    "",
    shown.length ? "Mungkin maksud Anda:" : "Coba gunakan nama barang atau SKU yang lebih spesifik.",
    ...shown.map((product) => `• ${compact(product.name, 80)} (${compact(product.sku, 40)})`),
  ), rows);
}

/** One compact line pair per product: name, then SKU, stock, and a status dot. */
function productListLines(products: readonly InventoryProduct[], start: number): string[] {
  return products.flatMap((product, index) => [
    `${start + index + 1}. ${compact(product.name, 80)}`,
    `   ${compact(product.sku, 40)} · ${amount(product.currentStock, product.unit)} ${STATUS_LABELS[stockLevel(product)].split(" ")[0]}`,
  ]);
}

function pageOf(total: number, requested = 0) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.max(0, Math.min(Math.floor(requested), pageCount - 1));
  return { page, pageCount, start: page * PAGE_SIZE, end: (page + 1) * PAGE_SIZE };
}

function navigation(kind: "search" | "low" | "restock", value: string, page: number, pageCount: number, context: FormatContext): InlineButton[] {
  const buttons: InlineButton[] = [];
  if (page > 0) buttons.push({ text: "◀️ Sebelumnya", callback_data: callbackData({ kind, value, page: page - 1 }, context.chatId, context.secret) });
  if (page < pageCount - 1) buttons.push({ text: "Berikutnya ▶️", callback_data: callbackData({ kind, value, page: page + 1 }, context.chatId, context.secret) });
  return buttons;
}

export function productChoiceReply(products: InventoryProduct[], context: FormatContext): TelegramReply {
  const query = context.query ?? "";
  const { page, pageCount, start, end } = pageOf(products.length, context.page);
  const shown = products.slice(start, end);
  const rows: InlineButton[][] = shown
    .map((product, index) => [productButton(`${start + index + 1}. ${compact(product.name, 60)}`, product.sku, context.chatId, context.secret)]);
  const nav = navigation("search", query, page, pageCount, context);
  if (nav.length) rows.push(nav);
  // The first line must stay searchHeader(): pagination reads the query back from it.
  return inlineReply(text(
    searchHeader(products.length, query),
    "",
    ...productListLines(shown, start),
    "",
    pageCount > 1 ? `Pilih barang (halaman ${page + 1} dari ${pageCount}):` : "Pilih barang:",
  ), rows);
}

export function lowStockReply(products: InventoryProduct[], context: FormatContext): TelegramReply {
  const preferenceRows = context.notificationsEnabled === undefined ? [] : [
    [menuButton(context.notificationsEnabled ? "🔕 Nonaktifkan Notifikasi" : "🔔 Aktifkan Notifikasi", context.notificationsEnabled ? "notif_off" : "notif_on")],
    [menuButton("🛒 Rekomendasi Restock", "restock")],
  ];
  if (products.length === 0) {
    const body = text("✅ Semua stok aman", "", "Tidak ada barang yang berada di bawah stok minimum.");
    return preferenceRows.length ? inlineReply(body, preferenceRows) : menuReply(body);
  }
  const { page, pageCount, start, end } = pageOf(products.length, context.page);
  const items = products.slice(start, end).flatMap((product) => {
    const [icon, label] = STATUS_LABELS[stockLevel(product)].split(" ");
    return [
      `${icon} ${compact(product.name, 100)}`,
      `${label} — ${amount(product.currentStock, product.unit)} / minimum ${minimumText(product)}`,
      "",
    ];
  });
  const body = text(
    "⚠️ Stok Menipis",
    "",
    `Ada ${products.length} barang yang perlu diperhatikan:`,
    "",
    ...items,
    pageCount > 1 ? `Halaman ${page + 1} dari ${pageCount}` : null,
  ).trim();
  const nav = navigation("low", "", page, pageCount, context);
  const rows = [...(nav.length ? [nav] : []), ...preferenceRows];
  return rows.length ? inlineReply(body, rows) : menuReply(body);
}

/** One combined scheduled message; items here are newly low since the last successful run. */
export function lowStockNotificationReply(products: readonly InventoryProduct[]): TelegramReply {
  const shown = products.slice(0, 30);
  return inlineReply(text(
    "🔔 Notifikasi Stok Menipis",
    "",
    `${products.length} barang baru mencapai atau melewati batas minimum:`,
    "",
    ...shown.flatMap((product) => [
      `• ${compact(product.name, 100)}`,
      `  ${amount(product.currentStock, product.unit)} / minimum ${minimumText(product)}`,
    ]),
    products.length > shown.length ? `\nDan ${products.length - shown.length} barang lainnya.` : null,
  ), [
    [menuButton("⚠️ Lihat Stok Menipis", "low")],
    [menuButton("🛒 Rekomendasi Restock", "restock")],
  ]);
}

export function notificationPreferenceReply(enabled: boolean): TelegramReply {
  return inlineReply(text(
    enabled ? "🔔 Notifikasi stok menipis aktif" : "🔕 Notifikasi stok menipis nonaktif",
    "",
    enabled
      ? "Anda akan menerima pemberitahuan saat barang baru mencapai atau melewati stok minimum."
      : "Anda tidak akan menerima pemberitahuan stok menipis otomatis.",
  ), [[menuButton("⚠️ Lihat Stok Menipis", "low")]]);
}

export function notificationPreferenceErrorReply(): TelegramReply {
  return menuReply(text("⚠️ Preferensi belum dapat disimpan", "", "Silakan coba lagi beberapa saat lagi."));
}

export function restockReply(recommendations: readonly RestockRecommendation[], context: FormatContext): TelegramReply {
  if (!recommendations.length) {
    return inlineReply(text("✅ Belum perlu restock", "", "Tidak ada barang yang berada pada atau di bawah stok minimum."), [
      [menuButton("⚠️ Lihat Stok Menipis", "low")],
    ]);
  }
  const { page, pageCount, start, end } = pageOf(recommendations.length, context.page);
  const shown = recommendations.slice(start, end);
  const body = text(
    "🛒 Rekomendasi Restock",
    "",
    `${recommendations.length} barang perlu diperhatikan:`,
    "",
    ...shown.flatMap((item) => [
      `📦 ${compact(item.name, 100)}`,
      `Stok saat ini: ${amount(item.currentStock, item.unit)}`,
      `Stok minimum: ${amount(item.minimumStock, item.unit)}`,
      item.recommendedQuantity > 0
        ? `Rekomendasi: ${amount(item.recommendedQuantity, item.unit)}`
        : "Rekomendasi: 0 (sudah tepat di batas minimum)",
      `Supplier: ${item.supplierName ? compact(item.supplierName, 100) : "Belum tersedia"}`,
      item.supplierName && !item.supplierWhatsapp ? "Kontak WhatsApp belum tersedia." : null,
      "",
    ]),
    pageCount > 1 ? `Halaman ${page + 1} dari ${pageCount}` : null,
  ).trim();
  const rows: (InlineButton | UrlButton)[][] = shown
    .filter((item) => item.supplierWhatsapp)
    .map((item) => [{ text: `💬 Hubungi ${compact(item.supplierName, 35)}`, url: whatsappLink(item.supplierWhatsapp!) }]);
  const nav = navigation("restock", "", page, pageCount, context);
  if (nav.length) rows.push(nav);
  rows.push([menuButton("⚠️ Lihat Stok Menipis", "low")]);
  return inlineReply(body, rows);
}

const FILTER_LABELS: Record<Exclude<StockFilter["op"], "between">, string> = {
  lt: "di bawah", lte: "paling banyak", gt: "di atas", gte: "paling sedikit", eq: "sama dengan",
};

export function filterLabel(filter: StockFilter): string {
  const unit = filter.unit ? ` ${filter.unit}` : "";
  if (filter.op === "between") return `antara ${number(filter.min)} dan ${number(filter.max)}${unit}`;
  if (filter.op === "lte" && filter.value === 0) return "kosong (0)";
  return `${FILTER_LABELS[filter.op]} ${number(filter.value)}${unit}`;
}

export const FILTER_LIMIT = 30;

export function stockFilterReply(products: readonly InventoryProduct[], filter: StockFilter, context: FormatContext): TelegramReply {
  const label = filterLabel(filter);
  if (!products.length) {
    return inlineReply(text("🔎 Filter Stok", "", `Tidak ada barang dengan stok ${label}.`), [[menuButton("⚠️ Stok Menipis", "low"), menuButton("⬅️ Menu", "menu")]]);
  }
  const shown = products.slice(0, FILTER_LIMIT);
  const rows: InlineButton[][] = shown.slice(0, PAGE_SIZE)
    .map((product, index) => [productButton(`${index + 1}. ${compact(product.name, 60)}`, product.sku, context.chatId, context.secret)]);
  rows.push([menuButton("⬅️ Menu", "menu")]);
  return inlineReply(text(
    "🔎 Filter Stok",
    "",
    `${products.length} barang dengan stok ${label}:`,
    "",
    ...productListLines(shown, 0),
    products.length > shown.length && `\nDan ${products.length - shown.length} barang lainnya. Persempit filternya agar lebih mudah dibaca.`,
    "",
    shown.length > PAGE_SIZE ? `Tombol di bawah untuk ${PAGE_SIZE} barang pertama.` : "Tekan nama barang untuk melihat detail.",
  ), rows);
}

export function formatInventoryResult(result: InventoryResult, context: FormatContext): TelegramReply {
  const query = context.query ?? "";
  switch (result.status) {
    case "NOT_FOUND":
      return notFoundReply(query, result.suggestions, context);
    case "INVALID_QUERY":
      return result.intent === "CHECK_STOCK" ? checkStockPromptReply() : searchPromptReply();
    case "UNSUPPORTED_INTENT":
      return updateSearchPromptReply();
    case "MULTIPLE_MATCHES":
      return productChoiceReply(result.products, context);
  }
  if ("product" in result) return productDetailReply(result.product, scopeOf(context));
  if (result.intent === "LOW_STOCK") return lowStockReply(result.products, context);
  if (result.intent === "STOCK_FILTER") return stockFilterReply(result.products, result.filter, context);
  if (result.products.length === 0) return notFoundReply(query, [], context);
  if (result.products.length === 1) return productFoundReply(result.products[0], scopeOf(context));
  return productChoiceReply(result.products, context);
}

// ---------------------------------------------------------------- stock opname

const OPNAME_SEARCH = { title: "🔄 Stock Opname", ask: "🔎 Cari barang yang akan dihitung." };

export function opnameSearchPromptReply(): TelegramReply {
  return {
    text: text(OPNAME_SEARCH.title, "", OPNAME_SEARCH.ask, "", "Ketik nama barang atau SKU.", "", "Contoh:", "beras"),
    reply_markup: { force_reply: true, input_field_placeholder: "Nama barang atau SKU" },
  };
}

export function isOpnameSearchPrompt(message: string | undefined): boolean {
  const lines = message?.split("\n").map((line) => line.trim()) ?? [];
  return lines[0] === OPNAME_SEARCH.title && lines[2] === OPNAME_SEARCH.ask;
}

export function opnameResultsReply(products: readonly InventoryProduct[], query: string, scope: UpdateScope): TelegramReply {
  const shown = products.slice(0, PAGE_SIZE);
  const rows = shown
    .map((product) => opnamePickButton(`📦 ${compact(product.name, 60)}`, product.sku, scope))
    .filter((button): button is InlineButton => button !== null)
    .map((button) => [button]);
  rows.push([menuButton("🔎 Cari Lagi", "opn_search")]);
  return inlineReply(text(
    searchHeader(products.length, query),
    "",
    "Pilih barang untuk stock opname:",
    products.length > shown.length ? `Menampilkan ${shown.length} dari ${products.length} barang. Ketik kata kunci yang lebih spesifik.` : null,
  ), rows);
}

export function opnameNotFoundReply(query: string): TelegramReply {
  return inlineReply(text(
    "⚠️ Barang tidak ditemukan",
    "",
    `Saya belum menemukan barang dengan nama "${compact(query, 200)}".`,
    "Silakan coba kata kunci lain.",
  ), [[menuButton("🔎 Cari Lagi", "opn_search")], [menuButton("⬅️ Kembali", "menu")]]);
}

export function opnameProductReply(product: InventoryProduct, query: string | null, scope: UpdateScope): TelegramReply {
  const count = opnameCountButton("🧮 Masukkan Stok Fisik", product.sku, scope);
  const rows: InlineButton[][] = [];
  if (count) rows.push([count]);
  rows.push([query ? opnameResultsButton("⬅️ Kembali", query, scope) : menuButton("🔎 Cari Lagi", "opn_search")]);
  return inlineReply(text(...productDetailLines(product), "", "Lanjutkan untuk memasukkan hasil hitung fisik."), rows);
}

export function opnameWaitingKeyboard(sku: string, scope: UpdateScope): InlineButton[][] {
  const cancel = opnameDetailButton("❌ Batal", sku, scope);
  return cancel ? [[cancel]] : [];
}

export function opnameQuantityPromptReply(product: InventoryProduct, scope: UpdateScope, now: number, warning: string[] = []): TelegramReply {
  const body = text(
    ...(warning.length ? [...warning, ""] : []),
    "🔄 Stock Opname",
    "",
    `📦 ${compact(product.name, 100)}`,
    `SKU: ${product.sku}`,
    `Stok sistem: ${amount(product.currentStock, product.unit)}`,
    "",
    "Masukkan stok fisik hasil penghitungan.",
    "Nilai tidak boleh negatif.",
    "",
    "Ketik \"batal\" untuk kembali.",
  );
  return { text: sealMessage("OPQ", body, scope, now), reply_markup: { force_reply: true, input_field_placeholder: "Stok fisik" } };
}

export function parseOpnameQuantityPrompt(body: string): { sku: string } | null {
  const sku = body.split("\n").map((line) => line.trim()).find((line) => line.startsWith("SKU: "))?.slice(5);
  return sku ? { sku } : null;
}

export const OPNAME_WARNINGS = {
  invalid: ["⚠️ Stok fisik tidak valid", "", "Masukkan stok fisik dalam angka."],
  negative: ["⚠️ Stok fisik tidak valid", "", "Stok fisik tidak boleh negatif."],
  wholeNumber: (unit: string) => ["⚠️ Stok fisik tidak valid", "", `Satuan ${compact(unit, 20)} harus berupa bilangan bulat.`],
  tooLarge: ["⚠️ Stok fisik tidak valid", "", `Jumlah maksimal ${number(MAX_STOCK_QUANTITY)}.`],
  unit: (product: InventoryProduct, given: string) => [
    "⚠️ Satuan tidak sesuai", "", `Barang ini dihitung dalam ${compact(product.unit, 20) || "satuan lain"}, bukan ${compact(given, 20)}.`,
  ],
};

function opnamePreviewBody(product: InventoryProduct, physicalStock: number): string {
  return text(
    "🔄 Pratinjau Stock Opname",
    "",
    `📦 ${compact(product.name, 100)}`,
    `SKU: ${product.sku}`,
    "",
    `Stok sistem: ${amount(product.currentStock, product.unit)}`,
    `Stok fisik: ${amount(physicalStock, product.unit)}`,
    `Selisih: ${delta(physicalStock - product.currentStock, product.unit)}`,
    "",
    "Simpan hasil stock opname?",
  );
}

export function opnamePreviewReply(product: InventoryProduct, physicalStock: number, scope: UpdateScope, now: number): TelegramReply {
  const cancel = opnameDetailButton("❌ Batal", product.sku, scope);
  return inlineReply(sealMessage("OPN", opnamePreviewBody(product, physicalStock), scope, now), [
    [menuButton("✅ Konfirmasi", "opn_confirm")],
    [cancel ?? menuButton("❌ Batal", "opn_cancel")],
  ]);
}

export function parseOpnameSummary(body: string): ConfirmedChange | null {
  const lines = body.split("\n").map((line) => line.trim());
  if (lines[0] !== "🔄 Pratinjau Stock Opname") return null;
  const sku = lines.find((line) => line.startsWith("SKU: "))?.slice(5) ?? "";
  const read = (prefix: string) => {
    const line = lines.find((entry) => entry.startsWith(prefix));
    return line ? parseNumber(line.slice(prefix.length).trim().split(" ")[0]) : Number.NaN;
  };
  const before = read("Stok sistem:");
  const after = read("Stok fisik:");
  return sku && Number.isFinite(before) && Number.isFinite(after) ? { sku, before, after } : null;
}

export function opnameStockMatchesReply(product: InventoryProduct): TelegramReply {
  return menuReply(text(
    "✅ Stok sesuai",
    "",
    `📦 ${compact(product.name, 100)}`,
    `Stok sistem dan stok fisik sama: ${amount(product.currentStock, product.unit)}.`,
    "",
    "Tidak ada koreksi yang dibuat.",
  ));
}

export function opnameCancelledReply(): TelegramReply {
  return menuReply(text("❌ Stock opname dibatalkan.", "", "Tidak ada data yang diubah."));
}

export function opnameApplyReply(result: ApplyResult): TelegramReply {
  switch (result.status) {
    case "SAVED": {
      const change = result.changes[0];
      return menuReply(text(
        "✅ Stock opname berhasil disimpan",
        "",
        `📦 ${compact(change.name, 100)}`,
        `Stok sistem: ${amount(change.before, change.unit)}`,
        `Stok fisik: ${amount(change.after, change.unit)}`,
        `Selisih: ${delta(change.after - change.before, change.unit)}`,
        "",
        `ID transaksi: ${result.transactionId}`,
      ));
    }
    case "ALREADY_APPLIED":
      return menuReply(text("✅ Stock opname ini sudah tersimpan sebelumnya.", "", "Tidak ada koreksi tambahan yang dibuat."));
    case "CONFLICT":
      return menuReply(text("⚠️ Stock opname belum disimpan", "", "Stok sistem berubah sejak pratinjau dibuat. Silakan ulangi stock opname."));
    case "UNVERIFIED":
      return menuReply(text("⚠️ Hasil opname sudah dikirim, tetapi perlu diperiksa", "", "Stok Akhir belum sesuai hasil hitung. Mohon periksa sheet Stok."));
    case "INVALID":
      return menuReply(text("Pratinjau stock opname tidak dapat diproses.", "", "Silakan ulangi dari menu Stock Opname."));
    case "WRITE_FAILED":
      return result.outcome === "NOTHING_SAVED"
        ? menuReply("⚠️ Stock opname belum berhasil disimpan. Tidak ada data yang diubah; silakan coba lagi.")
        : menuReply(text("⚠️ Hasil opname belum dapat dipastikan", "", "Periksa stok barang terkait sebelum mencoba lagi."));
  }
}

// ---------------------------------------------------------------- stock updates

const STOCK_TITLES: Record<StockChangeIntent, string> = {
  ADD_STOCK: "📥 Barang Masuk",
  REDUCE_STOCK: "📤 Barang Keluar",
  SET_STOCK: "🔄 Koreksi Stok",
};
const STOCK_INTENTS = Object.keys(STOCK_TITLES) as StockChangeIntent[];
// Examples for free-text commands.
const FREE_TEXT_EXAMPLES: Record<StockChangeIntent, string> = { ADD_STOCK: "minyak 20", REDUCE_STOCK: "minyak 5", SET_STOCK: "minyak jadi 50" };

function signedAmount(intent: StockChangeIntent, change: Pick<PlannedChange, "quantity" | "unit" | "merged">): string {
  const base = intent === "SET_STOCK" ? `jadi ${amount(change.quantity, change.unit)}`
    : `${intent === "ADD_STOCK" ? "+" : "-"}${amount(change.quantity, change.unit)}`;
  return change.merged.length ? `${base} (${change.merged.map(number).join(" + ")})` : base;
}

function delta(value: number, unit: string): string {
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${amount(Math.abs(value), unit)}`;
}

// ---- product-first flow (📝 Update Stok): search → product → action → number → preview

const UPDATE_SEARCH = { title: "📝 Update Stok", ask: "🔎 Cari barang yang ingin diperbarui." };

/** Asks only for a search term; the reply box opens on this message. */
export function updateSearchPromptReply(): TelegramReply {
  return {
    text: text(UPDATE_SEARCH.title, "", UPDATE_SEARCH.ask, "", "Ketik nama barang atau SKU.", "", "Contoh:", "beras"),
    reply_markup: { force_reply: true, input_field_placeholder: "Nama barang atau SKU" },
  };
}

export function isUpdateSearchPrompt(message: string | undefined): boolean {
  const lines = message?.split("\n").map((line) => line.trim()) ?? [];
  return lines[0] === UPDATE_SEARCH.title && lines[2] === UPDATE_SEARCH.ask;
}

export function updateResultsReply(products: readonly InventoryProduct[], query: string, scope: UpdateScope): TelegramReply {
  const shown = products.slice(0, PAGE_SIZE);
  const rows = shown
    .map((product) => updatePickButton(`📦 ${compact(product.name, 60)}`, product.sku, scope))
    .filter((button): button is InlineButton => button !== null)
    .map((button) => [button]);
  rows.push([menuButton("🔎 Cari Lagi", "upd_search")]);
  return inlineReply(text(
    searchHeader(products.length, query),
    "",
    "Silakan pilih:",
    products.length > shown.length && `Menampilkan ${shown.length} dari ${products.length} barang. Ketik kata kunci yang lebih spesifik untuk mempersempit.`,
  ), rows);
}

export function updateNotFoundReply(query: string): TelegramReply {
  return inlineReply(text(
    "⚠️ Barang tidak ditemukan",
    "",
    "Saya belum menemukan barang dengan nama:",
    `"${compact(query, 200)}"`,
    "",
    "Silakan coba kata kunci lain.",
  ), [[menuButton("🔎 Cari Lagi", "upd_search")], [menuButton("⬅️ Kembali", "menu")]]);
}

/** The selected product with the three change types; the SKU travels in the buttons. */
export function updateProductReply(product: InventoryProduct, query: string | null, scope: UpdateScope): TelegramReply {
  const back = query ? updateResultsButton("⬅️ Kembali", query, scope) : menuButton("⬅️ Kembali", "upd_search");
  return inlineReply(text(...productDetailLines(product), "", "Apa yang ingin dilakukan?"), productActionRows(product.sku, scope, back));
}

/** Replaces the action buttons while the quantity is being typed. */
export function quantityWaitingKeyboard(sku: string, scope: UpdateScope): InlineButton[][] {
  const cancel = updateDetailButton("❌ Batal", sku, scope);
  return cancel ? [[cancel]] : [];
}

const QUANTITY_ASK: Record<StockChangeIntent, { ask: string; example: string }> = {
  ADD_STOCK: { ask: "Masukkan jumlah barang yang masuk.", example: "20" },
  REDUCE_STOCK: { ask: "Masukkan jumlah barang yang keluar.", example: "10" },
  SET_STOCK: { ask: "Masukkan jumlah stok yang benar.", example: "150" },
};

/**
 * Asks for a number only. The prompt is sealed with the action, the SKU, the chat,
 * and the user, so the typed reply is read as a quantity for this product and never
 * as a product name. `warning` lines explain why a previous number was refused.
 */
export function quantityPromptReply(intent: StockChangeIntent, product: InventoryProduct, scope: UpdateScope, now: number, warning: string[] = []): TelegramReply {
  const { ask, example } = QUANTITY_ASK[intent];
  const body = text(
    ...(warning.length ? [...warning, ""] : []),
    STOCK_TITLES[intent],
    "",
    `📦 ${compact(product.name, 100)}`,
    `SKU: ${product.sku}`,
    `Stok saat ini: ${amount(product.currentStock, product.unit)}`,
    "",
    ask,
    "Contoh:",
    example,
    "",
    "Ketik \"batal\" untuk kembali.",
  );
  return { text: sealMessage("QTY", body, scope, now), reply_markup: { force_reply: true, input_field_placeholder: `Contoh: ${example}` } };
}

/** Reads the action and SKU back from a sealed quantity prompt. */
export function parseQuantityPrompt(body: string): { intent: StockChangeIntent; sku: string } | null {
  const lines = body.split("\n").map((line) => line.trim());
  const intent = STOCK_INTENTS.find((candidate) => lines.includes(STOCK_TITLES[candidate]));
  const sku = lines.find((line) => line.startsWith("SKU: "))?.slice(5);
  return intent && sku ? { intent, sku } : null;
}

export const QUANTITY_WARNINGS = {
  invalid: ["⚠️ Jumlah tidak valid", "", "Masukkan jumlah dalam angka."],
  wholeNumber: (unit: string) => ["⚠️ Jumlah tidak valid", "", `Satuan ${compact(unit, 20)} harus berupa bilangan bulat.`],
  positive: ["⚠️ Jumlah tidak valid", "", "Jumlah harus lebih dari 0."],
  tooLarge: ["⚠️ Jumlah tidak valid", "", `Jumlah maksimal ${number(MAX_STOCK_QUANTITY)}.`],
  insufficient: (product: InventoryProduct) => [
    "⚠️ Stok tidak mencukupi", "", "Stok saat ini:", amount(product.currentStock, product.unit), "", "Jumlah barang keluar tidak boleh melebihi stok.",
  ],
  unit: (product: InventoryProduct, given: string) => [
    "⚠️ Satuan tidak sesuai", "", `Barang ini dihitung dalam ${compact(product.unit, 20) || "satuan lain"}, bukan ${compact(given, 20)}.`, "Ketik jumlahnya saja, misalnya: 20",
  ],
  unchanged: (product: InventoryProduct) => ["⚠️ Stok tidak berubah", "", `Stok saat ini sudah ${amount(product.currentStock, product.unit)}. Masukkan jumlah yang berbeda.`],
};

const CONFIRM_TITLES: Record<StockChangeIntent, string> = {
  ADD_STOCK: "📥 Konfirmasi Barang Masuk",
  REDUCE_STOCK: "📤 Konfirmasi Barang Keluar",
  SET_STOCK: "🔄 Konfirmasi Koreksi Stok",
};

function singlePreviewBody(intent: StockChangeIntent, change: PlannedChange): string {
  const moved = change.after - change.before;
  return text(
    CONFIRM_TITLES[intent],
    "",
    `📦 ${compact(change.name, 100)}`,
    `SKU: ${change.sku}`,
    "",
    `Stok saat ini : ${amount(change.before, change.unit)}`,
    ...(intent === "SET_STOCK"
      ? [`Stok baru     : ${amount(change.after, change.unit)}`, `Penyesuaian   : ${delta(moved, change.unit)}`]
      : [`${intent === "ADD_STOCK" ? "Barang masuk" : "Barang keluar"} : ${delta(moved, change.unit)}`, `Stok setelah : ${amount(change.after, change.unit)}`]),
  );
}

/** Sealed preview of one product's change; nothing is written until it is confirmed. */
export function singlePreviewReply(intent: StockChangeIntent, change: PlannedChange, scope: UpdateScope, now: number): TelegramReply {
  const rows: InlineButton[][] = [[menuButton("✅ Konfirmasi", "stock_confirm")]];
  const cancel = updateDetailButton("❌ Batal", change.sku, scope);
  rows.push([cancel ?? menuButton("❌ Batal", "stock_cancel")]);
  return inlineReply(sealMessage("UPD", singlePreviewBody(intent, change), scope, now), rows);
}

// ---- free-text commands ("tambah stok minyak 20, gula 30", "minyak masuk 20")

// The line that marks a multi-item confirmation summary.
const SUMMARY_INTRO = "Berikut perubahan stok:";

const QUANTITY_PROBLEMS: Record<QuantityProblem, string> = {
  MISSING: "jumlah belum ditulis atau bukan angka",
  NOT_POSITIVE: "jumlah harus lebih dari 0",
  NEGATIVE: "jumlah tidak boleh negatif",
  TOO_LARGE: `jumlah terlalu besar (maksimal ${number(MAX_STOCK_QUANTITY)})`,
};

function lineProblem(line: Extract<PlanLine, { ok: false }>): string {
  const unit = line.product?.unit ?? "";
  switch (line.problem) {
    case "NOT_FOUND": return "tidak ditemukan";
    case "AMBIGUOUS": return `cocok dengan ${line.matches} barang, tulis lebih spesifik`;
    case "INSUFFICIENT": return `stok tidak cukup (tersedia ${amount(line.product?.currentStock ?? 0, unit)})`;
    case "NO_CHANGE": return `stok sudah ${amount(line.quantity, unit)}`;
    case "CONFLICTING_DUPLICATE": return "ditulis lebih dari sekali dengan jumlah berbeda";
    case "UNIT_MISMATCH": return `satuan ${compact(line.unit ?? "", 20)} tidak sesuai, barang ini dihitung dalam ${compact(unit, 20) || "satuan lain"}`;
  }
}

/** The request as a command the parser reads back, e.g. "barang masuk: minyak 20, gula 30". */
export function stockRequestText(intent: StockChangeIntent, items: readonly StockItemRequest[]): string {
  const value = (quantity: number) => String(quantity).replace(".", ",");
  // The unit travels too, so picking a product never silently drops "2 dus" to 2.
  return `${STOCK_COMMAND_WORDS[intent]}: ${items.map((item) => `${item.product_query} ${intent === "SET_STOCK" ? "jadi " : ""}${value(item.quantity)}${item.unit ? ` ${item.unit}` : ""}`).join(", ")}`;
}

function stockConfirmBody(intent: StockChangeIntent, changes: readonly PlannedChange[]): string {
  return text(
    STOCK_TITLES[intent],
    "",
    SUMMARY_INTRO,
    ...changes.flatMap((change) => [
      "",
      `• ${compact(change.name, 100)}${SKU_SEPARATOR}${change.sku}`,
      intent === "SET_STOCK" ? null : `  ${signedAmount(intent, change)}`,
      `  ${number(change.before)} → ${number(change.after)}`,
    ]),
    "",
    "Simpan perubahan?",
  );
}

export function stockPlanReply(plan: StockPlan, context: FormatContext & { userId: number }): TelegramReply {
  const scope = { chatId: context.chatId, userId: context.userId, secret: context.secret };
  switch (plan.status) {
    case "EMPTY":
      // A command without items starts the product-first flow instead of asking for a list.
      return updateSearchPromptReply();
    case "TOO_MANY_ITEMS":
      return menuReply(text(
        "⚠️ Terlalu banyak barang",
        "",
        `Maksimal ${MAX_TRANSACTION_ITEMS} barang dalam satu update, sedangkan pesan ini berisi ${plan.count} barang.`,
        "",
        "Silakan bagi menjadi beberapa pesan.",
      ));
    case "INVALID_QUANTITY":
      return menuReply(text(
        "⚠️ Jumlah tidak valid",
        "",
        ...plan.problems.map((problem) => `• "${compact(problem.query, 60)}" — ${QUANTITY_PROBLEMS[problem.problem]}`),
        "",
        "Contoh yang benar:",
        `"${FREE_TEXT_EXAMPLES[plan.intent]}"`,
      ));
    case "BLOCKED": {
      const onlyMissing = plan.lines.every((line) => line.ok || line.problem === "NOT_FOUND");
      return menuReply(text(
        "⚠️ Update belum dilakukan",
        "",
        "Saya menemukan:",
        "",
        ...plan.lines.map((line) => line.ok
          ? `✓ ${compact(line.change.name, 80)} — ${signedAmount(plan.intent, line.change)}`
          : `✕ "${compact(line.query, 60)}" — ${lineProblem(line)}${line.suggestions?.length ? `\n   Mungkin: ${line.suggestions.map((product) => compact(product.name, 40)).join(", ")}` : ""}`),
        "",
        onlyMissing ? "Silakan perbaiki barang yang belum ditemukan." : "Silakan perbaiki barang yang ditandai ✕, lalu kirim ulang.",
      ));
    }
    case "AMBIGUOUS": {
      const request = stockRequestText(plan.intent, plan.items);
      const shown = plan.products.slice(0, PAGE_SIZE);
      const rows: InlineButton[][] = shown.map((product) => [
        resolveButton(`📦 ${compact(product.name, 60)}`, request, plan.index, product.sku, context.chatId, context.secret),
      ]);
      rows.push([menuButton("❌ Batal", "stock_cancel")]);
      // The request line must stay right after STOCK_REQUEST_LABEL: picking reads it back.
      return inlineReply(text(
        `🔎 "${compact(plan.query, 60)}" bisa berarti:`,
        "",
        plan.products.length > shown.length
          ? `Ada ${plan.products.length} barang yang cocok. Pilih di bawah, atau kirim ulang dengan nama yang lebih spesifik.`
          : "Pilih barang yang dimaksud.",
        "",
        STOCK_REQUEST_LABEL,
        request,
      ), rows);
    }
    case "READY":
      return inlineReply(sealMessage("UPD", stockConfirmBody(plan.intent, plan.changes), scope, context.now), [
        [menuButton("✅ Konfirmasi", "stock_confirm")],
        [menuButton("❌ Batal", "stock_cancel")],
      ]);
  }
}

// ---- reading a sealed summary back (single preview or multi-item summary)

function parseNumber(value: string): number {
  const clean = value.replace(/−/g, "-").replace(/\./g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : Number.NaN;
}

type ParsedSummary = { intent: StockChangeIntent; changes: (ConfirmedChange & { name: string })[] };

function parseSinglePreview(lines: string[]): ParsedSummary | null {
  const intent = STOCK_INTENTS.find((candidate) => CONFIRM_TITLES[candidate] === lines[0]);
  if (!intent) return null;
  const value = (label: RegExp) => {
    const line = lines.find((entry) => label.test(entry));
    return line ? parseNumber(line.replace(label, "").trim().split(" ")[0]) : Number.NaN;
  };
  const name = lines.find((line) => line.startsWith("📦 "))?.slice(3) ?? "";
  const sku = lines.find((line) => line.startsWith("SKU: "))?.slice(5) ?? "";
  const before = value(/^Stok saat ini\s*:/);
  const after = value(intent === "SET_STOCK" ? /^Stok baru\s*:/ : /^Stok setelah\s*:/);
  return sku && Number.isFinite(before) && Number.isFinite(after) ? { intent, changes: [{ name, sku, before, after }] } : null;
}

/** Reads a confirmation produced by singlePreviewReply or stockPlanReply back into changes. */
export function parseStockSummary(body: string): ParsedSummary | null {
  const lines = body.split("\n").map((line) => line.trim());
  const single = parseSinglePreview(lines);
  if (single) return single;
  const intent = STOCK_INTENTS.find((candidate) => STOCK_TITLES[candidate] === lines[0]);
  if (!intent || lines[2] !== SUMMARY_INTRO) return null;
  const changes: (ConfirmedChange & { name: string })[] = [];
  let current: { name: string; sku: string } | null = null;
  for (const line of lines.slice(3)) {
    const item = line.match(/^• (.+)$/);
    if (item) {
      const separator = item[1].lastIndexOf(SKU_SEPARATOR);
      if (separator === -1) return null;
      current = { name: item[1].slice(0, separator), sku: item[1].slice(separator + SKU_SEPARATOR.length) };
      continue;
    }
    const arrow = line.match(/^(\S+) → (\S+)(?: .*)?$/);
    if (arrow && current) {
      const before = parseNumber(arrow[1]);
      const after = parseNumber(arrow[2]);
      if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
      changes.push({ ...current, before, after });
      current = null;
    }
  }
  const itemCount = lines.filter((line) => line.startsWith("• ")).length;
  return changes.length && changes.length === itemCount ? { intent, changes } : null;
}

export function stockCancelledReply(): TelegramReply {
  return menuReply(text("❌ Update dibatalkan.", "", "Tidak ada perubahan stok yang dilakukan."));
}

export function stockSummaryExpiredReply(): TelegramReply {
  return menuReply(text(
    "⌛ Ringkasan ini sudah kedaluwarsa",
    "",
    "Konfirmasi berlaku 30 menit. Silakan ulangi update agar stok terbaru dipakai.",
  ));
}

export function stockWriteDisabledReply(): TelegramReply {
  return menuReply(text(
    "🔒 Penyimpanan belum diaktifkan",
    "",
    "Ringkasan sudah diperiksa, tetapi penyimpanan perubahan stok dari Telegram belum diaktifkan.",
    "",
    "Tidak ada perubahan stok yang dilakukan.",
  ));
}

export function opnameWriteDisabledReply(): TelegramReply {
  return menuReply(text(
    "🔒 Penyimpanan belum diaktifkan",
    "",
    "Hasil stock opname sudah diperiksa, tetapi penyimpanan perubahan stok dari Telegram belum diaktifkan.",
    "",
    "Tidak ada data yang diubah.",
  ));
}

function changeLines(changes: readonly AppliedChange[]): string[] {
  return changes.flatMap((change) => ["", `• ${compact(change.name, 100)}`, `  ${number(change.before)} → ${amount(change.after, change.unit)}`]);
}

const MOVE_LABELS: Record<StockChangeIntent, string> = { ADD_STOCK: "Barang masuk", REDUCE_STOCK: "Barang keluar", SET_STOCK: "Penyesuaian" };

export function stockApplyReply(result: ApplyResult, intent?: StockChangeIntent): TelegramReply {
  switch (result.status) {
    case "SAVED": {
      const [only] = result.changes;
      if (intent && result.changes.length === 1) {
        return menuReply(text(
          intent === "SET_STOCK" ? "✅ Stok berhasil dikoreksi" : "✅ Stok berhasil diperbarui",
          "",
          `📦 ${compact(only.name, 100)}`,
          "",
          `${amount(only.before, only.unit)} → ${amount(only.after, only.unit)}`,
          `${MOVE_LABELS[intent]}: ${delta(only.after - only.before, only.unit)}`,
          "",
          `ID transaksi: ${result.transactionId}`,
        ));
      }
      return menuReply(text(
        "✅ Stok berhasil diperbarui",
        "",
        `${result.changes.length} barang telah diperbarui:`,
        ...changeLines(result.changes),
        "",
        "Semua perubahan berhasil disimpan.",
        `ID transaksi: ${result.transactionId}`,
      ));
    }
    case "UNVERIFIED":
      return menuReply(text(
        "⚠️ Perubahan sudah dikirim, tetapi perlu dicek",
        "",
        "Stok Akhir di spreadsheet belum sesuai perkiraan:",
        ...result.changes.filter((change) => change.actual !== change.after).map((change) =>
          `• ${compact(change.name, 80)}: seharusnya ${amount(change.after, change.unit)}, terbaca ${typeof change.actual === "number" ? amount(change.actual, change.unit) : "tidak diketahui"}`),
        "",
        "Mohon periksa sheet Stok sebelum mencoba lagi.",
      ));
    case "ALREADY_APPLIED":
      return menuReply(text("✅ Update ini sudah tersimpan sebelumnya.", "", "Tidak ada perubahan tambahan yang dilakukan."));
    case "CONFLICT":
      return menuReply(text(
        "⚠️ Update belum dilakukan",
        "",
        "Stok berubah sejak ringkasan dibuat:",
        ...result.changes.filter((change) => change.actual !== change.before).map((change) =>
          `• ${compact(change.name, 80)}: sekarang ${typeof change.actual === "number" ? amount(change.actual, change.unit) : "tidak ditemukan"} (di ringkasan ${number(change.before)})`),
        "",
        "Silakan ulangi update agar ringkasan memakai stok terbaru.",
      ));
    case "INVALID":
      return menuReply(text("Ringkasan ini tidak dapat diproses.", "", "Silakan ulangi update."));
    case "WRITE_FAILED":
      return result.outcome === "NOTHING_SAVED"
        ? menuReply("⚠️ Stok belum berhasil diperbarui. Silakan coba lagi.")
        : menuReply(text("⚠️ Update belum dapat dipastikan", "", "Terjadi kendala saat menyimpan. Periksa stok barang terkait sebelum mencoba lagi."));
  }
}

// ---------------------------------------------------------------- free text that needs one more answer

/**
 * "minyak masuk" without a number and several products match: each button carries the
 * product AND the action, so the next step is the quantity question itself.
 */
export function stockActionChoiceReply(intent: StockChangeIntent, products: readonly InventoryProduct[], query: string, scope: UpdateScope): TelegramReply {
  const shown = products.slice(0, PAGE_SIZE);
  const rows = shown
    .map((product, index) => updateActionButton(`${index + 1}. ${compact(product.name, 60)}`, intent, product.sku, scope))
    .filter((button): button is InlineButton => button !== null)
    .map((button) => [button]);
  rows.push([menuButton("❌ Batal", "stock_cancel")]);
  return inlineReply(text(
    `${STOCK_TITLES[intent]}`,
    "",
    `Ada ${products.length} barang untuk "${compact(query, 60)}":`,
    "",
    ...productListLines(shown, 0),
    products.length > shown.length && `\nMenampilkan ${shown.length} dari ${products.length}. Ketik nama yang lebih spesifik untuk mempersempit.`,
    "",
    "Pilih barangnya, lalu saya tanyakan jumlahnya.",
  ), rows);
}

const CLARIFY_LABELS: Record<StockChangeIntent, string> = { ADD_STOCK: "📥 Masuk", REDUCE_STOCK: "📤 Keluar", SET_STOCK: "🔄 Jadikan" };

/**
 * "minyak 20" matched no product name and has no verb. Nothing is guessed: the user
 * chooses what the number means, and the choice still ends in a preview to confirm.
 */
export function clarifyQuantityReply(query: string, quantity: number, request: string, scope: UpdateScope): TelegramReply {
  const value = number(quantity);
  const rows: InlineButton[][] = [
    [clarifyButton(`${CLARIFY_LABELS.ADD_STOCK} ${value}`, "ADD_STOCK", request, scope), clarifyButton(`${CLARIFY_LABELS.REDUCE_STOCK} ${value}`, "REDUCE_STOCK", request, scope)],
    [clarifyButton(`${CLARIFY_LABELS.SET_STOCK} ${value}`, "SET_STOCK", request, scope)],
    [menuButton("❌ Batal", "stock_cancel")],
  ];
  // The request line must stay right after STOCK_REQUEST_LABEL: the buttons read it back.
  return inlineReply(text(
    "🤔 Maksudnya apa?",
    "",
    `Saya membaca barang "${compact(query, 60)}" dan angka ${value}.`,
    "Pilih yang dimaksud. Stok belum berubah sampai Anda konfirmasi.",
    "",
    STOCK_REQUEST_LABEL,
    request,
  ), rows);
}

/** A bare number outside a quantity question is never used as a quantity. */
export function bareNumberReply(value: string): TelegramReply {
  return menuReply(text(
    `🔢 Angka ${compact(value, 20)} untuk apa?`,
    "",
    "Jika sedang mengisi jumlah, balas (reply) pesan pertanyaan jumlahnya, atau tekan lagi tombol barangnya.",
    "",
    "Atau tulis lengkap, misalnya:",
    `• minyak masuk ${compact(value, 20)}`,
    `• stok minyak sekarang ${compact(value, 20)}`,
  ));
}

// ---------------------------------------------------------------- history and analysis

export const HISTORY_LIMIT = 15;

const HISTORY_TYPE_TITLES: Record<StockChangeIntent, string> = {
  ADD_STOCK: "Barang Masuk", REDUCE_STOCK: "Barang Keluar", SET_STOCK: "Koreksi Stok",
};
const HISTORY_ICONS: Record<string, string> = { ADD_STOCK: "📥", REDUCE_STOCK: "📤", SET_STOCK: "🔄", STOCK_OPNAME: "🔄" };

function historyAmount(entry: TransactionEntry): string {
  if (entry.type === "ADD_STOCK") return `+${amount(entry.quantity, entry.unit)}`;
  if (entry.type === "REDUCE_STOCK") return `-${amount(entry.quantity, entry.unit)}`;
  return `${number(entry.stockBefore)} → ${amount(entry.stockAfter, entry.unit)}`;
}

export function historyReply(result: HistoryResult): TelegramReply {
  if (result.status === "INVALID_PERIOD") return invalidPeriodReply();
  const { request, period, entries } = result;
  const title = `📜 Riwayat ${request.type ? HISTORY_TYPE_TITLES[request.type] : "Transaksi"}`;
  const scopeLine = [
    request.productQuery ? `Barang: "${compact(request.productQuery, 60)}"` : null,
    `Periode: ${period ? period.label : "semua waktu"}`,
  ].filter(Boolean).join("\n");
  const rows: InlineButton[][] = [[menuButton("📊 Laporan PDF", "report"), menuButton("⬅️ Menu", "menu")]];
  if (!entries.length) {
    return inlineReply(text(title, "", scopeLine, "", "Belum ada transaksi yang tercatat."), rows);
  }
  const shown = entries.slice(0, HISTORY_LIMIT);
  const moved = (type: string) => entries.filter((entry) => entry.type === type).length;
  return inlineReply(text(
    title,
    "",
    scopeLine,
    `Total: ${entries.length} transaksi (masuk ${moved("ADD_STOCK")}, keluar ${moved("REDUCE_STOCK")}, koreksi ${moved("SET_STOCK") + moved("STOCK_OPNAME")})`,
    "",
    ...shown.flatMap((entry) => [
      `${HISTORY_ICONS[entry.type ?? ""] ?? "•"} ${compact(entry.productName || entry.sku, 70)} ${historyAmount(entry)}`,
      `   ${compact(entry.dateText, 12)} ${compact(entry.timeText, 8)} · ${compact(entry.typeLabel, 14)}`,
    ]),
    entries.length > shown.length && `\nMenampilkan ${shown.length} transaksi terbaru. Laporan lengkap ada di 📊 Laporan.`,
  ), rows);
}

const ANALYSIS_TITLES = {
  TOP_OUT: "🏆 Barang Paling Banyak Keluar",
  TOP_IN: "🏆 Barang Paling Banyak Masuk",
  FREQUENT_OUT: "🔁 Barang Paling Sering Keluar",
  FREQUENT_IN: "🔁 Barang Paling Sering Masuk",
} as const;

export function analysisReply(result: AnalysisResult): TelegramReply {
  if (result.status === "INVALID_PERIOD") return invalidPeriodReply();
  const rows: InlineButton[][] = [[menuButton("⚠️ Stok Menipis", "low"), menuButton("⬅️ Menu", "menu")]];
  const title = ANALYSIS_TITLES[result.metric];
  const periodLine = `Periode: ${result.period.label}`;
  if (!result.rows.length) return inlineReply(text(title, "", periodLine, "", "Belum ada transaksi pada periode ini."), rows);
  const byCount = result.metric.startsWith("FREQUENT");
  return inlineReply(text(
    title,
    "",
    periodLine,
    "",
    ...result.rows.map((row, index) =>
      `${index + 1}. ${compact(row.name, 70)} — ${byCount ? `${row.count}× (${amount(row.quantity, row.unit)})` : `${amount(row.quantity, row.unit)} (${row.count}×)`}`),
    result.defaultPeriod && "",
    result.defaultPeriod && "💡 Tambahkan periode, misalnya \"minggu ini\" atau \"bulan lalu\".",
  ), rows);
}

export function invalidPeriodReply(): TelegramReply {
  return menuReply(text(
    "📅 Tanggal tidak valid",
    "",
    "Contoh periode yang bisa dipakai:",
    "• hari ini, kemarin",
    "• minggu ini, bulan lalu",
    "• 7 hari terakhir",
    "• tanggal 1 sampai 15",
  ));
}
