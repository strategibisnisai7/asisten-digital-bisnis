import assert from "node:assert/strict";
import { test } from "node:test";
import { editDistance, productScore } from "../lib/parser/fuzzy";
import type { IntentType, StructuredIntent } from "../lib/parser/intents";
import { parseNumberWords, parseQuantityPhrase } from "../lib/parser/numbers";
import { extractPeriod, resolvePeriod } from "../lib/parser/period";
import { analyzeMessage, parseQuantityReply, parseRuleIntent, splitTrailingQuantity } from "../lib/parser/rule-parser";
import { canonicalUnit, unitFactor } from "../lib/parser/units";
import { HELP_TOPICS } from "../lib/telegram/formatting";

const intentOf = (input: string) => parseRuleIntent(input).intent;
const items = (input: string) => {
  const parsed = parseRuleIntent(input);
  return "items" in parsed ? parsed.items : null;
};

// ---------------------------------------------------------------- the intent table from the brief

const INTENT_TABLE: [IntentType, string[]][] = [
  ["CHECK_STOCK", ["stok minyak", "minyak tinggal berapa?", "berapa sisa beras?", "cek stok gula", "sisa minyak", "minyak masih ada?", "stok gula brp", "jumlah beras"]],
  ["SEARCH_PRODUCT", ["cari minyak goreng", "ada barang merek ABC?", "tampilkan produk beras", "carikan produk abc-001"]],
  ["LOW_STOCK", ["barang apa yang hampir habis?", "stok kritis", "mana yang perlu restock?", "stok menipis", "barang yang mau habis", "stok di bawah minimum"]],
  ["STOCK_FILTER", ["barang di bawah 10", "stok kurang dari 5 pcs", "stok antara 10 sampai 20", "barang yang stoknya lebih dari 100", "stok sama dengan 0", "barang kosong"]],
  ["ADD_STOCK", ["minyak masuk 20", "tambah beras 5 kg", "baru datang gula 10 pcs", "gula datang 10", "restock minyak 5"]],
  ["REDUCE_STOCK", ["minyak keluar 3", "beras terjual 10 kg", "kurangi gula 2", "jual minyak 3", "terjual beras 2"]],
  ["SET_STOCK", ["stok minyak sekarang 25", "koreksi beras jadi 100 kg", "minyak seharusnya 30", "set stok gula 10"]],
  ["TRANSACTION_HISTORY", ["riwayat minyak", "transaksi hari ini", "barang masuk kemarin", "histori gula bulan ini", "barang keluar minggu ini", "minyak masuk kemarin"]],
  ["STOCK_ANALYSIS", ["barang paling banyak keluar minggu ini", "produk terlaris bulan ini", "barang paling sering masuk", "apa yang paling laku"]],
  ["HELP", ["cara pakai", "menu bantuan", "apa saja yang bisa dilakukan?", "bantuan", "kamu bisa apa"]],
  ["CANCEL", ["batal", "batalkan", "gak jadi", "nggak jadi", "tidak usah"]],
  ["CONFIRM", ["ya", "konfirmasi", "lanjutkan", "simpan", "oke simpan"]],
];

for (const [intent, inputs] of INTENT_TABLE) {
  test(`intent table: ${intent}`, () => {
    for (const input of inputs) assert.equal(intentOf(input), intent, input);
  });
}

test("entities for the brief's examples", () => {
  assert.deepEqual(parseRuleIntent("berapa sisa beras?"), { intent: "CHECK_STOCK", product_query: "beras", quantity: null });
  assert.deepEqual(parseRuleIntent("ada barang merek ABC?"), { intent: "SEARCH_PRODUCT", product_query: "abc", quantity: null });
  assert.deepEqual(items("tambah beras 5 kg"), [{ product_query: "beras", quantity: 5, unit: "kg" }]);
  assert.deepEqual(items("baru datang gula 10 pcs"), [{ product_query: "gula", quantity: 10, unit: "pcs" }]);
  assert.deepEqual(items("beras terjual 10 kg"), [{ product_query: "beras", quantity: 10, unit: "kg" }]);
  assert.deepEqual(items("stok minyak sekarang 25"), [{ product_query: "minyak", quantity: 25 }]);
  assert.deepEqual(items("koreksi beras jadi 100 kg"), [{ product_query: "beras", quantity: 100, unit: "kg" }]);
  assert.deepEqual(parseRuleIntent("barang masuk kemarin"), {
    intent: "TRANSACTION_HISTORY", product_query: null, quantity: null, period: { kind: "yesterday" }, type: "ADD_STOCK",
  });
  assert.deepEqual(parseRuleIntent("riwayat minyak"), {
    intent: "TRANSACTION_HISTORY", product_query: "minyak", quantity: null, period: null, type: null,
  });
  assert.deepEqual(parseRuleIntent("barang paling banyak keluar minggu ini"), {
    intent: "STOCK_ANALYSIS", product_query: null, quantity: null, metric: "TOP_OUT", period: { kind: "this_week" },
  });
  assert.deepEqual(parseRuleIntent("barang paling sering masuk"), {
    intent: "STOCK_ANALYSIS", product_query: null, quantity: null, metric: "FREQUENT_IN", period: null,
  });
});

