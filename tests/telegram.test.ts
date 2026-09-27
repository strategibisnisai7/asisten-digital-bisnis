import assert from "node:assert/strict";
import { test } from "node:test";
import { executeInventoryIntent } from "../lib/inventory/inventory-engine";
import type { InventoryProduct } from "../lib/inventory/inventory-engine";
import type { StokItem } from "../lib/google-sheets/stok";
import { parseRuleIntent } from "../lib/parser/rule-parser";
import { handleTelegramUpdate } from "../lib/telegram/adapter";
import { createTelegramBot } from "../lib/telegram/bot-service";
import { callbackData, readCallback } from "../lib/telegram/callbacks";
import { formatInventoryResult, formatProduct, MAIN_MENU, PAGE_SIZE } from "../lib/telegram/formatting";
import { createWebhookHandler } from "../lib/telegram/webhook";
import { parseTelegramEvent } from "../lib/telegram/types";
import type { InlineButton, TelegramReply } from "../lib/telegram/types";

const secret = "unit-test-secret-only-not-a-bot-token";
const product: InventoryProduct = { sku: "SKU-1", name: "Minyak Goreng", unit: "liter", currentStock: 5, minimumStock: 5, status: "Menipis", rack: "A1", supplier: "Supplier A" };
const rows: StokItem[] = [product, { ...product, sku: "SKU-10", name: "Minyak Goreng B", currentStock: 20 }].map((p, i) => ({
  rowNumber: i + 2, sku: p.sku, namaBarang: p.name, satuan: p.unit, stokAwal: p.currentStock,
  barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: p.currentStock,
  stokMinimum: p.minimumStock, statusStok: p.status, lokasiRak: p.rack, supplierUtama: p.supplier,
}));
const message = (text: string) => ({ update_id: 1, message: { chat: { id: 42 }, text } });
function buttons(reply: TelegramReply): InlineButton[] {
  assert.ok(reply.reply_markup && "inline_keyboard" in reply.reply_markup);
  return reply.reply_markup.inline_keyboard.flat();
}
function callback(reply: TelegramReply, button: InlineButton, chatId = 42) {
  return { update_id: 2, callback_query: { id: "query-id", data: button.callback_data, message: { chat: { id: chatId }, text: reply.text, reply_markup: reply.reply_markup } } };
}
function harness() {
  const sent: TelegramReply[] = [];
  const parsed: string[] = [];
  const intents: string[] = [];
  const source = structuredClone(rows);
  const acknowledgments: string[] = [];
  let reads = 0;
  return {
    sent, parsed, intents, source, acknowledgments,
    get reads() { return reads; },
    dependencies: {
      secret,
      bot: { async sendMessage(_id: number, reply: TelegramReply) { sent.push(reply); }, async answerCallbackQuery(id: string) { acknowledgments.push(id); } },
      parse(text: string) { parsed.push(text); return parseRuleIntent(text); },
      execute: (async (intent) => { intents.push(intent.intent); return executeInventoryIntent(intent, async () => { reads++; return source; }); }) as typeof executeInventoryIntent,
    },
  };
}

test("Telegram menu text and /start are parsed into existing intent types", () => {
  for (const [text, intent] of [["🔍 Cek Stok", "CHECK_STOCK"], ["⚠️ Stok Menipis", "LOW_STOCK"], ["📋 Cari Barang", "SEARCH_PRODUCT"], ["❓ Bantuan", "HELP"], ["/start", "HELP"], ["/help@stok_bot", "HELP"]]) {
    assert.equal(parseRuleIntent(text).intent, intent);
  }
  assert.equal(MAIN_MENU.keyboard.flat().length, 4);
});

test("product formatting includes all fields as plain text and respects message limits", () => {
  const reply = formatProduct(product);
  for (const expected of ["📦 Minyak Goreng", "SKU: SKU-1", "Stok: 5", "Satuan: liter", "Stok Minimum: 5", "Status: Menipis", "Lokasi Rak: A1", "Supplier: Supplier A"]) assert.ok(reply.text.includes(expected));
  assert.equal("parse_mode" in reply, false);
  assert.ok(formatProduct({ ...product, name: "🔥<b>".repeat(5000), supplier: "x".repeat(10000) }).text.length < 4096);
  assert.match(formatProduct({ ...product, minimumStock: null }).text, /Belum ditentukan/);
});

