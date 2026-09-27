import assert from "node:assert/strict";
import { test } from "node:test";
import { parseQuantityInput, parseRuleIntent } from "../lib/parser/rule-parser";
import type { StockChangeIntent, StructuredIntent } from "../lib/parser/intents";

const examples: [string, StructuredIntent][] = [
  ["stok minyak", { intent: "CHECK_STOCK", product_query: "minyak", quantity: null }],
  ["cek stok minyak goreng", { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null }],
  ["minyak goreng tinggal berapa", { intent: "CHECK_STOCK", product_query: "minyak goreng", quantity: null }],
  ["cari minyak goreng", { intent: "SEARCH_PRODUCT", product_query: "minyak goreng", quantity: null }],
  ["minyak goreng", { intent: "SEARCH_PRODUCT", product_query: "minyak goreng", quantity: null }],
  ["barang apa yang hampir habis", { intent: "LOW_STOCK", product_query: null, quantity: null }],
  ["stok menipis", { intent: "LOW_STOCK", product_query: null, quantity: null }],
  ["tambah stok minyak 20", { intent: "ADD_STOCK", product_query: null, quantity: null, items: [{ product_query: "minyak", quantity: 20 }] }],
  ["kurangi stok minyak 5", { intent: "REDUCE_STOCK", product_query: null, quantity: null, items: [{ product_query: "minyak", quantity: 5 }] }],
  ["set stok minyak 50", { intent: "SET_STOCK", product_query: null, quantity: null, items: [{ product_query: "minyak", quantity: 50 }] }],
  ["📊 Laporan", { intent: "REPORT", product_query: null, quantity: null }],
  ["batal", { intent: "CANCEL", product_query: null, quantity: null }],
  ["ya", { intent: "CONFIRM", product_query: null, quantity: null }],
  ["tidak", { intent: "CANCEL", product_query: null, quantity: null }],
  ["bantuan", { intent: "HELP", product_query: null, quantity: null }],
  ["/start", { intent: "START", product_query: null, quantity: null }],
  ["update stok", { intent: "UPDATE_STOCK", product_query: null, quantity: null }],
  ["cek stok", { intent: "CHECK_STOCK", product_query: "", quantity: null }],
  ["cek stock", { intent: "CHECK_STOCK", product_query: "", quantity: null }],
  ["cek stok minyak", { intent: "CHECK_STOCK", product_query: "minyak", quantity: null }],
  ["lihat stok beras", { intent: "CHECK_STOCK", product_query: "beras", quantity: null }],
  ["cari minyak", { intent: "SEARCH_PRODUCT", product_query: "minyak", quantity: null }],
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

const stock = (intent: StockChangeIntent, ...items: [string, number][]) => ({
  intent, product_query: null, quantity: null, items: items.map(([product_query, quantity]) => ({ product_query, quantity })),
});

test("parses decimal quantities and preserves package sizes within product queries", () => {
  assert.deepEqual(parseRuleIntent("tambahkan stok minyak 2 liter 2,5"), stock("ADD_STOCK", ["minyak 2 liter", 2.5]));
  assert.deepEqual(parseRuleIntent("kurangi beras 1.5"), stock("REDUCE_STOCK", ["beras", 1.5]));
  assert.deepEqual(parseRuleIntent("tambah stok minyak 1.500"), stock("ADD_STOCK", ["minyak", 1500]));
  assert.deepEqual(parseRuleIntent("atur stok minyak 0"), stock("SET_STOCK", ["minyak", 0]));
});

test("multi-item stock commands: ADD, REDUCE, and SET in every supported form", () => {
  const add = stock("ADD_STOCK", ["minyak", 20], ["gula", 30], ["beras", 50]);
  for (const input of ["tambah stok minyak 20, gula 30, beras 50", "minyak +20, gula +30, beras +50", "barang masuk: minyak 20, gula 30, beras 50", "masuk minyak 20; gula 30 dan beras 50", "barang masuk:\nminyak 20\ngula 30 kg\nberas 50"]) {
    assert.deepEqual(parseRuleIntent(input), add, input);
  }
  assert.deepEqual(parseRuleIntent("keluar beras 10, minyak 5"), stock("REDUCE_STOCK", ["beras", 10], ["minyak", 5]));
  assert.deepEqual(parseRuleIntent("minyak -5, gula -2"), stock("REDUCE_STOCK", ["minyak", 5], ["gula", 2]));
  assert.deepEqual(parseRuleIntent("barang keluar: beras 10"), stock("REDUCE_STOCK", ["beras", 10]));
  assert.deepEqual(parseRuleIntent("koreksi stok minyak jadi 50, gula jadi 20"), stock("SET_STOCK", ["minyak", 50], ["gula", 20]));
  assert.deepEqual(parseRuleIntent("set stok minyak 50"), stock("SET_STOCK", ["minyak", 50]));
  // Duplicates are kept here and merged after the product is resolved.
  assert.deepEqual(parseRuleIntent("barang masuk: minyak 20, minyak 10"), stock("ADD_STOCK", ["minyak", 20], ["minyak", 10]));
  // Free chat with the verb after the product.
  assert.deepEqual(parseRuleIntent("minyak masuk 20"), stock("ADD_STOCK", ["minyak", 20]));
  assert.deepEqual(parseRuleIntent("beras keluar 10"), stock("REDUCE_STOCK", ["beras", 10]));
  assert.deepEqual(parseRuleIntent("beras keluar 10, gula keluar 5"), stock("REDUCE_STOCK", ["beras", 10], ["gula", 5]));
  assert.equal(parseRuleIntent("beras keluar 10, gula masuk 5").intent, "UNKNOWN");
});

test("a bare stock command carries no items (the product-first flow takes over)", () => {
  for (const [input, intent] of [["barang masuk", "ADD_STOCK"], ["tambah stok", "ADD_STOCK"], ["keluar", "REDUCE_STOCK"], ["koreksi stok", "SET_STOCK"]] as const) {
    assert.deepEqual(parseRuleIntent(input), stock(intent), input);
  }
});

test("the Update Stok quantity accepts a plain number only", () => {
  for (const [input, expected] of [["20", 20], ["5", 5], ["1,5", 1.5], ["1.5", 1.5], ["1.500", 1500], [" 150 ", 150], ["0", 0]] as const) {
    assert.equal(parseQuantityInput(input), expected, input);
  }
  for (const input of ["20 kg", "dua puluh", "beras 20", "beras medium 20 kg", "-5", "+5", "", "1.2.3", "20,"]) {
    assert.equal(parseQuantityInput(input), null, input);
  }
});

test("invalid quantities stay visible for validation instead of becoming a search", () => {
  const cases: [string, number][] = [["tambah stok minyak", Number.NaN], ["kurangi stok minyak lima", Number.NaN], ["tambah stok minyak -5", -5], ["tambah stok minyak 0", 0], ["tambah stok minyak 1e10", Number.NaN], ["koreksi minyak +5", Number.NaN]];
  for (const [input, quantity] of cases) {
    const parsed = parseRuleIntent(input);
    assert.ok("items" in parsed && parsed.items.length === 1, input);
    assert.ok(Object.is(parsed.items[0].quantity, quantity), `${input}: ${parsed.items[0].quantity}`);
  }
});

test("unreadable stock commands and mixed signs are UNKNOWN", () => {
  for (const input of ["set stok minyak 50 lalu kurangi stok minyak 5", "minyak +5, gula -2", "tambah stok bagaimana cuaca 5"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "UNKNOWN", product_query: null, quantity: null }, input);
  }
  // SKUs with dashes are not read as "minus".
  assert.equal(parseRuleIntent("ABC-001").intent, "SEARCH_PRODUCT");
});