test("priority: the same words mean different things by position", () => {
  // Verb after the product + number: a stock change, not a search.
  assert.equal(intentOf("minyak masuk 20"), "ADD_STOCK");
  // "sekarang <angka>": a correction, not an incoming movement.
  assert.equal(intentOf("stok minyak sekarang 20"), "SET_STOCK");
  // A period without a number: a question about the past.
  assert.equal(intentOf("minyak masuk kemarin"), "TRANSACTION_HISTORY");
  // "kurang dari" is a filter, not "kurangi".
  assert.deepEqual(parseRuleIntent("kurang dari 5"), { intent: "STOCK_FILTER", product_query: null, quantity: null, filter: { op: "lt", value: 5 } });
  // "di bawah minimum" is the low-stock rule, "di bawah 10" a number filter.
  assert.equal(intentOf("stok di bawah minimum"), "LOW_STOCK");
  assert.equal(intentOf("stok di bawah 10"), "STOCK_FILTER");
  // A question word keeps a stock question read-only.
  assert.equal(intentOf("stok minyak sekarang berapa"), "CHECK_STOCK");
  assert.equal(intentOf("terima kasih"), "UNKNOWN");
  // Mixed directions in one message are refused rather than guessed.
  assert.equal(intentOf("beras keluar 10, gula masuk 5"), "UNKNOWN");
  assert.equal(intentOf("barang paling banyak masuk dan keluar"), "UNKNOWN");
});

test("filters: operators, ranges, and units", () => {
  const filter = (input: string) => {
    const parsed = parseRuleIntent(input);
    return parsed.intent === "STOCK_FILTER" ? parsed.filter : null;
  };
  assert.deepEqual(filter("barang di bawah 10"), { op: "lt", value: 10 });
  assert.deepEqual(filter("stok kurang dari 5 pcs"), { op: "lt", value: 5, unit: "pcs" });
  assert.deepEqual(filter("stok maksimal 5"), { op: "lte", value: 5 });
  assert.deepEqual(filter("barang di atas 100"), { op: "gt", value: 100 });
  assert.deepEqual(filter("stok minimal 50 kg"), { op: "gte", value: 50, unit: "kg" });
  assert.deepEqual(filter("stok sama dengan 12"), { op: "eq", value: 12 });
  assert.deepEqual(filter("stok antara 20 sampai 10"), { op: "between", min: 10, max: 20 });
  assert.deepEqual(filter("barang yang stoknya dari 1.000 hingga 2.000"), { op: "between", min: 1000, max: 2000 });
  assert.deepEqual(filter("barang kosong"), { op: "lte", value: 0 });
});

// ---------------------------------------------------------------- numbers, units, periods

test("Indonesian number words", () => {
  const cases: [string, number][] = [
    ["satu", 1], ["sepuluh", 10], ["sebelas", 11], ["dua belas", 12], ["dua puluh", 20], ["dua puluh lima", 25],
    ["seratus", 100], ["seratus dua puluh", 120], ["tiga ratus", 300], ["seribu", 1000], ["dua ribu lima ratus", 2500],
    ["lima belas ribu", 15000], ["setengah", 0.5], ["dua setengah", 2.5], ["nol", 0],
  ];
  for (const [input, expected] of cases) assert.equal(parseNumberWords(input), expected, input);
  for (const input of ["dua tiga", "puluh", "minyak", "", "belas"]) assert.equal(parseNumberWords(input), null, input);
  const phrases: [string, number][] = [["setengah lusin", 6], ["dua lusin", 24], ["2 lusin", 24], ["1 kodi", 20], ["lusin", 12], ["1.500", 1500], ["2,5", 2.5]];
  for (const [input, expected] of phrases) assert.equal(parseQuantityPhrase(input), expected, input);
  assert.deepEqual(items("tambah beras setengah lusin"), [{ product_query: "beras", quantity: 6 }]);
  assert.deepEqual(items("minyak masuk dua puluh"), [{ product_query: "minyak", quantity: 20 }]);
  assert.deepEqual(items("gula keluar seratus"), [{ product_query: "gula", quantity: 100 }]);
  assert.deepEqual(items("tambah minyak 2 lusin"), [{ product_query: "minyak", quantity: 24 }]);
  // A number word inside a product name stays in the name when a quantity follows.
  assert.deepEqual(items("tambah semen tiga roda 5"), [{ product_query: "semen tiga roda", quantity: 5 }]);
});

