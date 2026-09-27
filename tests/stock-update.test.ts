import assert from "node:assert/strict";
import { test } from "node:test";
import { stokCellUpdate, type StokCellWrite } from "../lib/google-sheets/service";
import type { StokItem } from "../lib/google-sheets/stok";
import { applyStockUpdate, planStockUpdate, resolveProduct } from "../lib/inventory/stock-update";
import {
  buildTransactionRecords, nextTransactionId, parseTransactionRows, recordTransaction, transactionRow, TRANSACTION_HEADERS,
  type TransactionStore,
} from "../lib/inventory/transaction-service";
import { currentMonthPeriod, jakartaDateTime } from "../lib/time/jakarta";

// Fixture rows only; these tests never read or write a real spreadsheet.
const item = (rowNumber: number, sku: string, namaBarang: string, stokAkhir: number): StokItem => ({
  rowNumber, sku, namaBarang, satuan: "pcs", stokAwal: stokAkhir, barangMasuk: 0, barangKeluar: 0, adjustment: 0,
  stokAkhir, stokMinimum: 5, statusStok: "AMAN", lokasiRak: "R-01", supplierUtama: "PT Contoh",
});
const inventory = [item(2, "BRG0001", "Gula", 10), item(3, "BRG0002", "Gula Pasir 1kg", 20), item(4, "BRG00021", "Kopi", 5)];

function memoryStore(): TransactionStore & { rows: (string | number)[][]; cells: StokCellWrite[][] } {
  const rows: (string | number)[][] = [];
  const cells: StokCellWrite[][] = [];
  return {
    rows, cells,
    async readTransactionIds() { return rows.map((row) => String(row[0])); },
    async commit(stockCells, historyRows) { cells.push([...stockCells]); rows.push(...historyRows); },
  };
}
const oneItem = { sku: "BRG0001", productName: "Gula", quantity: 3, unit: "kg", stockBefore: 10, stockAfter: 7 };
const oneCell: StokCellWrite = { rowNumber: 2, column: "F", value: 3 };

test("write mapping: only E, F, and G on data rows can be addressed; H is refused", () => {
  assert.deepEqual(stokCellUpdate({ rowNumber: 5, column: "E", value: 1 }), { sheetTitle: "Stok", rowNumber: 5, columnIndex: 4, value: 1 });
  assert.equal(stokCellUpdate({ rowNumber: 5, column: "F", value: 1 }).columnIndex, 5);
  assert.equal(stokCellUpdate({ rowNumber: 5, column: "G", value: -1 }).columnIndex, 6);
  assert.throws(() => stokCellUpdate({ rowNumber: 5, column: "H" as "E", value: 1 }), /Hanya kolom/);
  assert.throws(() => stokCellUpdate({ rowNumber: 1, column: "E", value: 1 }), /Baris Stok/);
  assert.throws(() => stokCellUpdate({ rowNumber: 5, column: "E", value: Number.NaN }), /tidak valid/);
});

test("resolution prefers exact SKU, then exact name, then partial matches", () => {
  assert.deepEqual(resolveProduct("brg0002", inventory).map((i) => i.sku), ["BRG0002"]);
  assert.deepEqual(resolveProduct("gula", inventory).map((i) => i.sku), ["BRG0001"]);
  assert.deepEqual(resolveProduct("gula p", inventory).map((i) => i.sku), ["BRG0002"]);
  assert.deepEqual(resolveProduct("brg000", inventory).map((i) => i.sku), ["BRG0001", "BRG0002", "BRG00021"]);
});

test("planning is read-only and validates quantities without reading when invalid", async () => {
  let reads = 0;
  const reader = async () => { reads++; return inventory; };
  assert.equal((await planStockUpdate("ADD_STOCK", [{ product_query: "gula", quantity: Number.NaN }], reader)).status, "INVALID_QUANTITY");
  assert.equal(reads, 0);
  const ready = await planStockUpdate("SET_STOCK", [{ product_query: "kopi", quantity: 0 }], reader);
  assert.deepEqual(ready.status === "READY" && ready.changes.map((c) => [c.sku, c.before, c.after]), [["BRG00021", 5, 0]]);
});

test("one failing item blocks the whole plan", async () => {
  const plan = await planStockUpdate("ADD_STOCK", [{ product_query: "kopi", quantity: 1 }, { product_query: "tidak ada", quantity: 1 }], async () => inventory);
  assert.equal(plan.status, "BLOCKED");
});

test("apply refuses changes whose direction does not match the type", async () => {
  const store = memoryStore();
  const deps = { user: "t", read: async () => inventory, transactions: store };
  assert.equal((await applyStockUpdate("ADD_STOCK", [{ sku: "BRG0001", before: 10, after: 5 }], deps)).status, "INVALID");
  assert.equal((await applyStockUpdate("REDUCE_STOCK", [{ sku: "BRG0001", before: 10, after: -1 }], deps)).status, "INVALID");
  assert.equal((await applyStockUpdate("SET_STOCK", [{ sku: "BRG0001", before: 10, after: 10 }], deps)).status, "INVALID");
  assert.equal((await applyStockUpdate("ADD_STOCK", [], deps)).status, "INVALID");
  assert.equal(store.cells.length, 0);
});

