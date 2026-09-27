import assert from "node:assert/strict";
import { test } from "node:test";
import type { StokCellWrite } from "../lib/google-sheets/service";
import type { StokItem } from "../lib/google-sheets/stok";
import { executeInventoryIntent } from "../lib/inventory/inventory-engine";
import type { InventoryProduct } from "../lib/inventory/inventory-engine";
import { parseTransactionRows, type TransactionStore } from "../lib/inventory/transaction-service";
import { parseRuleIntent } from "../lib/parser/rule-parser";
import type { Supplier } from "../lib/supplier/supplier-service";
import { handleTelegramUpdate, type AdapterDependencies } from "../lib/telegram/adapter";
import { createTelegramBot } from "../lib/telegram/bot-service";
import { callbackData, productButton, readCallback } from "../lib/telegram/callbacks";
import { isStockWriteEnabled } from "../lib/telegram/config";
import {
  formatInventoryResult, HELP_EXAMPLES, MAIN_MENU, PAGE_SIZE, productDetailReply, productFoundReply,
} from "../lib/telegram/formatting";
import { createWebhookHandler } from "../lib/telegram/webhook";
import { parseTelegramEvent } from "../lib/telegram/types";
import type { InlineButton, TelegramDocument, TelegramReply, UrlButton } from "../lib/telegram/types";

