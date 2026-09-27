import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import type { StokItem } from "../lib/google-sheets/stok";
import { parseTransactionRows } from "../lib/inventory/transaction-service";
import { generateReportPdf } from "../lib/report/pdf-generator";
import { buildMonthlyReport, reportFileName } from "../lib/report/report-service";
import { currentMonthPeriod } from "../lib/time/jakarta";

// Fixtures only; the report tests never read the production spreadsheet.
const item = (rowNumber: number, sku: string, name: string, stock: number, minimum: number | null, unit = "pcs"): StokItem => ({
  rowNumber, sku, namaBarang: name, satuan: unit, stokAwal: stock, barangMasuk: 0, barangKeluar: 0, adjustment: 0,
  stokAkhir: stock, stokMinimum: minimum, statusStok: "", lokasiRak: "R-01", supplierUtama: "PT Contoh",
});
const stock = [
  item(2, "BRG0001", "Minyak Goreng 1L", 82, 20, "botol"),
  item(3, "BRG0002", "Gula Pasir 1kg", 12, 15, "kg"),
  item(4, "BRG0003", "Tepung Terigu", 0, 10, "kg"),
  item(5, "BRG0004", "Kopi Bubuk", 30, null),
];
// 27/09/2026 10:15 WIB
const now = new Date(Date.UTC(2026, 8, 27, 3, 15, 0));
const config = { companyName: "PT Indah Merta Anugerah", assistantName: "Asisten Digital", timeZone: "Asia/Jakarta" };

const history = parseTransactionRows([
  ["TRX-001", "31/08/2026", "23:59", "MASUK", "BRG0001", "Minyak Goreng 1L", 10, "botol", 52, 62, "@kasir (7)", ""],
  ["TRX-002", "01/09/2026", "08:00", "MASUK", "BRG0001", "Minyak Goreng 1L", 20, "botol", 62, 82, "@kasir (7)", ""],
  ["TRX-002", "01/09/2026", "08:00", "MASUK", "BRG0002", "Gula Pasir 1kg", 30, "kg", 40, 70, "@kasir (7)", ""],
  ["TRX-003", "15/09/2026", "13:30", "KELUAR", "BRG0002", "Gula Pasir 1kg", 50, "kg", 70, 20, "@gudang (8)", "Penjualan grosir"],
  ["TRX-004", "20/09/2026", "09:10", "KOREKSI", "BRG0002", "Gula Pasir 1kg", -8, "kg", 20, 12, "@gudang (8)", "Koreksi ke 12"],
  ["TRX-005", "01/10/2026", "07:00", "MASUK", "BRG0001", "Minyak Goreng 1L", 5, "botol", 82, 87, "@kasir (7)", ""],
]);

const build = (overrides: Partial<Parameters<typeof buildMonthlyReport>[0]> = {}) =>
  buildMonthlyReport({ now, config, readStock: async () => stock, readTransactions: async () => history, ...overrides });

test("the report covers the running calendar month in Asia/Jakarta", async () => {
  const report = await build();
  assert.deepEqual(report.period, {
    key: "2026-09", start: { year: 2026, month: 9, day: 1 }, end: { year: 2026, month: 9, day: 30 },
    label: "1 September 2026 – 30 September 2026",
  });
  assert.equal(report.generatedAt, "27/09/2026 10:15 WIB");
  assert.equal(reportFileName(report), "laporan-stok-transaksi-2026-09.pdf");
  assert.equal(currentMonthPeriod(new Date(Date.UTC(2028, 1, 10))).end.day, 29, "leap-year February");
  // 30 September 23:00 UTC is already 1 October in Jakarta.
  assert.equal(currentMonthPeriod(new Date(Date.UTC(2026, 8, 30, 23, 0))).key, "2026-10");
});

test("only transactions dated in the running month are included", async () => {
  const report = await build();
  assert.deepEqual([...new Set(report.history.map((entry) => entry.transactionId))].sort(), ["TRX-002", "TRX-003", "TRX-004"]);
});

test("stock summary counts safe, low, and empty items from the Stok sheet", async () => {
  const report = await build();
  assert.deepEqual({ total: report.stock.total, safe: report.stock.safe, low: report.stock.low, out: report.stock.out }, { total: 4, safe: 2, low: 1, out: 1 });
  assert.deepEqual(report.stock.rows.map((row) => [row.sku, row.status]), [["BRG0001", "Aman"], ["BRG0002", "Menipis"], ["BRG0003", "Habis"], ["BRG0004", "Aman"]]);
});

