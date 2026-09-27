import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRuleIntent } from "../lib/parser/rule-parser";
import type { StructuredIntent } from "../lib/parser/intents";

const examples: [string, StructuredIntent][] = [
  ["stok minyak", { intent: "CHECK_STOCK", product_query: "minyak", quantity: null }],
  ["cek stok minyak goreng", { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null }],
  ["minyak goreng tinggal berapa", { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null }],
  ["cari minyak goreng", { intent: "SEARCH_PRODUCT", product_query: "minyak goreng", quantity: null }],
  ["minyak goreng", { intent: "SEARCH_PRODUCT", product_query: "minyak goreng", quantity: null }],
  ["barang apa yang hampir habis", { intent: "LOW_STOCK", product_query: null, quantity: null }],
  ["stok menipis", { intent: "LOW_STOCK", product_query: null, quantity: null }],
  ["tambah stok minyak 20", { intent: "ADD_STOCK", product_query: "minyak", quantity: 20 }],
  ["kurangi stok minyak 5", { intent: "REDUCE_STOCK", product_query: "minyak", quantity: 5 }],
  ["set stok minyak 50", { intent: "SET_STOCK", product_query: "minyak", quantity: 50 }],
  ["buat pesanan", { intent: "CREATE_ORDER", product_query: null, quantity: null }],
  ["batal", { intent: "CANCEL", product_query: null, quantity: null }],
  ["ya", { intent: "CONFIRM", product_query: null, quantity: null }],
  ["tidak", { intent: "CANCEL", product_query: null, quantity: null }],
  ["bantuan", { intent: "HELP", product_query: null, quantity: null }],
  ["apa kabar", { intent: "UNKNOWN", product_query: null, quantity: null }],
];

for (const [input, expected] of examples) {
  test(`parser: ${input} -> ${expected.intent}`, () => {
    assert.deepEqual(parseRuleIntent(input), expected);
  });
}

test("normalizes case, repeated whitespace, polite prefixes, and question punctuation", () => {
  assert.deepEqual(parseRuleIntent("  Tolong  LIHAT\n STOK  Minyak  Goreng dong?! "), {
    intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null,
  });
});

test("recognizes stock question variations", () => {
  for (const input of ["lihat minyak goreng", "berapa stok minyak goreng", "berapa minyak goreng", "stok minyak goreng berapa", "minyak goreng stoknya berapa", "minyak goreng sisa berapa lagi", "periksa stok minyak goreng"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null });
  }
});

test("recognizes search variations, SKUs, and arbitrary product names without a catalog", () => {
  for (const input of ["cari produk abc-001", "carikan barang abc-001", "ABC-001"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "SEARCH_PRODUCT", product_query: "abc-001", quantity: null });
  }
  assert.equal(parseRuleIntent("produkbaru 2 liter").intent, "SEARCH_PRODUCT");
  assert.equal(parseRuleIntent("00123").product_query, "00123");
  assert.equal(parseRuleIntent("SET-001").product_query, "set-001");
});

test("recognizes low stock variants before generic stock and search rules", () => {
  for (const input of ["lihat stok menipis", "cek barang yang hampir habis", "cari produk yang habis", "stok di bawah minimum"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "LOW_STOCK", product_query: null, quantity: null });
  }
});

test("parses decimal quantities and preserves package sizes within product queries", () => {
  assert.deepEqual(parseRuleIntent("tambahkan stok minyak 2 liter 2,5"), { intent: "ADD_STOCK", product_query: "minyak 2 liter", quantity: 2.5 });
  assert.deepEqual(parseRuleIntent("kurangi beras 1.5"), { intent: "REDUCE_STOCK", product_query: "beras", quantity: 1.5 });
  assert.deepEqual(parseRuleIntent("atur stok minyak 0"), { intent: "SET_STOCK", product_query: "minyak", quantity: 0 });
});

test("malformed stock commands never fall back to a product search", () => {
  for (const input of ["tambah stok minyak", "kurangi stok minyak lima", "tambah stok minyak -5", "set stok minyak -1", "tambah stok minyak 0", "kurangi stok minyak 0", "tambah stok minyak 9007199254740992", "tambah stok minyak 1e10", "tambah stok 20", "set stok minyak 50 lalu kurangi stok minyak 5"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "UNKNOWN", product_query: null, quantity: null }, input);
  }
});

test("empty, unsupported commands, incomplete requests, and conversation are UNKNOWN", () => {
  for (const input of ["", "  \n ", "???", "🔥", "cek stok", "cari", "temukan", "stok", "hapus produk minyak", "kirim pesan", "bagaimana cuaca hari ini", "halo", "terima kasih", "https://example.com", "x".repeat(501)]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "UNKNOWN", product_query: null, quantity: null }, input);
  }
});