test("units: aliases, conversions, and refusals", () => {
  assert.equal(canonicalUnit("Kilo"), "kg");
  assert.equal(canonicalUnit("ltr"), "liter");
  assert.equal(canonicalUnit("dos"), "dus");
  assert.equal(canonicalUnit("boks"), "box");
  assert.equal(canonicalUnit("pak"), "pack");
  assert.equal(unitFactor("gram", "kg"), 0.001);
  assert.equal(unitFactor("kg", "gram"), 1000);
  assert.equal(unitFactor("ml", "liter"), 0.001);
  assert.equal(unitFactor("pcs", "botol"), 1, "generic pieces fit any counted product");
  assert.equal(unitFactor("kg", "botol"), null);
  assert.equal(unitFactor("dus", "botol"), null, "package content is unknown");
  assert.equal(unitFactor("pcs", "kg"), null);
  assert.deepEqual(splitTrailingQuantity("minyak goreng 2 liter 20 botol"), { query: "minyak goreng 2 liter", quantity: { quantity: 20, unit: "botol" } });
  assert.deepEqual(parseQuantityReply("20"), { quantity: 20, unit: null });
  assert.deepEqual(parseQuantityReply("dua puluh botol"), { quantity: 20, unit: "botol" });
  assert.deepEqual(parseQuantityReply("500 gram"), { quantity: 500, unit: "gram" });
  for (const input of ["-5", "+5", "beras 20", "banyak", ""]) assert.equal(parseQuantityReply(input), null, input);
});

test("periods: extraction and resolution against a fixed date", () => {
  const today = { year: 2026, month: 9, day: 27 }; // a Sunday
  const resolve = (input: string) => {
    const found = extractPeriod(input);
    return found ? resolvePeriod(found.period, today) : null;
  };
  assert.deepEqual(extractPeriod("barang masuk kemarin"), { rest: "barang masuk", period: { kind: "yesterday" } });
  assert.deepEqual(resolve("hari ini")?.start, today);
  assert.deepEqual(resolve("kemarin")?.start, { year: 2026, month: 9, day: 26 });
  assert.deepEqual([resolve("minggu ini")?.start, resolve("minggu ini")?.end], [{ year: 2026, month: 9, day: 21 }, today]);
  assert.deepEqual([resolve("minggu lalu")?.start, resolve("minggu lalu")?.end], [{ year: 2026, month: 9, day: 14 }, { year: 2026, month: 9, day: 20 }]);
  assert.deepEqual(resolve("bulan ini")?.start, { year: 2026, month: 9, day: 1 });
  assert.deepEqual([resolve("bulan lalu")?.start, resolve("bulan lalu")?.end], [{ year: 2026, month: 8, day: 1 }, { year: 2026, month: 8, day: 31 }]);
  assert.deepEqual(resolve("7 hari terakhir")?.start, { year: 2026, month: 9, day: 21 });
  assert.deepEqual([resolve("tanggal 1 sampai 15")?.start, resolve("tanggal 1 sampai 15")?.end], [{ year: 2026, month: 9, day: 1 }, { year: 2026, month: 9, day: 15 }]);
  assert.deepEqual([resolve("1/8 - 10/8")?.start, resolve("1/8 - 10/8")?.end], [{ year: 2026, month: 8, day: 1 }, { year: 2026, month: 8, day: 10 }]);
  assert.deepEqual(resolve("1 - 5 agustus 2025")?.end, { year: 2025, month: 8, day: 5 });
  assert.deepEqual(resolve("tanggal 5")?.start, { year: 2026, month: 9, day: 5 });
  assert.equal(resolve("tanggal 31/2"), null, "an impossible date is refused");
  assert.equal(resolve("tanggal 15 sampai 1"), null, "a reversed range is refused");
  // A bare "10 sampai 20" is a number range, not dates.
  assert.equal(extractPeriod("stok 10 sampai 20"), null);
});

// ---------------------------------------------------------------- typos and product matching