test("candidate and low-stock lists paginate with bounded text and callback bytes", () => {
  const products = Array.from({ length: 25 }, (_, i) => ({ ...product, sku: `SKU-${i}-${"超".repeat(80)}`, name: "Minyak ".repeat(80) }));
  for (const intent of ["SEARCH_PRODUCT", "LOW_STOCK"] as const) {
    const reply = formatInventoryResult({ intent, status: "SUCCESS", products }, { chatId: 42, secret, query: "x".repeat(500) });
    assert.ok(reply.text.length <= 4096);
    assert.match(reply.text, /Halaman 1\/4/);
    assert.equal(buttons(reply).length, PAGE_SIZE + 1);
    assert.ok(buttons(reply).every((button) => Buffer.byteLength(button.callback_data) <= 64));
    const page2 = formatInventoryResult({ intent, status: "SUCCESS", products }, { chatId: 42, secret, query: "minyak", page: 1 });
    assert.match(page2.text, /Halaman 2\/4/);
    assert.ok(buttons(page2).some((button) => button.text.includes("Sebelumnya")));
  }
});

test("not found and empty low-stock formatting are explicit", () => {
  const context = { chatId: 42, secret, query: "none" };
  assert.equal(formatInventoryResult({ intent: "SEARCH_PRODUCT", status: "NOT_FOUND", message: "ignored" }, context).text, "Produk tidak ditemukan.");
  assert.match(formatInventoryResult({ intent: "LOW_STOCK", status: "SUCCESS", products: [] }, context).text, /Tidak ada barang/);
});

test("every text goes through parser and engine, including HELP and menu prompts", async () => {
  const h = harness();
  const inputs = ["stok minyak goreng", "minyak goreng", "barang apa yang hampir habis", "bantuan", "🔍 Cek Stok", "📋 Cari Barang", "⚠️ Stok Menipis", "❓ Bantuan"];
  for (const input of inputs) await handleTelegramUpdate(message(input), h.dependencies);
  assert.deepEqual(h.parsed, inputs);
  assert.deepEqual(h.intents, ["CHECK_STOCK", "SEARCH_PRODUCT", "LOW_STOCK", "HELP", "CHECK_STOCK", "SEARCH_PRODUCT", "LOW_STOCK", "HELP"]);
  assert.equal(h.sent.length, inputs.length);
  assert.match(h.sent[4].text, /Ketik nama barang atau SKU/);
  assert.match(h.sent[5].text, /Ketik nama barang atau SKU/);
  assert.match(h.sent[3].text, /Contoh:/);
  assert.equal(h.reads, 4);
});

test("single result shows details; missing results show exact not-found response", async () => {
  const h = harness();
  await handleTelegramUpdate(message("cari sku-10"), h.dependencies);
  assert.match(h.sent[0].text, /SKU: SKU-10/);
  await handleTelegramUpdate(message("stok unknown-item"), h.dependencies);
  assert.equal(h.sent[1].text, "Produk tidak ditemukan.");
});

test("selection re-reads exact SKU through engine even when it prefixes another SKU", async () => {
  const h = harness();
  await handleTelegramUpdate(message("minyak goreng"), h.dependencies);
  const first = h.sent[0];
  h.source[0].stokAkhir = 99;
  await handleTelegramUpdate(callback(first, buttons(first)[0]), h.dependencies);
  assert.deepEqual(h.acknowledgments, ["query-id"]);
  assert.match(h.sent[1].text, /SKU: SKU-1\n/);
  assert.match(h.sent[1].text, /Stok: 99\n/);
  assert.equal(h.reads, 2);
});

test("signed callbacks survive fresh instances and reject altered labels or different chats", () => {
  const reply = formatInventoryResult({ intent: "SEARCH_PRODUCT", status: "SUCCESS", products: [product, { ...product, sku: "two" }] }, { chatId: 42, secret, query: "minyak" });
  const event = parseTelegramEvent(callback(reply, buttons(reply)[0]));
  assert.ok(event?.kind === "callback");
  assert.deepEqual(readCallback(event, secret), { kind: "pick", value: product.sku, page: 0 });
  assert.equal(readCallback({ ...event, chatId: 43 }, secret), null);
  assert.equal(readCallback({ ...event, buttons: [{ ...event.buttons[0], text: "different-sku" }] }, secret), null);
  assert.equal(readCallback(event, "changed-secret"), null);
});

