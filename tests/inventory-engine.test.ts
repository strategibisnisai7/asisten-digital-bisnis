import assert from "node:assert/strict";
import { test } from "node:test";
import { executeInventoryIntent } from "../lib/inventory/inventory-engine";
import { GoogleSheetsError } from "../lib/google-sheets/errors";
import type { StokItem } from "../lib/google-sheets/stok";
import type { StructuredIntent } from "../lib/parser/intents";

const items: StokItem[] = [
  { rowNumber: 2, sku: "MYK-001", namaBarang: "Minyak Goreng A", satuan: "liter", stokAwal: 100, barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: 5, stokMinimum: 5, statusStok: "Menipis", lokasiRak: "A1", supplierUtama: "Supplier A" },
  { rowNumber: 3, sku: "MYK-002", namaBarang: "Minyak Goreng B", satuan: "liter", stokAwal: 20, barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: 20, stokMinimum: 5, statusStok: "Aman", lokasiRak: "A2", supplierUtama: "Supplier B" },
  { rowNumber: 4, sku: "BR-003", namaBarang: "Beras", satuan: "kg", stokAwal: 0, barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: -1, stokMinimum: 0, statusStok: "Habis", lokasiRak: "B1", supplierUtama: "Supplier C" },
  { rowNumber: 5, sku: "GL-004", namaBarang: "Gula", satuan: "kg", stokAwal: 0, barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: 0, stokMinimum: null, statusStok: "", lokasiRak: "", supplierUtama: "" },
];
const reader = async () => items;

test("CHECK_STOCK maps the eight product fields and uses the sheet total", async () => {
  const result = await executeInventoryIntent({ intent: "CHECK_STOCK", product_query: "myk-001", quantity: null }, reader);
  assert.deepEqual(result, {
    intent: "CHECK_STOCK", status: "SUCCESS",
    product: { sku: "MYK-001", name: "Minyak Goreng A", unit: "liter", currentStock: 5, minimumStock: 5, status: "Menipis", rack: "A1", supplier: "Supplier A" },
  });
});

test("SEARCH_PRODUCT returns all candidates for partial names and SKUs regardless of case", async () => {
  for (const query of ["  MINYAK   goreng ", "mYk-0"]) {
    const result = await executeInventoryIntent({ intent: "SEARCH_PRODUCT", product_query: query, quantity: null }, reader);
    assert.equal(result.status, "SUCCESS");
    assert.ok("products" in result);
    assert.deepEqual(result.products.map((item) => item.sku), ["MYK-001", "MYK-002"]);
  }
});

test("CHECK_STOCK returns candidates instead of guessing when matches are ambiguous", async () => {
  const result = await executeInventoryIntent({ intent: "CHECK_STOCK", product_query: "minyak", quantity: null }, reader);
  assert.equal(result.status, "MULTIPLE_MATCHES");
  assert.ok("products" in result);
  assert.equal(result.products.length, 2);
});

test("CHECK_STOCK and SEARCH_PRODUCT clearly report missing products", async () => {
  for (const intent of ["CHECK_STOCK", "SEARCH_PRODUCT"] as const) {
    const result = await executeInventoryIntent({ intent, product_query: "not-in-inventory", quantity: null }, reader);
    assert.equal(result.status, "NOT_FOUND");
  }
});

test("LOW_STOCK includes equality, negative stock, and zero minimum; excludes unknown minimum", async () => {
  const result = await executeInventoryIntent({ intent: "LOW_STOCK", product_query: null, quantity: null }, reader);
  assert.equal(result.status, "SUCCESS");
  assert.ok("products" in result);
  assert.deepEqual(result.products.map((item) => item.sku), ["MYK-001", "BR-003"]);
});

test("LOW_STOCK returns an empty list when no products are low", async () => {
  const result = await executeInventoryIntent({ intent: "LOW_STOCK", product_query: null, quantity: null }, async () => [items[1]]);
  assert.deepEqual(result, { intent: "LOW_STOCK", status: "SUCCESS", products: [] });
});

test("empty product queries do not fetch or accidentally match the entire inventory", async () => {
  for (const intent of ["CHECK_STOCK", "SEARCH_PRODUCT"] as const) {
    const result = await executeInventoryIntent({ intent, product_query: " \n ", quantity: null }, async () => {
      assert.fail("Reader must not be called");
    });
    assert.equal(result.status, "INVALID_QUERY");
  }
});

test("write, order, control, and unknown intents never access Sheets", async () => {
  const unsupported: StructuredIntent[] = [
    ...(["ADD_STOCK", "REDUCE_STOCK", "SET_STOCK"] as const).map((intent) => ({ intent, product_query: null, quantity: null, items: [{ product_query: "minyak", quantity: 5 }] })),
    ...(["CREATE_ORDER", "CANCEL", "CONFIRM", "HELP", "UNKNOWN"] as const).map((intent) => ({ intent, product_query: null, quantity: null })),
  ];
  for (const parsed of unsupported) {
    const result = await executeInventoryIntent(parsed, async () => { assert.fail("Reader must not be called"); });
    assert.equal(result.status, "UNSUPPORTED_INTENT");
  }
});

test("each read observes source changes without modifying source records", async () => {
  const source = items.map((item) => ({ ...item }));
  const parsed: StructuredIntent = { intent: "CHECK_STOCK", product_query: "MYK-001", quantity: null };
  const before = structuredClone(source);
  await executeInventoryIntent(parsed, async () => source);
  assert.deepEqual(source, before);
  source[0].stokAkhir = 42;
  const result = await executeInventoryIntent(parsed, async () => source);
  assert.ok("product" in result);
  assert.equal(result.product.currentStock, 42);
});

test("Sheets failures propagate and are never disguised as an empty inventory", async () => {
  const error = new GoogleSheetsError("ACCESS", "Akses ditolak.");
  await assert.rejects(
    executeInventoryIntent({ intent: "LOW_STOCK", product_query: null, quantity: null }, async () => { throw error; }),
    (actual) => actual === error,
  );
});
