import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { POST } from "../app/api/telegram/webhook/route";
import { readStok } from "../lib/google-sheets/service";
import { handleTelegramUpdate } from "../lib/telegram/adapter";
import { getTelegramToken, getWebhookSecret } from "../lib/telegram/config";
import { createWebhookHandler } from "../lib/telegram/webhook";
import type { TelegramDocument, TelegramReply } from "../lib/telegram/types";

async function main() {
  loadEnvConfig(process.cwd(), true);
  getTelegramToken();
  const secret = getWebhookSecret();
  const request = (update: object, authenticated = true) => new Request("http://localhost:3000/api/telegram/webhook", {
    method: "POST", headers: authenticated ? { "x-telegram-bot-api-secret-token": secret } : {}, body: JSON.stringify(update),
  });

  // Actual route, with no message: verifies auth/HTTP response without sending anything.
  assert.equal((await POST(request({ update_id: 1 }, false))).status, 401);
  assert.equal((await POST(request({ update_id: 2 }))).status, 200);

  const sent: TelegramReply[] = [];
  const documents: TelegramDocument[] = [];
  const bot = {
    async sendMessage(_chatId: number, reply: TelegramReply) { sent.push(reply); },
    // The report PDF is captured here and never sent to Telegram.
    async sendDocument(_chatId: number, document: TelegramDocument) { documents.push(document); },
    async answerCallbackQuery() {},
  };
  // Stock updates stop at the summary: writing is disabled and any commit attempt fails the test.
  const stock = {
    writeEnabled: false,
    transactions: {
      async readTransactionIds(): Promise<string[]> { throw new Error("Test lokal tidak boleh menulis ke Google Sheets."); },
      async commit(): Promise<void> { throw new Error("Test lokal tidak boleh menulis ke Google Sheets."); },
    },
  };
  const handler = createWebhookHandler({ secret: () => secret, handle: (update, verifiedSecret) => handleTelegramUpdate(update, { bot, secret: verifiedSecret, stock }) });
  const source = await readStok();
  assert.ok(source.length);

  const flows: [string, RegExp][] = [
    ["/start", /^👋 Halo! Saya Asisten Digital /],
    ["cek stok", /^🔍 Cek Stok/],
    ["stok minyak goreng", /^🔎|^📦/],
    ["minyak goreng", /^🔎|^📦/],
    ["barang apa yang hampir habis", /Stok Menipis|Semua stok aman/],
    ["bantuan", /^❓ Bantuan/],
    ["📋 Cari Barang", /^📋 Cari Barang/],
    ["📝 Update Stok", /^📝 Update Stok\n\n🔎 Cari barang yang ingin diperbarui\./],
    // Summary built from real stock; nothing is confirmed or written.
    [`tambah stok ${source[0].sku} 1`, new RegExp(`^📥 Barang Masuk\\n\\nBerikut perubahan stok:\\n\\n• .+ · ${source[0].sku}\\n`)],
    ["📞 Hubungi Supplier", /^📞 Hubungi Supplier\n\nPilih supplier:/],
    ["lihat supplier", /^📞 Hubungi Supplier\n\nPilih supplier:/],
  ];
  for (const [text, expected] of flows) {
    const before = sent.length;
    const response = await handler(request({ update_id: 10 + sent.length, message: { chat: { id: 42 }, text } }));
    assert.equal(response.status, 200);
    assert.equal(sent.length, before + 1, text);
    assert.match(sent.at(-1)!.text, expected, text);
  }
  assert.ok(sent.every((reply) => reply.text.length > 0 && reply.text.length <= 4096));
  assert.doesNotMatch(sent.map((reply) => reply.text).join("\n"), /Buat Pesanan/);

  // Product-first Update Stok on real data up to the quantity prompt; nothing is written.
  const searchPrompt = sent.find((reply) => reply.text.startsWith("📝 Update Stok"))!;
  await handler(request({ update_id: 80, message: { chat: { id: 42 }, from: { id: 42 }, text: source[0].sku, reply_to_message: { text: searchPrompt.text, from: { id: 1, is_bot: true } } } }));
  assert.match(sent.at(-1)!.text, /Apa yang ingin dilakukan\?$/);

  // Report from real Stok and Riwayat Transaksi: progress, ready, and exactly one PDF.
  const reportStart = sent.length;
  assert.equal((await handler(request({ update_id: 90, message: { chat: { id: 42 }, text: "📊 Laporan" } }))).status, 200);
  assert.match(sent[reportStart].text, /^📊 Sedang menyiapkan laporan bulan ini/);
  assert.match(sent[reportStart + 1].text, /^✅ Laporan bulan ini sudah selesai\./);
  assert.equal(documents.length, 1);
  assert.match(documents[0].filename, /^laporan-stok-transaksi-\d{4}-\d{2}\.pdf$/);
  assert.equal(Buffer.from(documents[0].bytes.subarray(0, 5)).toString(), "%PDF-");

  // Use a real SKU signed by the presentation layer to test fresh detail selection.
  const { productButton } = await import("../lib/telegram/callbacks");
  const button = productButton(`📦 ${source[0].namaBarang}`, source[0].sku, 42, secret);
  const selected = await handler(request({ update_id: 20, callback_query: { id: "local-test", data: button.callback_data, message: { chat: { id: 42 }, text: "Pilihan produk", reply_markup: { inline_keyboard: [[button]] } } } }));
  assert.equal(selected.status, 200);
  assert.match(sent.at(-1)!.text, /^📦 /);
  assert.ok(sent.at(-1)!.text.includes("\nStok saat ini\n"));
  assert.ok(sent.at(-1)!.text.includes(`\nSKU\n${source[0].sku}`));
  console.log(`PASS: webhook auth, ${flows.length} alur teks, pilihan produk, dan laporan PDF (${documents[0].bytes.byteLength} byte); sumber ${source.length} barang dari Sheets.`);
  console.log("Respons Telegram ditangkap oleh test. Tidak ada pesan Telegram dikirim, stok diubah, atau webhook didaftarkan; tab preferensi notifikasi dapat dibuat bila belum ada.");
}

main().catch(() => {
  console.error("Test Telegram lokal gagal. Periksa konfigurasi dan koneksi Sheets; detail sensitif tidak ditampilkan.");
  process.exitCode = 1;
});