test("pagination callbacks verify query integrity and request fresh engine results", async () => {
  const h = harness();
  h.source.push(...Array.from({ length: 12 }, (_, i) => ({ ...rows[0], sku: `NEW-${i}` })));
  await handleTelegramUpdate(message("minyak"), h.dependencies);
  const reply = h.sent[0];
  const next = buttons(reply).find((button) => button.text.includes("Berikutnya"))!;
  await handleTelegramUpdate(callback(reply, next), h.dependencies);
  assert.match(h.sent[1].text, /Halaman 2\/2/);
  const event = parseTelegramEvent(callback(reply, next));
  assert.ok(event?.kind === "callback");
  assert.equal(readCallback({ ...event, text: event.text.replace("Pencarian: minyak", "Pencarian: rahasia") }, secret), null);
  assert.equal(h.reads, 2);
});

test("low-stock next page works without maintaining a session", async () => {
  const h = harness();
  h.source.push(...Array.from({ length: 12 }, (_, i) => ({ ...rows[0], sku: `LOW-${i}` })));
  await handleTelegramUpdate(message("stok menipis"), h.dependencies);
  const reply = h.sent[0];
  await handleTelegramUpdate(callback(reply, buttons(reply).find((b) => b.text.includes("Berikutnya"))!), h.dependencies);
  assert.match(h.sent[1].text, /Halaman 2\/2/);
  assert.deepEqual(h.intents, ["LOW_STOCK", "LOW_STOCK"]);
});

test("write/order intents are not executed; control and unknown messages are helpful", async () => {
  const h = harness();
  for (const input of ["tambah stok minyak 20", "kurangi stok minyak 5", "set stok minyak 50", "buat pesanan", "batal", "ya", "apa kabar"]) await handleTelegramUpdate(message(input), h.dependencies);
  assert.equal(h.reads, 0);
  assert.ok(h.sent.slice(0, 4).every((reply) => reply.text.includes("belum tersedia")));
});

test("unknown callback and non-text message are safe; unrelated updates are ignored", async () => {
  const h = harness();
  await handleTelegramUpdate({ update_id: 1 }, h.dependencies);
  await handleTelegramUpdate({ update_id: 2, message: { chat: { id: 42 }, photo: [] } }, h.dependencies);
  await handleTelegramUpdate({ update_id: 3, callback_query: { id: "old", data: "invalid", message: { chat: { id: 42 } } } }, h.dependencies);
  assert.equal(h.sent.length, 2);
  assert.equal(h.reads, 0);
});

test("upstream inventory errors are not exposed to Telegram users", async () => {
  const h = harness();
  await handleTelegramUpdate(message("stok minyak"), { ...h.dependencies, execute: async () => { throw new Error("private-sensitive-sentinel"); } });
  assert.match(h.sent[0].text, /belum bisa dibaca/);
  assert.doesNotMatch(JSON.stringify(h.sent), /private-sensitive/);
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

test("Telegram transport awaits API success, omits parse_mode, and drops raw token-bearing errors", async () => {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  // A unit-test sentinel, never submitted to the real Telegram API.
  process.env.TELEGRAM_BOT_TOKEN = "private-sensitive-sentinel";
  try {
    const requests: Record<string, unknown>[] = [];
    const bot = createTelegramBot(async (_url, options) => { requests.push(JSON.parse(String(options?.body))); return Response.json({ ok: true }); });
    await bot.sendMessage(42, formatProduct(product));
    await bot.answerCallbackQuery("test-id");
    assert.equal(requests[0].chat_id, 42);
    assert.equal("parse_mode" in requests[0], false);
    assert.equal(requests[1].callback_query_id, "test-id");
    const failed = createTelegramBot(async () => { throw new Error("https://api.telegram.org/botprivate-sensitive-sentinel/sendMessage"); });
    await assert.rejects(failed.sendMessage(42, formatProduct(product)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(String(error) + JSON.stringify(error), /private-sensitive/);
      assert.equal(error.cause, undefined);
      return true;
    });
    const rejected = createTelegramBot(async () => Response.json({ ok: false, description: "private-sensitive-sentinel" }));
    await assert.rejects(rejected.sendMessage(42, formatProduct(product)), /Pengiriman respons Telegram gagal/);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  }
});

test("callback payload size stays fixed for long unicode SKU strings", () => {
  assert.ok(Buffer.byteLength(callbackData({ kind: "pick", value: "超".repeat(1000), page: 0 }, 42, secret)) <= 64);
});