test("typo tolerance corrects command words only", () => {
  assert.equal(editDistance("minyak", "mnyak"), 1);
  assert.equal(editDistance("stok", "sotk"), 1, "transposition counts once");
  assert.equal(intentOf("riwayt minyak"), "TRANSACTION_HISTORY");
  assert.deepEqual(items("tambh gula 10"), [{ product_query: "gula", quantity: 10 }]);
  assert.deepEqual(items("kurngi gula 2"), [{ product_query: "gula", quantity: 2 }]);
  assert.equal(intentOf("bantaun"), "HELP");
  // A product name that resembles a command word is never bent into a stock change.
  assert.equal(intentOf("kecap masak 5"), "SEARCH_PRODUCT");
  assert.equal(intentOf("gula masak"), "SEARCH_PRODUCT");
  assert.equal(analyzeMessage("tambh gula 10").corrected, true);
  assert.ok(analyzeMessage("tambh gula 10").confidence < analyzeMessage("tambah gula 10").confidence);
});

test("product scoring tolerates small typos and word order, not unrelated words", () => {
  assert.ok(productScore("mnyak goreng", "Minyak Goreng 1L", "BRG0006") > 0.6);
  assert.ok(productScore("goreng minyak", "Minyak Goreng 1L", "BRG0006") >= 0.9);
  assert.ok(productScore("brg0006", "Minyak Goreng 1L", "BRG0006") === 1);
  assert.equal(productScore("sabun", "Minyak Goreng 1L", "BRG0006"), 0);
  assert.equal(productScore("gla", "Gula Pasir", "BRG0010"), 0, "three letters are too short to guess");
});

// ---------------------------------------------------------------- flat result

test("analyzeMessage exposes the fields a caller needs", () => {
  const add = analyzeMessage("tambah beras 5 kg");
  assert.equal(add.intent, "ADD_STOCK");
  assert.equal(add.productQuery, "beras");
  assert.equal(add.quantity, 5);
  assert.equal(add.unit, "kg");
  assert.equal(add.targetStock, null);
  assert.equal(add.requiresConfirmation, true);
  assert.deepEqual(add.missingFields, []);

  const set = analyzeMessage("stok minyak sekarang 25");
  assert.equal(set.targetStock, 25);
  assert.equal(set.quantity, null);
  assert.equal(set.requiresConfirmation, true);

  assert.deepEqual(analyzeMessage("minyak masuk").missingFields, ["quantity"]);
  assert.deepEqual(analyzeMessage("barang masuk").missingFields, ["product", "quantity"]);
  assert.deepEqual(analyzeMessage("cek stok").missingFields, ["product"]);

  const check = analyzeMessage("stok brg0006");
  assert.equal(check.sku, "BRG0006");
  assert.equal(check.requiresConfirmation, false);
  assert.deepEqual(analyzeMessage("transaksi hari ini").period, { kind: "today" });
  assert.deepEqual(analyzeMessage("stok kurang dari 5 pcs").filter, { op: "lt", value: 5, unit: "pcs" });
  assert.equal(analyzeMessage("apa kabar").confidence, 0);
  assert.ok(analyzeMessage("minyak goreng").confidence < analyzeMessage("cari minyak goreng").confidence, "a bare phrase is a weaker guess");
  // Read-only intents never require confirmation.
  for (const input of ["stok minyak", "riwayat minyak", "barang di bawah 10", "produk terlaris"]) {
    assert.equal(analyzeMessage(input).requiresConfirmation, false, input);
  }
});

test("help topics: typed examples do what the help says", () => {
  const expected: Record<string, StructuredIntent["intent"][]> = {
    stock: ["CHECK_STOCK", "CHECK_STOCK", "CHECK_STOCK", "SEARCH_PRODUCT", "STOCK_FILTER", "STOCK_FILTER"],
    update: ["ADD_STOCK", "ADD_STOCK", "REDUCE_STOCK", "REDUCE_STOCK", "SET_STOCK", "ADD_STOCK"],
    report: ["TRANSACTION_HISTORY", "TRANSACTION_HISTORY", "TRANSACTION_HISTORY", "STOCK_ANALYSIS", "STOCK_ANALYSIS"],
  };
  for (const [topic, intents] of Object.entries(expected)) {
    assert.deepEqual(HELP_TOPICS[topic as keyof typeof HELP_TOPICS].examples.map(intentOf), intents, topic);
  }
  const topics: [string, string][] = [
    ["cara update stok", "update"], ["bantuan stock opname", "opname"], ["cara cek stok", "stock"], ["bantuan laporan", "report"], ["gimana cara stock opname", "opname"],
  ];
  for (const [input, topic] of topics) assert.deepEqual(parseRuleIntent(input), { intent: "HELP", product_query: null, quantity: null, topic }, input);
});
