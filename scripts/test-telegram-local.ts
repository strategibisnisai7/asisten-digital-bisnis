import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { POST } from "../app/api/telegram/webhook/route";
import { readStok } from "../lib/google-sheets/service";
import { handleTelegramUpdate } from "../lib/telegram/adapter";
import { getTelegramToken, getWebhookSecret } from "../lib/telegram/config";
import { createWebhookHandler } from "../lib/telegram/webhook";
import type { TelegramReply } from "../lib/telegram/types";

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
  const bot = { async sendMessage(_chatId: number, reply: TelegramReply) { sent.push(reply); }, async answerCallbackQuery() {} };
  const handler = createWebhookHandler({ secret: () => secret, handle: (update, verifiedSecret) => handleTelegramUpdate(update, { bot, secret: verifiedSecret }) });
  const source = await readStok();
  assert.ok(source.length);

  for (const text of ["/start", "stok minyak goreng", "minyak goreng", "barang apa yang hampir habis", "bantuan", "🔍 Cek Stok", "📋 Cari Barang"]) {
    const response = await handler(request({ update_id: 10 + sent.length, message: { chat: { id: 42 }, text } }));
    assert.equal(response.status, 200);
  }
  assert.equal(sent.length, 7);
  assert.ok(sent.every((reply) => reply.text.length > 0 && reply.text.length <= 4096));
  assert.match(sent[0].text, /Contoh:/);
  assert.match(sent[3].text, /Stok Menipis|Tidak ada barang/);

  // Use a real SKU signed by the presentation layer to test fresh detail selection.
  const { callbackData } = await import("../lib/telegram/callbacks");
  const sku = source[0].sku;
  const data = callbackData({ kind: "pick", value: sku, page: 0 }, 42, secret);
  const selected = await handler(request({ update_id: 20, callback_query: { id: "local-test", data, message: { chat: { id: 42 }, text: "Pilihan produk", reply_markup: { inline_keyboard: [[{ text: sku, callback_data: data }]] } } } }));
  assert.equal(selected.status, 200);
  assert.match(sent.at(-1)!.text, /📦/);
  assert.match(sent.at(-1)!.text, /Stok Minimum:/);
  console.log(`PASS: webhook auth, 7 alur teks, dan callback SKU; sumber ${source.length} barang dari Sheets.`);
  console.log("Respons Telegram ditangkap oleh test. Tidak ada pesan Telegram dikirim, data diubah, atau webhook didaftarkan.");
}

main().catch(() => {
  console.error("Test Telegram lokal gagal. Periksa konfigurasi dan koneksi Sheets; detail sensitif tidak ditampilkan.");
  process.exitCode = 1;
});