// Fixtures only: no test here reads or writes the production spreadsheet.
const secret = "unit-test-secret-only-not-a-bot-token";
const oil1: InventoryProduct = { sku: "BRG0006", name: "Minyak Goreng 1L", unit: "botol", currentStock: 82, minimumStock: 20, status: "AMAN", rack: "A-03", supplier: "PT Sumber Makmur" };
const oil2: InventoryProduct = { ...oil1, sku: "BRG0007", name: "Minyak Goreng 2L", currentStock: 80, minimumStock: 17 };
const sugar: InventoryProduct = { sku: "BRG0010", name: "Gula Pasir 1kg", unit: "kg", currentStock: 14, minimumStock: 15, status: "STOK RENDAH", rack: "R-02", supplier: "PT Sumber Makmur" };
const rice: InventoryProduct = { sku: "BRG0020", name: "Beras Premium 5kg", unit: "karung", currentStock: 40, minimumStock: 10, status: "AMAN", rack: "R-05", supplier: "CV Berkah Jaya" };
const toRow = (p: InventoryProduct, i: number): StokItem => ({
  rowNumber: i + 2, sku: p.sku, namaBarang: p.name, satuan: p.unit, stokAwal: p.currentStock,
  barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: p.currentStock,
  stokMinimum: p.minimumStock, statusStok: p.status, lokasiRak: p.rack, supplierUtama: p.supplier,
});
const rows: StokItem[] = [oil1, oil2, sugar, rice].map(toRow);
const suppliers: Supplier[] = [
  { code: "SUP001", name: "PT Sumber Makmur", city: "Malang", contact: "083472087316", note: "Supplier aktif", whatsapp: "6283472087316" },
  { code: "SUP002", name: "CV Berkah Jaya", city: "Malang", contact: "", note: "Supplier aktif", whatsapp: null },
];
const context = { chatId: 42, secret };
const TECHNICAL = /intent|parser|engine|candidate|kandidat|debug|halaman 1\/1|page \d|error|SUCCESS|NOT_FOUND|\bnull\b|undefined/i;
// Case-sensitive on purpose: "Pesanan" contains "nan", and the welcome text
// legitimately says "membuat pesanan" while the old menu label must not appear.
const RAW_VALUE = /NaN|\[object|Buat Pesanan/;

const message = (text: string) => ({ update_id: 1, message: { chat: { id: 42 }, from: { id: 7, username: "kasir" }, text } });
function inline(reply: TelegramReply): (InlineButton | UrlButton)[] {
  assert.ok(reply.reply_markup && "inline_keyboard" in reply.reply_markup, "expected inline keyboard");
  return reply.reply_markup.inline_keyboard.flat();
}
function buttons(reply: TelegramReply): InlineButton[] {
  return inline(reply).filter((button): button is InlineButton => "callback_data" in button);
}
function links(reply: TelegramReply): UrlButton[] {
  return inline(reply).filter((button): button is UrlButton => "url" in button);
}
function button(reply: TelegramReply, label: string): InlineButton {
  const found = buttons(reply).find((b) => b.text.includes(label));
  assert.ok(found, `button ${label}`);
  return found;
}
function callback(reply: TelegramReply, target: InlineButton, chatId = 42, userId = 7) {
  return { update_id: 2, callback_query: { id: "query-id", data: target.callback_data, from: { id: userId, username: "kasir" }, message: { message_id: 99, chat: { id: chatId }, text: reply.text, reply_markup: reply.reply_markup } } };
}
const replyTo = (text: string, original: Pick<TelegramReply, "text">, userId = 7) => ({
  update_id: 3, message: { chat: { id: 42 }, from: { id: userId, username: "kasir" }, text, reply_to_message: { text: original.text, from: { id: 1, is_bot: true } } },
});

/**
 * In-memory stand-in for the spreadsheet. A commit applies the E/F/G cells (H is
 * recomputed like the sheet formula) and appends the history rows together, or
 * throws before changing anything, like Google's atomic batchUpdate.
 */
function harness(options: { writeEnabled?: boolean; formulaBroken?: boolean; failCommit?: boolean } = {}) {
  const sent: TelegramReply[] = [];
  const documents: TelegramDocument[] = [];
  const intents: string[] = [];
  const source = structuredClone(rows);
  const acknowledgments: string[] = [];
  const keyboards: { messageId: number; rows: (InlineButton | UrlButton)[][] }[] = [];
  const writes: StokCellWrite[][] = [];
  const history: (string | number)[][] = [];
  let reads = 0;
  let stockReads = 0;
  // 27/09/2026 10:15 in Asia/Jakarta.
  let clock = Date.UTC(2026, 8, 27, 3, 15, 0);
  const transactions: TransactionStore = {
    async readTransactionIds() { return history.map((row) => String(row[0])); },
    async commit(cells, historyRows) {
      if (options.failCommit) throw new Error("private-sensitive-sentinel");
      writes.push([...cells]);
      for (const cell of cells) {
        const row = source.find((item) => item.rowNumber === cell.rowNumber)!;
        if (cell.column === "E") row.barangMasuk = cell.value;
        if (cell.column === "F") row.barangKeluar = cell.value;
        if (cell.column === "G") row.adjustment = cell.value;
        if (!options.formulaBroken) row.stokAkhir = row.stokAwal + row.barangMasuk - row.barangKeluar + row.adjustment;
      }
      history.push(...historyRows);
    },
  };
  const dependencies: AdapterDependencies = {
    secret,
    bot: {
      async sendMessage(_id: number, reply: TelegramReply) { sent.push(reply); },
      async sendDocument(_id: number, document: TelegramDocument) { documents.push(document); },
      async answerCallbackQuery(id: string) { acknowledgments.push(id); },
      async setInlineKeyboard(_chat: number, messageId: number, rowsToSet: (InlineButton | UrlButton)[][]) { keyboards.push({ messageId, rows: rowsToSet }); },
    },
    execute: (async (intent) => { intents.push(intent.intent); return executeInventoryIntent(intent, async () => { reads++; return source; }); }) as typeof executeInventoryIntent,
    stock: {
      writeEnabled: options.writeEnabled ?? true,
      now: () => clock,
      read: async () => { stockReads++; return structuredClone(source); },
      transactions,
    },
    supplier: { readSuppliers: async () => suppliers },
    report: { readTransactions: async () => parseTransactionRows(history) },
  };
  return {
    sent, documents, intents, source, acknowledgments, dependencies, writes, history, keyboards,
    /** Messages whose buttons were removed. */
    get cleared() { return keyboards.filter((entry) => entry.rows.length === 0).map((entry) => entry.messageId); },
    get reads() { return reads; },
    get stockReads() { return stockReads; },
    get last() { return sent.at(-1)!; },
    advance(ms: number) { clock += ms; },
    stockOf: (sku: string) => source.find((item) => item.sku === sku)!.stokAkhir,
    say: (text: string) => handleTelegramUpdate(message(text), dependencies),
    reply: (text: string, original: Pick<TelegramReply, "text">, userId = 7) => handleTelegramUpdate(replyTo(text, original, userId), dependencies),
    tap: (reply: TelegramReply, label: string, userId = 7) => handleTelegramUpdate(callback(reply, button(reply, label), 42, userId), dependencies),
  };
}

// ---------------------------------------------------------------- menu and reading

test("start shows the Asisten Digital welcome and the seven-button main menu", async () => {
  const h = harness();
  await h.say("/start");
  assert.equal(h.last.text, [
    "👋 Halo! Saya Asisten Digital PT Indah Merta Anugerah.",
    "",
    "Saya bisa membantu Anda mengecek stok, memperbarui persediaan, melihat laporan, hingga membuat pesanan ke supplier.",
    "",
    "Ada yang ingin Anda lakukan?",
  ].join("\n"));
  assert.doesNotMatch(h.last.text, /Asisten Digital Bisnis/);
  assert.deepEqual(h.last.reply_markup, MAIN_MENU);
  assert.deepEqual(MAIN_MENU.keyboard.map((row) => row.map((b) => b.text)), [
    ["🔍 Cek Stok", "📝 Update Stok"], ["⚠️ Stok Menipis"], ["📋 Cari Barang", "📞 Hubungi Supplier"], ["📊 Laporan", "❓ Bantuan"],
  ]);
  assert.doesNotMatch(JSON.stringify(MAIN_MENU), /Buat Pesanan/);
  assert.equal(h.reads, 0);
});

test("every main-menu label opens its flow instead of UNKNOWN", async () => {
  const h = harness();
  const first: Record<string, string> = {};
  for (const label of MAIN_MENU.keyboard.flat().map((b) => b.text)) {
    const before = h.sent.length;
    await h.say(label);
    first[label] = h.sent[before].text;
  }
  assert.match(first["🔍 Cek Stok"], /^🔍 Cek Stok\n\nKetik nama barang atau SKU yang ingin dicek\.\n\nContoh:\n• minyak goreng/);
  assert.match(first["📝 Update Stok"], /^📝 Update Stok\n\n🔎 Cari barang yang ingin diperbarui\./);
  assert.match(first["⚠️ Stok Menipis"], /^⚠️ Stok Menipis\n\nAda 1 barang yang perlu diperhatikan:/);
  assert.match(first["📋 Cari Barang"], /^📋 Cari Barang\n\nKetik nama barang atau SKU/);
  assert.equal(first["📞 Hubungi Supplier"], "📞 Hubungi Supplier\n\nPilih supplier:");
  assert.equal(first["📊 Laporan"], "📊 Sedang menyiapkan laporan bulan ini...");
  assert.match(first["❓ Bantuan"], /^❓ Bantuan/);
  assert.ok(h.sent.every((reply) => !reply.text.includes("belum paham")));
});

test("CHECK_STOCK variants: bare commands prompt, named ones show the product", async () => {
  const h = harness();
  for (const input of ["cek stok", "cek stock", "lihat stok", "stok"]) await h.say(input);
  assert.ok(h.sent.every((reply) => reply.text.startsWith("🔍 Cek Stok")));
  for (const input of ["stok gula", "cek stok gula", "cek stock gula", "lihat stok gula", "berapa stok gula", "gula tinggal berapa?"]) {
    await h.say(input);
    assert.match(h.last.text, /^📦 Gula Pasir 1kg\n\nStok saat ini\n14 kg\n\n🟡 Menipis/, input);
  }
  assert.ok(h.intents.every((intent) => intent === "CHECK_STOCK"));
});

test("single product: a search with one match shows details right away", async () => {
  const h = harness();
  await h.say("cari gula");
  assert.equal(h.last.text, [
    "🔎 Ditemukan", "", "📦 Gula Pasir 1kg", "",
    "Stok: 14 kg", "Status: 🟡 Menipis", "Minimum: 15 kg", "Rak: R-02", "SKU: BRG0010", "Supplier: PT Sumber Makmur",
  ].join("\n"));
  assert.equal("parse_mode" in h.last, false);
});

test("multiple products: natural header and product-name buttons, SKU only after picking", async () => {
  const h = harness();
  await h.say("cek stok minyak goreng");
  const list = h.last;
  assert.equal(list.text, "🔎 Saya menemukan 2 barang untuk \"minyak goreng\".\n\nSilakan pilih:");
  assert.deepEqual(buttons(list).map((b) => b.text), ["📦 Minyak Goreng 1L", "📦 Minyak Goreng 2L"]);
  assert.doesNotMatch(list.text, /BRG|Halaman|Pencarian/);

  h.source[0].stokAkhir = 99;
  await h.tap(list, "Minyak Goreng 1L");
  assert.deepEqual(h.acknowledgments, ["query-id"]);
  assert.equal(h.last.text, [
    "📦 Minyak Goreng 1L", "", "Stok saat ini", "99 botol", "", "🟢 Aman", "", "Stok minimum", "20 botol",
    "", "Lokasi", "Rak A-03", "", "SKU", "BRG0006", "", "Supplier", "PT Sumber Makmur",
  ].join("\n"));
  assert.equal(h.reads, 2);
});

test("product detail marks low and empty stock and tolerates missing fields", () => {
  assert.match(productDetailReply(sugar).text, /Stok saat ini\n14 kg\n\n🟡 Menipis\n\nStok minimum\n15 kg\n\nLokasi\nRak R-02/);
  assert.match(productDetailReply({ ...sugar, currentStock: 0 }).text, /\n🔴 Habis\n/);
  const bare = productDetailReply({ ...oil1, minimumStock: null, rack: "", supplier: "", unit: "" }).text;
  assert.match(bare, /Stok saat ini\n82\n/);
  assert.match(bare, /Stok minimum\nBelum ditentukan/);
  assert.doesNotMatch(bare, /Lokasi|Supplier|—/);
  assert.match(productDetailReply({ ...oil1, currentStock: 1500 }).text, /1\.500 botol/);
  assert.ok(productDetailReply({ ...oil1, name: "🔥<b>".repeat(5000), supplier: "x".repeat(10000) }).text.length < 4096);
  assert.match(productFoundReply({ ...oil1, rack: "Rak A-03" }).text, /Rak: A-03/);
});

test("product not found is friendly and offers the search button", async () => {
  const h = harness();
  await h.say("stok minyak goreng xyz");
  assert.equal(h.last.text, [
    "🔎 Barang tidak ditemukan", "", "Saya belum menemukan barang dengan nama:", "\"minyak goreng xyz\"", "",
    "Coba gunakan nama barang atau SKU yang lebih spesifik.",
  ].join("\n"));
  await h.tap(h.last, "Cari Barang");
  assert.match(h.last.text, /^📋 Cari Barang/);
});

test("low stock separates 🔴 Habis from 🟡 Menipis, without page text on one page", async () => {
  const h = harness();
  h.source[1].stokAkhir = 0;
  await h.say("barang apa yang hampir habis?");
  assert.equal(h.last.text, [
    "⚠️ Stok Menipis", "", "Ada 2 barang yang perlu diperhatikan:", "",
    "🔴 Minyak Goreng 2L", "Habis — 0 botol / minimum 17 botol", "",
    "🟡 Gula Pasir 1kg", "Menipis — 14 kg / minimum 15 kg",
  ].join("\n"));
  assert.deepEqual(h.last.reply_markup, MAIN_MENU);
  const empty = formatInventoryResult({ intent: "LOW_STOCK", status: "SUCCESS", products: [] }, context);
  assert.match(empty.text, /^✅ Semua stok aman/);
});

test("pagination: long lists page with ◀️/▶️, bounded text and 64-byte callbacks", async () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...sugar, sku: `SKU-${i}-${"超".repeat(80)}`, name: "Minyak ".repeat(80) }));
  for (const intent of ["SEARCH_PRODUCT", "LOW_STOCK"] as const) {
    const first = formatInventoryResult({ intent, status: "SUCCESS", products: many }, { ...context, query: "x".repeat(500) });
    assert.ok(first.text.length <= 4096);
    assert.match(first.text, /halaman 1 dari 4/i);
    assert.deepEqual(buttons(first).filter((b) => /Sebelumnya|Berikutnya/.test(b.text)).map((b) => b.text), ["Berikutnya ▶️"]);
    assert.ok(buttons(first).every((b) => Buffer.byteLength(b.callback_data) <= 64));
    const second = formatInventoryResult({ intent, status: "SUCCESS", products: many }, { ...context, query: "minyak", page: 1 });
    assert.match(second.text, /halaman 2 dari 4/i);
    assert.deepEqual(buttons(second).filter((b) => /Sebelumnya|Berikutnya/.test(b.text)).map((b) => b.text), ["◀️ Sebelumnya", "Berikutnya ▶️"]);
  }
  const search = formatInventoryResult({ intent: "SEARCH_PRODUCT", status: "SUCCESS", products: many }, { ...context, query: "minyak" });
  assert.equal(buttons(search).length, PAGE_SIZE + 1);
});