test("goods in and out: item counts and quantity totals", async () => {
  const report = await build();
  assert.equal(report.incoming.count, 2);
  assert.equal(report.incoming.quantity, 50);
  assert.deepEqual(report.incoming.rows.map((row) => row.sku), ["BRG0001", "BRG0002"]);
  assert.equal(report.outgoing.count, 1);
  assert.equal(report.outgoing.quantity, 50);
  assert.equal(report.outgoing.rows[0].note, "Penjualan grosir");
});

test("stock movement uses the history: opening + in − out + adjustment", async () => {
  const report = await build();
  assert.deepEqual(report.movements.map((row) => [row.sku, row.opening, row.incoming, row.outgoing, row.adjustment, row.closing]), [
    ["BRG0001", 62, 20, 0, 0, 82],
    ["BRG0002", 40, 30, 50, -8, 12],
  ]);
  assert.deepEqual(report.discrepancies, []);
});

test("differences between history and current stock are reported, never corrected", async () => {
  const edited = stock.map((row) => row.sku === "BRG0001" ? { ...row, stokAkhir: 75 } : row);
  const report = await build({ readStock: async () => edited });
  assert.equal(report.movements[0].closing, 82, "the history still drives the period figures");
  assert.equal(report.discrepancies.length, 1);
  assert.match(report.discrepancies[0], /BRG0001 .*stok saat ini 75 berbeda dari histori \(82\)/);
});

test("the history section lists the month newest first", async () => {
  const report = await build();
  assert.deepEqual(report.history.map((entry) => `${entry.transactionId} ${entry.dateText} ${entry.timeText} ${entry.sku}`), [
    "TRX-004 20/09/2026 09:10 BRG0002",
    "TRX-003 15/09/2026 13:30 BRG0002",
    "TRX-002 01/09/2026 08:00 BRG0002",
    "TRX-002 01/09/2026 08:00 BRG0001",
  ]);
  assert.deepEqual(report.purchases, []);
});

test("a month without transactions still reports the stock condition", async () => {
  const report = await build({ readTransactions: async () => [] });
  assert.equal(report.history.length, 0);
  assert.equal(report.incoming.count + report.outgoing.count + report.movements.length, 0);
  assert.equal(report.stock.total, 4);
  const pdf = await generateReportPdf(report);
  assert.ok(pdf.pageCount >= 1 && pdf.pageCount <= 2, `short report, got ${pdf.pageCount} pages`);
});

test("generates a single PDF document with the expected name and metadata", async () => {
  const report = await build();
  const pdf = await generateReportPdf(report);
  assert.equal(pdf.filename, "laporan-stok-transaksi-2026-09.pdf");
  assert.equal(Buffer.from(pdf.bytes.subarray(0, 5)).toString(), "%PDF-");
  const loaded = await PDFDocument.load(pdf.bytes);
  assert.equal(loaded.getPageCount(), pdf.pageCount);
  assert.equal(loaded.getTitle(), "Laporan Stok & Transaksi 1 September 2026 – 30 September 2026");
  assert.equal(loaded.getAuthor(), "PT Indah Merta Anugerah");
  assert.equal(loaded.getCreator(), "Asisten Digital");
});

test("long transaction lists flow onto multiple pages; unusual characters do not break it", async () => {
  const many = parseTransactionRows(Array.from({ length: 400 }, (_, i) => [
    `TRX-${String(100 + i).padStart(3, "0")}`, `${String((i % 27) + 1).padStart(2, "0")}/09/2026`, "10:00",
    i % 2 ? "KELUAR" : "MASUK", `BRG${String(i).padStart(4, "0")}`, `Barang 🔥 ${"sangat panjang ".repeat(i % 5)}${i}`,
    1, "pcs", 10, i % 2 ? 9 : 11, "@kasir (7)", i % 7 ? "" : "Catatan → 超",
  ]));
  const report = await build({ readTransactions: async () => many, readStock: async () => Array.from({ length: 150 }, (_, i) => item(i + 2, `BRG${String(i).padStart(4, "0")}`, `Barang ${i}`, i % 3, 1)) });
  const pdf = await generateReportPdf(report);
  assert.ok(pdf.pageCount > 10, `expected many pages, got ${pdf.pageCount}`);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), pdf.pageCount);
});
