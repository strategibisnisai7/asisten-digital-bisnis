// Telegram presentation layer: every user-facing text and button is built here.
// Business modules return data; this module turns it into plain-text messages.
// Plain text (no parse_mode) keeps sheet content from injecting Markdown/HTML.
import { getAppConfig } from "../config/app";
import { stockLevel, type InventoryProduct, type InventoryResult, type StockLevel } from "../inventory/inventory-engine";
import type { Supplier, SupplierGroup, SupplierRequest } from "../supplier/supplier-service";
import { whatsappLink } from "../supplier/whatsapp";
import {
  MAX_STOCK_QUANTITY, MAX_TRANSACTION_ITEMS,
  type AppliedChange, type ApplyResult, type ConfirmedChange, type PlanLine, type PlannedChange, type QuantityProblem, type StockPlan,
} from "../inventory/stock-update";
import type { StockChangeIntent, StockItemRequest } from "../parser/intents";
import { STOCK_COMMAND_WORDS } from "../parser/rule-parser";
import {
  callbackData, menuButton, productButton, resolveButton, sealStockSummary, searchHeader, STOCK_REQUEST_LABEL,
} from "./callbacks";
import type { InlineButton, ReplyKeyboard, TelegramReply, UrlButton } from "./types";

// Separates a product name from its SKU in a stock summary line.
const SKU_SEPARATOR = " · ";

export const MENU_LABELS = {
  check: "🔍 Cek Stok",
  update: "📝 Update Stok",
  low: "⚠️ Stok Menipis",
  search: "📋 Cari Barang",
  supplier: "📞 Hubungi Supplier",
  report: "📊 Laporan",
  help: "❓ Bantuan",
} as const;