test("pagination callbacks re-read fresh data and verify the query", async () => {
  const h = harness();
  h.source.push(...Array.from({ length: 12 }, (_, i) => toRow({ ...oil1, sku: `NEW-${i}`, name: `Minyak Curah ${i}` }, 10 + i)));
  await h.say("minyak");
  const list = h.last;
  assert.match(list.text, /^🔎 Saya menemukan 14 barang untuk "minyak"\./);
  await h.tap(list, "Berikutnya");
  assert.match(h.last.text, /halaman 2 dari 2/);
  const event = parseTelegramEvent(callback(list, button(list, "Berikutnya")));
  assert.ok(event?.kind === "callback");
  assert.equal(readCallback({ ...event, text: event.text.replace("\"minyak\"", "\"rahasia\"") }, secret), null);
  assert.equal(h.reads, 2);
});

test("signed product buttons reject other chats, altered SKUs, and changed secrets; old buttons still work", () => {
  const reply = formatInventoryResult({ intent: "SEARCH_PRODUCT", status: "SUCCESS", products: [oil1, oil2] }, { ...context, query: "minyak" });
  const event = parseTelegramEvent(callback(reply, buttons(reply)[0]));
  assert.ok(event?.kind === "callback");
  assert.deepEqual(readCallback(event, secret), { kind: "pick", value: "BRG0006", page: 0 });
  assert.equal(readCallback({ ...event, chatId: 43 }, secret), null);
  assert.equal(readCallback({ ...event, data: event.data.replace("BRG0006", "BRG0007") }, secret), null);
  assert.equal(readCallback(event, "changed-secret"), null);
  const legacy = callbackData({ kind: "pick", value: "BRG0006", page: 0 }, 42, secret);
  const old = parseTelegramEvent({ update_id: 3, callback_query: { id: "q", data: legacy, message: { chat: { id: 42 }, text: "Pencarian: minyak", reply_markup: { inline_keyboard: [[{ text: "BRG0006", callback_data: legacy }]] } } } });
  assert.ok(old?.kind === "callback");
  assert.deepEqual(readCallback(old, secret), { kind: "pick", value: "BRG0006", page: 0 });
});

