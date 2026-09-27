import assert from "node:assert/strict";
import { test } from "node:test";
import { createLowStockCronHandler } from "../app/api/cron/low-stock/route";
import type { StokItem } from "../lib/google-sheets/stok";
import { runLowStockNotifications } from "../lib/notifications/low-stock-notification";
import { parseNotificationRows, type NotificationPreference, type NotificationStore } from "../lib/notifications/notification-store";
import type { TelegramReply } from "../lib/telegram/types";

const item = (stock: number): StokItem => ({
  rowNumber: 2, sku: "SKU-1", namaBarang: "Gula", satuan: "kg", stokAwal: stock,
  barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: stock, stokMinimum: 10,
  statusStok: stock <= 10 ? "Menipis" : "Aman", lokasiRak: "A1", supplierUtama: "Supplier A",
});

function memoryStore(enabled = true) {
  let preference: NotificationPreference = {
    rowNumber: 2, chatId: 42, userId: 7, enabled, lowSkus: [], updatedAt: "",
  };
  const store: NotificationStore = {
    async ensure() {},
    async list() { return [structuredClone(preference)]; },
    async setPreference(input) {
      preference = { ...preference, ...input, updatedAt: (input.at ?? new Date()).toISOString() };
      return structuredClone(preference);
    },
    async saveLowStockStates(states) {
      const state = states.find((entry) => entry.rowNumber === preference.rowNumber);
      if (state) preference = { ...preference, lowSkus: [...state.lowSkus], updatedAt: (state.at ?? new Date()).toISOString() };
    },
  };
  return { store, preference: () => preference };
}

test("notification rows parse preferences and isolate malformed snapshots", () => {
  const rows = parseNotificationRows([
    ["Chat ID", "User ID", "Aktif", "Thread ID", "SKU Menipis Terakhir", "Diperbarui"],
    ["42", "7", "TRUE", "99", '["B","A","A"]', "2026-09-27T00:00:00.000Z"],
    ["43", "8", "FALSE", "", "not-json", ""],
  ]);
  assert.deepEqual(rows[0].lowSkus, ["A", "B"]);
  assert.equal(rows[0].threadId, 99);
  assert.equal(rows[1].enabled, false);
  assert.deepEqual(rows[1].lowSkus, []);
});

test("low-stock notifications deduplicate unchanged conditions and notify again after recovery", async () => {
  const memory = memoryStore();
  const sent: TelegramReply[] = [];
  let stock = 10;
  const run = () => runLowStockNotifications({
    store: memory.store,
    readStock: async () => [item(stock)],
    send: async (_chatId, reply) => { sent.push(reply); },
    now: new Date("2026-09-27T01:00:00.000Z"),
  });

  assert.deepEqual(await run(), { subscriptions: 1, notified: 1, recovered: 0, failed: 0 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Gula[\s\S]*10 kg \/ minimum 10 kg/);
  assert.deepEqual((sent[0].reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((row) => row[0].text), [
    "⚠️ Lihat Stok Menipis", "🛒 Rekomendasi Restock",
  ]);
  assert.deepEqual(memory.preference().lowSkus, ["SKU-1"]);

  await run();
  assert.equal(sent.length, 1, "the same low condition is not sent twice");

  stock = 11;
  assert.equal((await run()).recovered, 1);
  assert.deepEqual(memory.preference().lowSkus, []);
  stock = 10;
  await run();
  assert.equal(sent.length, 2, "a recovered item can trigger again when it becomes low");
});

test("disabled users are never notified", async () => {
  const memory = memoryStore(false);
  let calls = 0;
  const result = await runLowStockNotifications({
    store: memory.store, readStock: async () => [item(0)], send: async () => { calls++; },
  });
  assert.deepEqual(result, { subscriptions: 0, notified: 0, recovered: 0, failed: 0 });
  assert.equal(calls, 0);
});

test("cron endpoint requires its bearer secret and returns only summary counts", async () => {
  let runs = 0;
  const handler = createLowStockCronHandler({
    secret: () => "cron-test-secret-1234",
    run: async () => { runs++; return { subscriptions: 1, notified: 1, recovered: 0, failed: 0 }; },
  });
  assert.equal((await handler(new Request("https://example.test/api/cron/low-stock"))).status, 401);
  const response = await handler(new Request("https://example.test/api/cron/low-stock", { headers: { authorization: "Bearer cron-test-secret-1234" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, subscriptions: 1, notified: 1, recovered: 0, failed: 0 });
  assert.equal(runs, 1);
});