export const MAIN_MENU: ReplyKeyboard = {
  keyboard: [
    [{ text: MENU_LABELS.check }, { text: MENU_LABELS.update }],
    [{ text: MENU_LABELS.low }],
    [{ text: MENU_LABELS.search }, { text: MENU_LABELS.supplier }],
    [{ text: MENU_LABELS.report }, { text: MENU_LABELS.help }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

export const PAGE_SIZE = 8;

export interface FormatContext { chatId: number; secret: string; query?: string; page?: number; now?: number }

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
    "Saya bisa membantu Anda mengecek stok, memperbarui persediaan, melihat laporan, hingga membuat pesanan ke supplier.",
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
  ["📞", "butuh minyak goreng 20"],
] as const;

export function helpReply(): TelegramReply {
  return menuReply(text(
    "❓ Bantuan",
    "",
    "Kamu bisa langsung bertanya seperti:",
    "",
    ...HELP_EXAMPLES.map(([icon, example]) => `${icon} "${example}"`),
    "",
    "Atau gunakan tombol menu di bawah.",
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

export function updateStockMenuReply(): TelegramReply {
  return inlineReply(text("📝 Update Stok", "", "Pilih jenis perubahan:"), [
    [menuButton(STOCK_PROMPTS.ADD_STOCK.title, "stock_in")],
    [menuButton(STOCK_PROMPTS.REDUCE_STOCK.title, "stock_out")],
    [menuButton(STOCK_PROMPTS.SET_STOCK.title, "stock_fix")],
    [menuButton("⬅️ Kembali", "menu")],
  ]);
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

// ---------------------------------------------------------------- contacting suppliers

const SUPPLIER_ORDER_PROMPT = { title: "📦 Pesan Barang", ask: "Ketik barang dan jumlah yang dibutuhkan." };

export function supplierMenuReply(): TelegramReply {
  return inlineReply("📞 Hubungi Supplier", [
    [menuButton("📦 Pesan Barang", "supplier_order")],
    [menuButton("📋 Lihat Supplier", "supplier_list")],
    [menuButton("🔎 Cari Barang", "search")],
    [menuButton("⬅️ Kembali", "menu")],
  ]);
}

/** Asks what is needed; the reply box opens on this message so the answer keeps its context. */
export function supplierOrderPromptReply(): TelegramReply {
  return {
    text: text(
      SUPPLIER_ORDER_PROMPT.title,
      "",
      SUPPLIER_ORDER_PROMPT.ask,
      "Bisa beberapa barang sekaligus, pisahkan dengan koma.",
      "",
      "Contoh:",
      "minyak goreng 20, gula 30",
    ),
    reply_markup: { force_reply: true, input_field_placeholder: "minyak goreng 20, gula 30" },
  };
}

export function isSupplierOrderPrompt(message: string | undefined): boolean {
  const lines = message?.split("\n").map((line) => line.trim()) ?? [];
  return lines[0] === SUPPLIER_ORDER_PROMPT.title && lines[2] === SUPPLIER_ORDER_PROMPT.ask;
}

function requestLines(group: SupplierGroup): string[] {
  return group.lines.map((line) => `• ${compact(line.product.name, 100)} — ${amount(line.quantity, line.product.unit)}`);
}

/** The message the user sends on WhatsApp; nothing is sent automatically. */
export function supplierMessage(group: SupplierGroup): string {
  const { companyName } = getAppConfig();
  return text(
    group.supplierName ? `Halo ${group.supplierName},` : "Halo,",
    "",
    `Kami dari ${companyName} ingin memesan:`,
    ...requestLines(group),
    "",
    "Mohon informasi ketersediaan dan harganya. Terima kasih.",
  );
}

export function supplierRequestReply(request: SupplierRequest): TelegramReply {
  if (request.status === "NOT_FOUND") {
    return menuReply(text(
      SUPPLIER_ORDER_PROMPT.title,
      "",
      "Saya belum menemukan barang dengan nama:",
      `"${compact(request.query, 200)}"`,
      "",
      "Periksa kembali nama barang atau SKU-nya.",
    ));
  }
  if (request.status === "AMBIGUOUS") {
    const shown = request.products.slice(0, PAGE_SIZE);
    return menuReply(text(
      SUPPLIER_ORDER_PROMPT.title,
      "",
      `Ada ${request.products.length} barang yang cocok dengan "${compact(request.query, 100)}":`,
      ...shown.map((product) => `• ${compact(product.name, 100)}`),
      request.products.length > shown.length && `• dan ${request.products.length - shown.length} lainnya`,
      "",
      "Tulis nama barang yang lebih lengkap, misalnya:",
      `"butuh ${compact(shown[0].name, 100)} ${number(request.quantity)}"`,
    ));
  }

  const single = request.groups.length === 1;
  const body = text(
    "📋 Kebutuhan Barang",
    ...request.groups.flatMap((group) => [
      "",
      compact(group.supplierName || "Supplier belum ditentukan", 100),
      "",
      ...requestLines(group),
      !group.supplier?.whatsapp && "Kontak WhatsApp belum tersedia.",
    ]),
    "",
    "Hubungi supplier melalui WhatsApp?",
  );
  // Tapping a WhatsApp button opens a prefilled chat; the user still presses send.
  const rows: (InlineButton | UrlButton)[][] = request.groups.map((group) => [{
    text: group.supplier?.whatsapp
      ? (single ? "💬 WhatsApp Supplier" : `💬 WhatsApp ${compact(group.supplierName, 40)}`)
      : `💬 Bagikan via WhatsApp${single ? "" : ` (${compact(group.supplierName || "tanpa supplier", 30)})`}`,
    url: whatsappLink(group.supplier?.whatsapp ?? null, supplierMessage(group)),
  }]);
  rows.push([menuButton("❌ Batal", "supplier_cancel")]);
  return inlineReply(body, rows);
}

export function supplierCancelledReply(): TelegramReply {
  return menuReply(text("❌ Dibatalkan.", "", "Tidak ada pesan yang dikirim ke supplier."));
}

export function supplierListReply(suppliers: readonly Supplier[]): TelegramReply {
  if (!suppliers.length) return menuReply(text("📋 Daftar Supplier", "", "Belum ada data supplier."));
  const shown = suppliers.slice(0, 30);
  const body = text(
    "📋 Daftar Supplier",
    ...shown.flatMap((supplier) => [
      "",
      `🏢 ${compact(supplier.name, 80)}`,
      supplier.city && `Kota: ${compact(supplier.city, 60)}`,
      `Kontak: ${supplier.contact ? compact(supplier.contact, 40) : "-"}`,
      supplier.note && `Keterangan: ${compact(supplier.note, 120)}`,
      !supplier.whatsapp && "Kontak WhatsApp belum tersedia.",
    ]),
    suppliers.length > shown.length && `\ndan ${suppliers.length - shown.length} supplier lainnya.`,
  );
  const rows: (InlineButton | UrlButton)[][] = shown
    .filter((supplier) => supplier.whatsapp)
    .map((supplier) => [{ text: `💬 WhatsApp ${compact(supplier.name, 40)}`, url: `https://wa.me/${supplier.whatsapp}` }]);
  rows.push([menuButton("⬅️ Kembali", "supplier")]);
  return inlineReply(body, rows);
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

/** Full detail after the user picks a product: the stock amount leads. */
export function productDetailReply(product: InventoryProduct): TelegramReply {
  return menuReply(text(
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
  ));
}

/** A search with exactly one match skips the choice step. */
export function productFoundReply(product: InventoryProduct): TelegramReply {
  return menuReply(text(
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
  ));
}

export function notFoundReply(query: string): TelegramReply {
  return inlineReply(text(
    "🔎 Barang tidak ditemukan",
    "",
    "Saya belum menemukan barang dengan nama:",
    `"${compact(query, 200)}"`,
    "",
    "Coba gunakan nama barang atau SKU yang lebih spesifik.",
  ), [[menuButton(MENU_LABELS.search, "search")]]);
}

function pageOf(total: number, requested = 0) {
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.max(0, Math.min(Math.floor(requested), pageCount - 1));
  return { page, pageCount, start: page * PAGE_SIZE, end: (page + 1) * PAGE_SIZE };
}

function navigation(kind: "search" | "low", value: string, page: number, pageCount: number, context: FormatContext): InlineButton[] {
  const buttons: InlineButton[] = [];
  if (page > 0) buttons.push({ text: "◀️ Sebelumnya", callback_data: callbackData({ kind, value, page: page - 1 }, context.chatId, context.secret) });
  if (page < pageCount - 1) buttons.push({ text: "Berikutnya ▶️", callback_data: callbackData({ kind, value, page: page + 1 }, context.chatId, context.secret) });
  return buttons;
}

export function productChoiceReply(products: InventoryProduct[], context: FormatContext): TelegramReply {
  const query = context.query ?? "";
  const { page, pageCount, start, end } = pageOf(products.length, context.page);
  const rows: InlineButton[][] = products.slice(start, end)
    .map((product) => [productButton(`📦 ${compact(product.name, 60)}`, product.sku, context.chatId, context.secret)]);
  const nav = navigation("search", query, page, pageCount, context);
  if (nav.length) rows.push(nav);
  // The first line must stay searchHeader(): pagination reads the query back from it.
  return inlineReply(text(
    searchHeader(products.length, query),
    "",
    pageCount > 1 ? `Silakan pilih (halaman ${page + 1} dari ${pageCount}):` : "Silakan pilih:",
  ), rows);
}

export function lowStockReply(products: InventoryProduct[], context: FormatContext): TelegramReply {
  if (products.length === 0) {
    return menuReply(text("✅ Semua stok aman", "", "Tidak ada barang yang berada di bawah stok minimum."));
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
  return nav.length ? inlineReply(body, [nav]) : menuReply(body);
}

export function formatInventoryResult(result: InventoryResult, context: FormatContext): TelegramReply {
  const query = context.query ?? "";
  switch (result.status) {
    case "NOT_FOUND":
      return notFoundReply(query);
    case "INVALID_QUERY":
      return result.intent === "CHECK_STOCK" ? checkStockPromptReply() : searchPromptReply();
    case "UNSUPPORTED_INTENT":
      return updateStockMenuReply();
    case "MULTIPLE_MATCHES":
      return productChoiceReply(result.products, context);
  }
  if ("product" in result) return productDetailReply(result.product);
  if (result.intent === "LOW_STOCK") return lowStockReply(result.products, context);
  if (result.products.length === 0) return notFoundReply(query);
  if (result.products.length === 1) return productFoundReply(result.products[0]);
  return productChoiceReply(result.products, context);
}

// ---------------------------------------------------------------- stock updates

const STOCK_PROMPTS: Record<StockChangeIntent, { title: string; ask: string; example: string; done: string }> = {
  ADD_STOCK: { title: "📥 Barang Masuk", ask: "Ketik barang dan jumlah yang masuk.", example: "minyak 20, gula 30, beras 50", done: "minyak 20" },
  REDUCE_STOCK: { title: "📤 Barang Keluar", ask: "Ketik barang dan jumlah yang keluar.", example: "beras 10, minyak 5", done: "minyak 5" },
  SET_STOCK: { title: "🔄 Koreksi Stok", ask: "Ketik barang dan stok akhir yang benar.", example: "minyak jadi 50, gula jadi 20", done: "minyak jadi 50" },
};
// The line that tells a confirmation summary apart from the prompt with the same title.
const SUMMARY_INTRO = "Berikut perubahan stok:";
const STOCK_INTENTS = Object.keys(STOCK_PROMPTS) as StockChangeIntent[];

/** Asks for an item list; the reply box opens on this message so the answer keeps its context. */
export function stockPromptReply(intent: StockChangeIntent): TelegramReply {
  const prompt = STOCK_PROMPTS[intent];
  return {
    text: text(prompt.title, "", prompt.ask, "Bisa beberapa barang sekaligus, pisahkan dengan koma.", "", "Contoh:", prompt.example),
    reply_markup: { force_reply: true, input_field_placeholder: prompt.example.slice(0, 64) },
  };
}

/** Which stock prompt a replied-to message is, if any. */
export function stockPromptIntent(message: string | undefined): StockChangeIntent | null {
  const lines = message?.split("\n").map((line) => line.trim()) ?? [];
  return STOCK_INTENTS.find((intent) => STOCK_PROMPTS[intent].title === lines[0] && STOCK_PROMPTS[intent].ask === lines[2]) ?? null;
}

function signedAmount(intent: StockChangeIntent, change: Pick<PlannedChange, "quantity" | "unit" | "merged">): string {
  const base = intent === "SET_STOCK" ? `jadi ${amount(change.quantity, change.unit)}`
    : `${intent === "ADD_STOCK" ? "+" : "-"}${amount(change.quantity, change.unit)}`;
  return change.merged.length ? `${base} (${change.merged.map(number).join(" + ")})` : base;
}

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
  }
}

/** The request as a command the parser reads back, e.g. "barang masuk: minyak 20, gula 30". */
export function stockRequestText(intent: StockChangeIntent, items: readonly StockItemRequest[]): string {
  const value = (quantity: number) => String(quantity).replace(".", ",");
  return `${STOCK_COMMAND_WORDS[intent]}: ${items.map((item) => `${item.product_query} ${intent === "SET_STOCK" ? "jadi " : ""}${value(item.quantity)}`).join(", ")}`;
}

function stockConfirmBody(intent: StockChangeIntent, changes: readonly PlannedChange[]): string {
  return text(
    STOCK_PROMPTS[intent].title,
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

export function stockPlanReply(plan: StockPlan, context: FormatContext): TelegramReply {
  const prompt = STOCK_PROMPTS[plan.intent];
  switch (plan.status) {
    case "EMPTY":
      return stockPromptReply(plan.intent);
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
        `"${prompt.done}"`,
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
          : `✕ "${compact(line.query, 60)}" — ${lineProblem(line)}`),
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
      return inlineReply(sealStockSummary(stockConfirmBody(plan.intent, plan.changes), context.chatId, context.secret, context.now), [
        [menuButton("✅ Konfirmasi", "stock_confirm")],
        [menuButton("❌ Batal", "stock_cancel")],
      ]);
  }
}

function parseNumber(value: string): number {
  const clean = value.replace(/−/g, "-").replace(/\./g, "").replace(",", ".");
  return /^-?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : Number.NaN;
}

/** Reads a confirmation summary produced by stockPlanReply back into changes. */
export function parseStockSummary(body: string): { intent: StockChangeIntent; changes: (ConfirmedChange & { name: string })[] } | null {
  const lines = body.split("\n").map((line) => line.trim());
  const intent = STOCK_INTENTS.find((candidate) => STOCK_PROMPTS[candidate].title === lines[0]);
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
    "Konfirmasi berlaku 30 menit. Silakan kirim ulang perintah update agar stok terbaru dipakai.",
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

function changeLines(changes: readonly AppliedChange[]): string[] {
  return changes.flatMap((change) => ["", `• ${compact(change.name, 100)}`, `  ${number(change.before)} → ${amount(change.after, change.unit)}`]);
}

export function stockApplyReply(result: ApplyResult): TelegramReply {
  switch (result.status) {
    case "SAVED":
      return menuReply(text(
        "✅ Stok berhasil diperbarui",
        "",
        `${result.changes.length} barang telah diperbarui:`,
        ...changeLines(result.changes),
        "",
        "Semua perubahan berhasil disimpan.",
        result.transactionId ? `ID transaksi: ${result.transactionId}` : "Catatan: riwayat transaksi belum tercatat.",
      ));
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
        "Kirim ulang perintah update agar ringkasan memakai stok terbaru.",
      ));
    case "INVALID":
      return menuReply(text("Ringkasan ini tidak dapat diproses.", "", "Silakan kirim ulang perintah update."));
    case "WRITE_FAILED":
      return result.outcome === "NOTHING_SAVED"
        ? menuReply(text("❌ Update gagal disimpan", "", "Tidak ada perubahan stok yang tersimpan. Silakan coba lagi beberapa saat lagi."))
        : menuReply(text("⚠️ Update belum dapat dipastikan", "", "Terjadi kendala saat menyimpan. Periksa stok barang terkait sebelum mencoba lagi."));
  }
}