test("an SKU too long for callback_data moves into the label and stays verifiable", () => {
  const sku = "超".repeat(1000);
  const long = productButton("📦 Barang", sku, 42, secret);
  assert.ok(Buffer.byteLength(long.callback_data) <= 64);
  assert.equal(long.text, `📦 Barang · ${sku}`);
  const event = parseTelegramEvent({ update_id: 4, callback_query: { id: "q", data: long.callback_data, message: { chat: { id: 42 }, text: "x", reply_markup: { inline_keyboard: [[long]] } } } });
  assert.ok(event?.kind === "callback");
  assert.deepEqual(readCallback(event, secret), { kind: "pick", value: sku, page: 0 });
});

test("help lists examples that all work when typed", async () => {
  const h = harness();
  await h.say("bantuan");
  assert.match(h.last.text, /^❓ Bantuan\n\nKamu bisa langsung bertanya seperti:\n\n🔍 "stok minyak goreng"/);
  assert.deepEqual(HELP_EXAMPLES.map(([, example]) => parseRuleIntent(example).intent),
    ["CHECK_STOCK", "CHECK_STOCK", "LOW_STOCK", "SEARCH_PRODUCT", "ADD_STOCK", "CONTACT_SUPPLIER"]);
});

// ---------------------------------------------------------------- 📝 Update Stok: product-first

const SEAL = /\n\nKode: (?:UPD|QTY)-[0-9A-Z]+-[0-9A-F]{12}$/;
const withoutSeal = (reply: TelegramReply) => reply.text.replace(SEAL, "");
/** The detail message as it looks after its buttons were replaced (e.g. by "Batal"). */
function withKeyboard(reply: TelegramReply, rows: (InlineButton | UrlButton)[][]): TelegramReply {
  return { text: reply.text, reply_markup: { inline_keyboard: rows } };
}

/** Walks 📝 Update Stok → search → pick → action and returns the messages seen. */
async function startUpdate(h: ReturnType<typeof harness>, query: string, product: string | null, action: string) {
  await h.say("📝 Update Stok");
  const searchPrompt = h.last;
  await h.reply(query, searchPrompt);
  const results = h.last;
  if (product) await h.tap(results, product);
  const detail = h.last;
  await h.tap(detail, action);
  return { searchPrompt, results, detail, quantityPrompt: h.last };
}

test("Update Stok asks for a search term first, not for change types", async () => {
  const h = harness();
  await h.say("📝 Update Stok");
  assert.equal(h.last.text, "📝 Update Stok\n\n🔎 Cari barang yang ingin diperbarui.\n\nKetik nama barang atau SKU.\n\nContoh:\nberas");
  assert.deepEqual(h.last.reply_markup, { force_reply: true, input_field_placeholder: "Nama barang atau SKU" });
  assert.doesNotMatch(h.last.text, /Barang Masuk|Barang Keluar|Koreksi/);
  // Bare commands also start with the search, never with "nama barang + jumlah".
  for (const input of ["update stok", "barang masuk", "koreksi stok", "keluar"]) {
    await h.say(input);
    assert.match(h.last.text, /^📝 Update Stok\n\n🔎 Cari barang/, input);
  }
});

test("search: several matches show product-name buttons; one match opens the detail; none offers Cari Lagi", async () => {
  const h = harness();
  await h.say("📝 Update Stok");
  const prompt = h.last;
  await h.reply("minyak goreng", prompt);
  assert.equal(h.last.text, "🔎 Saya menemukan 2 barang untuk \"minyak goreng\".\n\nSilakan pilih:");
  assert.deepEqual(buttons(h.last).map((b) => b.text), ["📦 Minyak Goreng 1L", "📦 Minyak Goreng 2L", "🔎 Cari Lagi"]);
  const pick = parseTelegramEvent(callback(h.last, button(h.last, "Minyak Goreng 2L")));
  assert.ok(pick?.kind === "callback");
  assert.deepEqual(readCallback(pick, secret), { kind: "upd_pick", sku: "BRG0007" }, "the selected SKU travels in the button");

  await h.reply("gula", prompt);
  assert.match(h.last.text, /^📦 Gula Pasir 1kg\n\nStok saat ini\n14 kg\n\n🟡 Menipis\n/);

  await h.reply("sabun xyz", prompt);
  assert.equal(h.last.text, "⚠️ Barang tidak ditemukan\n\nSaya belum menemukan barang dengan nama:\n\"sabun xyz\"\n\nSilakan coba kata kunci lain.");
  assert.deepEqual(buttons(h.last).map((b) => b.text), ["🔎 Cari Lagi", "⬅️ Kembali"]);
  await h.tap(h.last, "Cari Lagi");
  assert.match(h.last.text, /^📝 Update Stok\n\n🔎 Cari barang/);
  assert.equal(h.writes.length, 0);
});

test("product detail shows the product and all three change types; Kembali returns to the results", async () => {
  const h = harness();
  await h.say("📝 Update Stok");
  await h.reply("minyak goreng", h.last);
  const results = h.last;
  await h.tap(results, "Minyak Goreng 1L");
  const detail = h.last;
  assert.equal(detail.text, [
    "📦 Minyak Goreng 1L", "", "Stok saat ini", "82 botol", "", "🟢 Aman", "", "Stok minimum", "20 botol",
    "", "Lokasi", "Rak A-03", "", "SKU", "BRG0006", "", "Supplier", "PT Sumber Makmur", "", "Apa yang ingin dilakukan?",
  ].join("\n"));
  assert.deepEqual(buttons(detail).map((b) => b.text), ["📥 Barang Masuk", "📤 Barang Keluar", "🔄 Koreksi Stok", "⬅️ Kembali"]);
  await h.tap(detail, "Kembali");
  assert.equal(h.last.text, results.text);
});