test("a failed commit whose effect cannot be ruled out is reported as uncertain", async () => {
  let call = 0;
  const reads = [inventory, inventory.map((row) => row.sku === "BRG0001" ? { ...row, stokAkhir: 15 } : row)];
  const result = await applyStockUpdate("ADD_STOCK", [{ sku: "BRG0001", before: 10, after: 15 }], {
    user: "t",
    read: async () => reads[Math.min(call++, 1)],
    transactions: { async readTransactionIds() { return []; }, async commit() { throw new Error("timeout"); } },
  });
  assert.equal(result.status === "WRITE_FAILED" && result.outcome, "UNKNOWN");
});

test("transaction IDs continue the TRX sequence and ignore other values", () => {
  assert.equal(nextTransactionId([]), "TRX-001");
  assert.equal(nextTransactionId(["TRX-001", "TRX-009", "catatan", "", "TRX-003"]), "TRX-010");
  assert.equal(nextTransactionId(["TRX-00012"]), "TRX-013");
  assert.equal(nextTransactionId(["TRX-999"]), "TRX-1000");
});

test("one action gives one row per item with the same ID and Asia/Jakarta date and time", () => {
  // 17:30 UTC on 27 September is already 28 September in Jakarta (UTC+7).
  const records = buildTransactionRecords({
    type: "ADD_STOCK", user: "@kasir (7)", at: new Date(Date.UTC(2026, 8, 27, 17, 30, 5)),
    items: [
      { sku: "BRG0006", productName: "Minyak", quantity: 20, unit: "botol", stockBefore: 62, stockAfter: 82 },
      { sku: "BRG0010", productName: "Gula", quantity: 30, unit: "kg", stockBefore: 40, stockAfter: 70 },
    ],
  }, "TRX-001");
  assert.deepEqual(records.map((r) => [r.transactionId, r.date, r.time, r.sku, r.quantity]), [
    ["TRX-001", "28/09/2026", "00:30", "BRG0006", 20],
    ["TRX-001", "28/09/2026", "00:30", "BRG0010", 30],
  ]);
  const row = transactionRow(records[0]);
  assert.equal(row.length, TRANSACTION_HEADERS.length);
  assert.deepEqual(row, ["TRX-001", "28/09/2026", "00:30", "MASUK", "BRG0006", "Minyak", 20, "botol", 62, 82, "@kasir (7)", ""]);
  assert.deepEqual(jakartaDateTime(new Date(Date.UTC(2026, 8, 30, 17, 0, 0))), { year: 2026, month: 10, day: 1, hour: 0, minute: 0, second: 0 });
  assert.equal(currentMonthPeriod(new Date(Date.UTC(2026, 8, 30, 17, 0, 0))).key, "2026-10");
});

test("recordTransaction commits stock cells and history together and validates input", async () => {
  const store = memoryStore();
  const first = await recordTransaction({ type: "REDUCE_STOCK", user: "u", items: [oneItem, { ...oneItem, sku: "BRG0002" }], stockCells: [oneCell, { ...oneCell, rowNumber: 3 }] }, store);
  const second = await recordTransaction({ type: "SET_STOCK", user: "u", items: [oneItem], stockCells: [oneCell], note: "stock opname" }, store);
  assert.deepEqual([first.transactionId, second.transactionId], ["TRX-001", "TRX-002"]);
  assert.equal(store.cells.length, 2, "one commit per transaction");
  assert.deepEqual(store.rows.map((row) => [row[0], row[3], row[11]]), [["TRX-001", "KELUAR", ""], ["TRX-001", "KELUAR", ""], ["TRX-002", "KOREKSI", "stock opname"]]);
  await assert.rejects(recordTransaction({ type: "ADD_STOCK", user: "u", items: [], stockCells: [] }, store), /1–20 barang/);
  await assert.rejects(recordTransaction({ type: "ADD_STOCK", user: "u", items: [{ ...oneItem, quantity: Number.NaN }], stockCells: [oneCell] }, store), /tidak valid/);
  await assert.rejects(recordTransaction({ type: "ADD_STOCK", user: "u", items: Array.from({ length: 21 }, () => oneItem), stockCells: [] }, store), /1–20 barang/);
  // A stock change without a history row (or the reverse) is refused.
  await assert.rejects(recordTransaction({ type: "ADD_STOCK", user: "u", items: [oneItem], stockCells: [] }, store), /satu perubahan stok/);
  assert.equal(store.rows.length, 3);
});

test("history rows are read back from text, ISO, and Sheets serial dates", () => {
  const entries = parseTransactionRows([
    ["TRX-001", "27/09/2026", "10:15", "MASUK", "BRG0001", "Gula", 20, "kg", 10, 30, "u", ""],
    [],
    ["TRX-002", "2026-09-28", "08:05:30", "Barang Keluar", "BRG0001", "Gula", "5", "kg", "30", "25", "u", "rusak"],
    ["TRX-003", 46293, 0.5, "KOREKSI", "BRG0001", "Gula", -1, "kg", 25, 24, "u", ""],
  ]);
  assert.deepEqual(entries.map((e) => [e.rowNumber, e.transactionId, e.dateText, e.timeText, e.type, e.quantity, e.stockAfter]), [
    [2, "TRX-001", "27/09/2026", "10:15", "ADD_STOCK", 20, 30],
    [4, "TRX-002", "28/09/2026", "08:05:30", "REDUCE_STOCK", 5, 25],
    [5, "TRX-003", "28/09/2026", "12:00", "SET_STOCK", -1, 24],
  ]);
});