test("bare stock and search commands open their prompt", () => {
  for (const input of ["cek stok", "cek stock", "lihat stok", "lihat stock", "stok", "🔍 Cek Stok", "cek sisa stok"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "CHECK_STOCK", product_query: "", quantity: null }, input);
  }
  for (const input of ["cari", "temukan", "cari barang", "📋 Cari Barang"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "SEARCH_PRODUCT", product_query: "", quantity: null }, input);
  }
});

test("natural check-stock phrasing, including 'stock' spelling and 'ada berapa'", () => {
  const cases: [string, string][] = [
    ["cek stok minyak", "minyak"], ["cek stock minyak", "minyak"], ["stok minyak", "minyak"], ["berapa stok minyak", "minyak"],
    ["minyak tinggal berapa", "minyak"], ["stok beras ada berapa", "beras"], ["beras ada berapa?", "beras"],
    ["lihat stok beras", "beras"], ["lihat stock beras", "beras"], ["gula masih ada berapa", "gula"],
  ];
  for (const [input, query] of cases) {
    assert.deepEqual(parseRuleIntent(input), { intent: "CHECK_STOCK", product_query: query, quantity: null }, input);
  }
});

test("menu labels and commands map to their flows", () => {
  const cases: [string, string][] = [
    ["/start", "START"], ["/menu", "START"], ["menu", "START"], ["/help@stok_bot", "HELP"], ["❓ Bantuan", "HELP"],
    ["📝 Update Stok", "UPDATE_STOCK"], ["⚠️ Stok Menipis", "LOW_STOCK"], ["📞 Hubungi Supplier", "CONTACT_SUPPLIER"],
    ["lihat supplier", "LIST_SUPPLIERS"], ["📊 Laporan", "REPORT"],
  ];
  for (const [input, intent] of cases) assert.equal(parseRuleIntent(input).intent, intent, input);
});

test("ordering phrases open the supplier directory; no order is parsed", () => {
  for (const input of ["🛒 Buat Pesanan", "buat pesanan", "pesan", "pesan minyak 20", "butuh minyak 20 botol dan gula 30 kg", "order gula 5"]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "CONTACT_SUPPLIER", product_query: null, quantity: null }, input);
  }
});

test("empty, unsupported commands, incomplete requests, and conversation are UNKNOWN", () => {
  for (const input of ["", "  \n ", "???", "🔥", "hapus produk minyak", "kirim pesan", "bagaimana cuaca hari ini", "halo", "terima kasih", "https://example.com", "x".repeat(501)]) {
    assert.deepEqual(parseRuleIntent(input), { intent: "UNKNOWN", product_query: null, quantity: null }, input);
  }
});