test("Barang Masuk: number only, preview, confirm, column E, history, success", async () => {
  const h = harness();
  const { detail, quantityPrompt } = await startUpdate(h, "minyak goreng", "Minyak Goreng 1L", "Barang Masuk");
  // The detail keeps the product but now offers only "Batal"; no new search is asked.
  assert.deepEqual(h.keyboards.at(-1)!.rows.flat().map((b) => b.text), ["❌ Batal"]);
  assert.equal(withoutSeal(quantityPrompt), [
    "📥 Barang Masuk", "", "📦 Minyak Goreng 1L", "SKU: BRG0006", "Stok saat ini: 82 botol", "",
    "Masukkan jumlah barang yang masuk.", "Contoh:", "20", "", "Ketik \"batal\" untuk kembali.",
  ].join("\n"));
  assert.match(quantityPrompt.text, SEAL);
  assert.deepEqual(quantityPrompt.reply_markup, { force_reply: true, input_field_placeholder: "Contoh: 20" });
  assert.ok(detail.text.startsWith("📦 Minyak Goreng 1L"));

  for (const invalid of ["20 kg", "dua puluh", "beras 20", "beras medium 20 kg", "0", "1,5"]) {
    await h.reply(invalid, quantityPrompt);
    assert.match(h.last.text, /^⚠️ Jumlah tidak valid\n\n/, invalid);
    assert.match(h.last.text, /📥 Barang Masuk\n\n📦 Minyak Goreng 1L/, "the prompt is repeated for the same product");
  }
  assert.equal(h.writes.length, 0);

  await h.reply("20", quantityPrompt);
  const preview = h.last;
  assert.equal(withoutSeal(preview), [
    "📥 Konfirmasi Barang Masuk", "", "📦 Minyak Goreng 1L", "SKU: BRG0006", "",
    "Stok saat ini : 82 botol", "Barang masuk : +20 botol", "Stok setelah : 102 botol",
  ].join("\n"));
  assert.deepEqual(buttons(preview).map((b) => b.text), ["✅ Konfirmasi", "❌ Batal"]);
  assert.equal(h.writes.length, 0, "nothing is written before confirmation");

  await h.tap(preview, "Konfirmasi");
  assert.deepEqual(h.writes, [[{ rowNumber: 2, column: "E", value: 20 }]]);
  assert.equal(h.stockOf("BRG0006"), 102);
  assert.equal(h.last.text, "✅ Stok berhasil diperbarui\n\n📦 Minyak Goreng 1L\n\n82 botol → 102 botol\nBarang masuk: +20 botol\n\nID transaksi: TRX-001");
  assert.deepEqual(h.history, [["TRX-001", "27/09/2026", "10:15", "MASUK", "BRG0006", "Minyak Goreng 1L", 20, "botol", 82, 102, "@kasir (7)", ""]]);
  assert.ok(h.cleared.includes(99), "the preview buttons are removed after confirming");
});

test("Barang Keluar: more than the stock is refused, then column F and history", async () => {
  const h = harness();
  const { quantityPrompt } = await startUpdate(h, "gula", null, "Barang Keluar");
  assert.match(quantityPrompt.text, /^📤 Barang Keluar\n\n📦 Gula Pasir 1kg\nSKU: BRG0010\nStok saat ini: 14 kg\n\nMasukkan jumlah barang yang keluar\./);
  await h.reply("15", quantityPrompt);
  assert.match(h.last.text, /^⚠️ Stok tidak mencukupi\n\nStok saat ini:\n14 kg\n\nJumlah barang keluar tidak boleh melebihi stok\./);
  await h.reply("abc", quantityPrompt);
  assert.match(h.last.text, /^⚠️ Jumlah tidak valid/);
  assert.equal(h.writes.length, 0);

  await h.reply("4", quantityPrompt);
  assert.equal(withoutSeal(h.last), [
    "📤 Konfirmasi Barang Keluar", "", "📦 Gula Pasir 1kg", "SKU: BRG0010", "",
    "Stok saat ini : 14 kg", "Barang keluar : -4 kg", "Stok setelah : 10 kg",
  ].join("\n"));
  await h.tap(h.last, "Konfirmasi");
  assert.deepEqual(h.writes, [[{ rowNumber: 4, column: "F", value: 4 }]]);
  assert.equal(h.last.text, "✅ Stok berhasil diperbarui\n\n📦 Gula Pasir 1kg\n\n14 kg → 10 kg\nBarang keluar: -4 kg\n\nID transaksi: TRX-001");
  assert.deepEqual(h.history[0].slice(3, 10), ["KELUAR", "BRG0010", "Gula Pasir 1kg", 4, "kg", 14, 10]);
});

test("Koreksi Stok is product-first too: search, pick, detail, target, adjustment in column G", async () => {
  const h = harness();
  // No shortcut: the correction starts from a search like the others.
  await h.say("koreksi stok");
  assert.match(h.last.text, /^📝 Update Stok\n\n🔎 Cari barang/);
  const { detail, quantityPrompt } = await startUpdate(h, "minyak goreng", "Minyak Goreng 1L", "Koreksi Stok");
  assert.match(detail.text, /Apa yang ingin dilakukan\?$/);
  assert.match(quantityPrompt.text, /^🔄 Koreksi Stok\n\n📦 Minyak Goreng 1L\nSKU: BRG0006\nStok saat ini: 82 botol\n\nMasukkan jumlah stok yang benar\.\nContoh:\n150/);
  await h.reply("82", quantityPrompt);
  assert.match(h.last.text, /^⚠️ Stok tidak berubah/);

  await h.reply("50", quantityPrompt);
  assert.equal(withoutSeal(h.last), [
    "🔄 Konfirmasi Koreksi Stok", "", "📦 Minyak Goreng 1L", "SKU: BRG0006", "",
    "Stok saat ini : 82 botol", "Stok baru     : 50 botol", "Penyesuaian   : -32 botol",
  ].join("\n"));
  await h.tap(h.last, "Konfirmasi");
  // Adjustment = target − current = 50 − 82.
  assert.deepEqual(h.writes, [[{ rowNumber: 2, column: "G", value: -32 }]]);
  assert.ok(h.writes.flat().every((cell) => cell.column !== ("H" as string)));
  assert.equal(h.stockOf("BRG0006"), 50);
  assert.equal(h.last.text, "✅ Stok berhasil dikoreksi\n\n📦 Minyak Goreng 1L\n\n82 botol → 50 botol\nPenyesuaian: -32 botol\n\nID transaksi: TRX-001");
  assert.deepEqual(h.history[0].slice(3, 12), ["KOREKSI", "BRG0006", "Minyak Goreng 1L", -32, "botol", 82, 50, "@kasir (7)", "Koreksi ke 50"]);
});

test("state: Batal on the quantity step and on the preview return to the product detail", async () => {
  const h = harness();
  const { detail, quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  const waiting = withKeyboard(detail, h.keyboards.at(-1)!.rows);
  await h.tap(waiting, "Batal");
  assert.match(h.last.text, /^📦 Gula Pasir 1kg[\s\S]*Apa yang ingin dilakukan\?$/);
  assert.ok(h.cleared.includes(99));

  await h.reply("batal", quantityPrompt);
  assert.match(h.last.text, /^📦 Gula Pasir 1kg[\s\S]*Apa yang ingin dilakukan\?$/);

  await h.reply("10", quantityPrompt);
  const preview = h.last;
  await h.tap(preview, "Batal");
  assert.match(h.last.text, /^📦 Gula Pasir 1kg[\s\S]*Apa yang ingin dilakukan\?$/);
  assert.equal(h.writes.length, 0);
  // The cancelled preview cannot be confirmed afterwards by a stale button: it re-checks stock,
  // but nothing was written, so the summary is still valid; buttons were removed instead.
  assert.ok(h.cleared.filter((id) => id === 99).length >= 2);
});

test("state: after confirming, the same preview cannot write again", async () => {
  const h = harness();
  const { quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  await h.reply("10", quantityPrompt);
  const preview = h.last;
  await h.tap(preview, "Konfirmasi");
  await h.tap(preview, "Konfirmasi");
  assert.equal(h.last.text, "✅ Update ini sudah tersimpan sebelumnya.\n\nTidak ada perubahan tambahan yang dilakukan.");
  assert.equal(h.writes.length, 1);
  assert.equal(h.history.length, 1);
});

test("state: user B cannot use user A's buttons, quantity prompt, or preview", async () => {
  const h = harness();
  const { detail, quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  await h.tap(detail, "Barang Keluar", 8);
  assert.match(h.last.text, /sudah tidak berlaku/);
  await h.reply("10", quantityPrompt, 8);
  assert.doesNotMatch(h.last.text, /Konfirmasi Barang Masuk/, "the other user's number is not read as a quantity");
  await h.reply("10", quantityPrompt);
  const preview = h.last;
  await h.tap(preview, "Konfirmasi", 8);
  assert.match(h.last.text, /^Ringkasan ini tidak dapat diproses/);
  assert.equal(h.writes.length, 0);
});

test("changed stock, expired prompts, and altered previews cannot be confirmed", async () => {
  const h = harness();
  const { quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  await h.reply("10", quantityPrompt);
  const preview = h.last;
  h.source[2].stokAkhir = 20;
  await h.tap(preview, "Konfirmasi");
  assert.match(h.last.text, /^⚠️ Update belum dilakukan\n\nStok berubah sejak ringkasan dibuat:/);

  const late = harness();
  const started = await startUpdate(late, "gula", null, "Barang Masuk");
  late.advance(31 * 60 * 1000);
  await late.reply("10", started.quantityPrompt);
  assert.match(late.last.text, /^⌛ /);

  const forged = harness();
  const flow = await startUpdate(forged, "gula", null, "Barang Masuk");
  await forged.reply("10", flow.quantityPrompt);
  const altered = { ...forged.last, text: forged.last.text.replace("Stok setelah : 24 kg", "Stok setelah : 2400 kg") };
  await handleTelegramUpdate(callback(altered, button(forged.last, "Konfirmasi")), forged.dependencies);
  assert.match(forged.last.text, /^Ringkasan ini tidak dapat diproses/);
  assert.equal(h.writes.length + late.writes.length + forged.writes.length, 0);
});

test("the footer Telegram sends back does not break sealed prompts and previews", async () => {
  const h = harness();
  const { quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  await h.reply("10", { text: `${quantityPrompt.text}\n\nFile stok XLS: Lihat File` });
  const preview = h.last;
  assert.match(preview.text, /^📥 Konfirmasi Barang Masuk/);
  await handleTelegramUpdate(callback({ ...preview, text: `${preview.text}\n\nFile stok XLS: Lihat File` }, button(preview, "Konfirmasi")), h.dependencies);
  assert.match(h.last.text, /^✅ Stok berhasil diperbarui/);
});

test("with writes disabled, confirmation stops before Google Sheets", async () => {
  assert.equal(isStockWriteEnabled({}), false);
  assert.equal(isStockWriteEnabled({ TELEGRAM_STOCK_WRITE_ENABLED: "true" }), true);
  const h = harness({ writeEnabled: false });
  const { quantityPrompt } = await startUpdate(h, "gula", null, "Barang Masuk");
  await h.reply("10", quantityPrompt);
  await h.tap(h.last, "Konfirmasi");
  assert.match(h.last.text, /^🔒 Penyimpanan belum diaktifkan/);
  assert.equal(h.writes.length + h.history.length, 0);
});

test("a failed commit changes neither stock nor history; unverified totals are reported", async () => {
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    const failing = harness({ failCommit: true });
    const { quantityPrompt } = await startUpdate(failing, "gula", null, "Barang Masuk");
    await failing.reply("10", quantityPrompt);
    await failing.tap(failing.last, "Konfirmasi");
    assert.equal(failing.last.text, "⚠️ Stok belum berhasil diperbarui. Silakan coba lagi.");
    assert.deepEqual(failing.source, rows);
    assert.equal(failing.history.length, 0);
    assert.doesNotMatch(JSON.stringify(failing.sent) + logged.join(), /private-sensitive/);

    const broken = harness({ formulaBroken: true });
    await broken.say("tambah stok gula 30");
    await broken.tap(broken.last, "Konfirmasi");
    assert.match(broken.last.text, /^⚠️ Perubahan sudah dikirim, tetapi perlu dicek[\s\S]*Gula Pasir 1kg: seharusnya 44 kg, terbaca 14 kg/);
    assert.equal(broken.history.length, 1, "the history was committed together with the cells");
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------- free-text stock commands (regression)

test("free text: single and multi item ADD with one atomic commit and one transaction ID", async () => {
  const h = harness();
  await h.say("tambah stok gula 30");
  assert.equal(withoutSeal(h.last), [
    "📥 Barang Masuk", "", "Berikut perubahan stok:", "", "• Gula Pasir 1kg · BRG0010", "  +30 kg", "  14 → 44", "", "Simpan perubahan?",
  ].join("\n"));
  await h.tap(h.last, "Konfirmasi");
  assert.equal(h.last.text, "✅ Stok berhasil diperbarui\n\n📦 Gula Pasir 1kg\n\n14 kg → 44 kg\nBarang masuk: +30 kg\n\nID transaksi: TRX-001");

  await h.say("barang masuk: minyak goreng 1l 20, beras 50");
  await h.tap(h.last, "Konfirmasi");
  assert.deepEqual(h.writes[1], [{ rowNumber: 2, column: "E", value: 20 }, { rowNumber: 5, column: "E", value: 50 }]);
  assert.match(h.last.text, /^✅ Stok berhasil diperbarui\n\n2 barang telah diperbarui:/);
  assert.deepEqual(h.history.slice(1).map((row) => [row[0], row[4]]), [["TRX-002", "BRG0006"], ["TRX-002", "BRG0020"]]);
});

test("free text: 'minyak masuk 20' and 'beras keluar 10' still work; SET writes column G", async () => {
  const h = harness();
  await h.say("minyak goreng 1l masuk 20");
  assert.match(h.last.text, /^📥 Barang Masuk\n\nBerikut perubahan stok:\n\n• Minyak Goreng 1L · BRG0006\n  \+20 botol/);
  await h.say("beras keluar 10");
  assert.match(h.last.text, /^📤 Barang Keluar\n\nBerikut perubahan stok:\n\n• Beras Premium 5kg · BRG0020\n  -10 karung/);
  await h.tap(h.last, "Konfirmasi");
  assert.deepEqual(h.writes[0], [{ rowNumber: 5, column: "F", value: 10 }]);
  await h.say("koreksi stok minyak goreng 1l jadi 50, gula jadi 18");
  await h.tap(h.last, "Konfirmasi");
  assert.deepEqual(h.writes[1], [{ rowNumber: 2, column: "G", value: -32 }, { rowNumber: 4, column: "G", value: 4 }]);
});

test("free text: validation before write and no partial write when one item fails", async () => {
  const h = harness();
  await h.say("tambah minyak goreng 1l 20, gula 30, barang xyz 10");
  assert.match(h.last.text, /^⚠️ Update belum dilakukan[\s\S]*✕ "barang xyz" — tidak ditemukan/);
  await h.say("tambah stok minyak");
  assert.match(h.last.text, /^⚠️ Jumlah tidak valid/);
  await h.say("keluar gula 15");
  assert.match(h.last.text, /stok tidak cukup \(tersedia 14 kg\)/);
  await h.say("tambah stok minyak 20, gula 30");
  assert.match(h.last.text, /^🔎 "minyak" bisa berarti:/);
  await h.tap(h.last, "Minyak Goreng 2L");
  assert.match(h.last.text, /• Minyak Goreng 2L · BRG0007\n  \+20 botol/);
  await h.say("barang masuk: gula 20, gula pasir 1kg 10");
  assert.match(h.last.text, /\+30 kg \(20 \+ 10\)/, "duplicates are merged");
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.source, rows);
});

test("free text: a loose 'ya' never writes; reply 'ya' or 'batal' to the summary does", async () => {
  const h = harness();
  await h.say("tambah stok gula 30");
  const summary = h.last;
  await h.say("ya");
  assert.match(h.last.text, /^Tidak ada yang perlu dikonfirmasi/);
  await h.reply("batal", summary);
  assert.equal(h.last.text, "❌ Update dibatalkan.\n\nTidak ada perubahan stok yang dilakukan.");
  assert.equal(h.writes.length, 0);
  await h.reply("ya", summary);
  assert.match(h.last.text, /^✅ Stok berhasil diperbarui/);
  assert.equal(h.writes.length, 1);
});

// ---------------------------------------------------------------- supplier directory

test("Hubungi Supplier lists suppliers; a supplier's detail offers WhatsApp only with a number", async () => {
  const h = harness();
  await h.say("📞 Hubungi Supplier");
  const list = h.last;
  assert.equal(list.text, "📞 Hubungi Supplier\n\nPilih supplier:");
  assert.deepEqual(buttons(list).map((b) => b.text), ["🏢 PT Sumber Makmur", "🏢 CV Berkah Jaya", "⬅️ Kembali"]);

  await h.tap(list, "PT Sumber Makmur");
  assert.equal(h.last.text, "🏢 PT Sumber Makmur\n\nKota: Malang\nKontak: 083472087316\nKeterangan: Supplier aktif");
  assert.deepEqual(links(h.last), [{ text: "💬 Hubungi via WhatsApp", url: "https://wa.me/6283472087316" }]);
  await h.tap(h.last, "Kembali");
  assert.equal(h.last.text, list.text);

  await h.tap(list, "CV Berkah Jaya");
  assert.equal(h.last.text, "🏢 CV Berkah Jaya\n\nKota: Malang\nKontak: -\nKeterangan: Supplier aktif\n\nKontak WhatsApp belum tersedia.");
  assert.deepEqual(links(h.last), []);
});

test("no ordering flow remains: order phrases open the supplier directory and never touch stock", async () => {
  const h = harness();
  for (const input of ["🛒 Buat Pesanan", "butuh minyak goreng 20", "pesan gula 30"]) {
    await h.say(input);
    assert.equal(h.last.text, "📞 Hubungi Supplier\n\nPilih supplier:", input);
  }
  assert.doesNotMatch(h.sent.map((reply) => reply.text).join("\n"), /Pesan Barang|Kebutuhan Barang/);
  assert.equal(h.writes.length + h.history.length, 0);
  assert.deepEqual(h.source, rows);
});

// ---------------------------------------------------------------- report

test("Laporan: progress, ready, and exactly one PDF for the running month", async () => {
  const h = harness();
  await h.say("tambah stok gula 30");
  await h.tap(h.last, "Konfirmasi");
  const start = h.sent.length;
  await h.say("📊 Laporan");
  assert.deepEqual(h.sent.slice(start).map((reply) => reply.text), [
    "📊 Sedang menyiapkan laporan bulan ini...",
    "✅ Laporan bulan ini sudah selesai.",
  ]);
  assert.equal(h.documents.length, 1);
  assert.equal(h.documents[0].filename, "laporan-stok-transaksi-2026-09.pdf");
  assert.equal(h.documents[0].mimeType, "application/pdf");
  assert.equal(h.documents[0].caption, "Laporan Stok & Transaksi — 1 September 2026 – 30 September 2026");
  assert.equal(Buffer.from(h.documents[0].bytes.subarray(0, 5)).toString(), "%PDF-");
});

test("Laporan without transactions still sends one PDF with a note; failures send no PDF", async () => {
  const h = harness();
  await h.say("laporan");
  assert.equal(h.sent[1].text, "✅ Laporan bulan ini sudah selesai.\n\nℹ️ Belum ada transaksi yang tercatat bulan ini.\nLaporan tetap dibuat berdasarkan kondisi stok yang tersedia.");
  assert.equal(h.documents.length, 1);

  const originalError = console.error;
  console.error = () => {};
  try {
    const failing = harness();
    failing.dependencies.report = { readTransactions: async () => { throw new Error("private-sensitive-sentinel"); } };
    await failing.say("📊 Laporan");
    assert.equal(failing.last.text, "Maaf, laporan belum dapat dibuat saat ini.\nSilakan coba beberapa saat lagi.");
    assert.equal(failing.documents.length, 0);
    assert.doesNotMatch(JSON.stringify(failing.sent), /private-sensitive/);
  } finally {
    console.error = originalError;
  }
});

// ---------------------------------------------------------------- safety and transport

test("cancel, confirm without context, unknown text, and non-text messages get plain answers", async () => {
  const h = harness();
  await h.say("batal");
  assert.equal(h.last.text, "👌 Oke, dibatalkan.\n\nSilakan pilih menu atau ketik nama barang.");
  await h.say("apa kabar");
  assert.match(h.last.text, /^🤔 Maaf, saya belum paham maksudnya\./);
  await handleTelegramUpdate({ update_id: 2, message: { chat: { id: 42 }, photo: [] } }, h.dependencies);
  assert.match(h.last.text, /hanya bisa membaca pesan teks/);
  await handleTelegramUpdate({ update_id: 3, callback_query: { id: "old", data: "invalid", message: { chat: { id: 42 } } } }, h.dependencies);
  assert.match(h.last.text, /sudah tidak berlaku/);
  // Buttons from the retired order confirmation are no longer honored.
  await handleTelegramUpdate({ update_id: 4, callback_query: { id: "old", data: `order:0:${"a".repeat(22)}`, message: { chat: { id: 42 } } } }, h.dependencies);
  assert.match(h.last.text, /sudah tidak berlaku/);
  await handleTelegramUpdate({ update_id: 1 }, h.dependencies);
  assert.equal(h.sent.length, 5);
  assert.equal(h.reads, 0);
});

test("no reply exposes internal terms across every flow", async () => {
  const h = harness();
  for (const input of ["/start", "cek stok", "stok minyak", "minyak goreng", "cari gula", "stok xyz", "stok menipis", "bantuan", "📝 Update Stok",
    "📞 Hubungi Supplier", "lihat supplier", "butuh gula 3", "tambah stok gula 5", "batal", "ya", "halo", "📊 Laporan"]) {
    await h.say(input);
  }
  for (const reply of h.sent) {
    assert.doesNotMatch(reply.text, TECHNICAL, reply.text);
    assert.doesNotMatch(reply.text, RAW_VALUE, reply.text);
  }
});

test("inventory failures show a human message and keep technical details out of Telegram", async () => {
  const h = harness();
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    const failing = { ...h.dependencies, execute: async () => { throw new Error("private-sensitive-sentinel"); } };
    await handleTelegramUpdate(message("stok minyak"), failing);
    await handleTelegramUpdate(message("cari gula"), failing);
  } finally {
    console.error = originalError;
  }
  assert.equal(h.sent[0].text, "😔 Maaf, saya sedang mengalami kendala saat mengambil data stok. Silakan coba lagi.");
  assert.equal(h.sent[1].text, h.sent[0].text);
  assert.doesNotMatch(JSON.stringify(h.sent) + logged.join(), /private-sensitive/);
});

test("webhook authenticates before handling, validates JSON, and sanitizes errors", async () => {
  let count = 0;
  const handler = createWebhookHandler({ secret: () => secret, handle: async () => { count++; } });
  const request = (body: string, auth = secret) => new Request("http://localhost/api/telegram/webhook", { method: "POST", headers: { "x-telegram-bot-api-secret-token": auth }, body });
  assert.equal((await handler(request('{"update_id":1}', "wrong"))).status, 401);
  assert.equal(count, 0);
  assert.equal((await handler(request("not json"))).status, 400);
  assert.equal((await handler(request("{}"))).status, 400);
  assert.equal((await handler(request("x".repeat(131073)))).status, 413);
  const ok = await handler(request('{"update_id":1}'));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(count, 1);
  const failed = createWebhookHandler({ secret: () => secret, handle: async () => { throw new Error("private-sensitive-sentinel"); } });
  const response = await failed(request('{"update_id":2}'));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-sensitive/);
});

test("Telegram transport: JSON messages, multipart documents, and no token-bearing errors", async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  // A unit-test sentinel, never submitted to the real Telegram API.
  process.env.TELEGRAM_BOT_TOKEN = "private-sensitive-sentinel";
  try {
    const requests: { url: string; body: unknown }[] = [];
    const bot = createTelegramBot(async (url, options) => { requests.push({ url: String(url), body: options?.body }); return Response.json({ ok: true }); });
    await bot.sendMessage(42, productDetailReply({ ...oil1, name: "Minyak <b>Goreng</b> & Co" }));
    await bot.sendDocument(42, { filename: "laporan-stok-transaksi-2026-09.pdf", bytes: new Uint8Array([37, 80, 68, 70]), mimeType: "application/pdf", caption: "Laporan" }, 5);
    await bot.answerCallbackQuery("test-id");
    await bot.setInlineKeyboard!(42, 99, []);
    const message = JSON.parse(String(requests[0].body));
    assert.equal(message.chat_id, 42);
    assert.equal(message.parse_mode, "HTML");
    // Sheet content is escaped, and the footer is appended exactly once at the very end.
    assert.match(message.text, /^📦 Minyak &lt;b&gt;Goreng&lt;\/b&gt; &amp; Co\n/);
    assert.ok(message.text.endsWith('\n\n<i>File stok XLS: <a href="https://tinyurl.com/faststock">Lihat File</a></i>'));
    assert.equal((message.text.match(/Lihat File/g) ?? []).length, 1);
    assert.doesNotMatch(message.text.replace(/href="[^"]+"/, ""), /tinyurl/, "the URL is not shown as text");
    assert.ok(requests[1].url.endsWith("/sendDocument"));
    const form = requests[1].body as FormData;
    assert.equal(form.get("chat_id"), "42");
    assert.equal(form.get("message_thread_id"), "5");
    assert.equal(form.get("parse_mode"), "HTML");
    assert.match(String(form.get("caption")), /^Laporan\n\n<i>File stok XLS: /);
    assert.equal((form.get("document") as File).name, "laporan-stok-transaksi-2026-09.pdf");
    assert.equal(JSON.parse(String(requests[2].body)).callback_query_id, "test-id");
    assert.deepEqual(JSON.parse(String(requests[3].body)), { chat_id: 42, message_id: 99, reply_markup: { inline_keyboard: [] } });
    const failed = createTelegramBot(async () => { throw new Error("https://api.telegram.org/botprivate-sensitive-sentinel/sendMessage"); });
    await assert.rejects(failed.sendMessage(42, productDetailReply(oil1)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private-sensitive/);
      assert.equal(error.cause, undefined);
      return true;
    });
    const rejected = createTelegramBot(async () => Response.json({ ok: false, description: "private-sensitive-sentinel" }));
    await assert.rejects(rejected.sendMessage(42, productDetailReply(oil1)), /Pengiriman respons Telegram gagal/);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});
