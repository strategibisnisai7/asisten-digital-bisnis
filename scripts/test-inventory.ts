import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { GoogleSheetsError } from "../lib/google-sheets/errors";
import { readStok } from "../lib/google-sheets/service";
import { executeInventoryIntent } from "../lib/inventory/inventory-engine";
import { parseRuleIntent } from "../lib/parser/rule-parser";

let phase = "configuration";
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

async function main() {
  if (process.env.NODE_ENV === "test") {
    throw new GoogleSheetsError("CONFIG", "Jalankan test:inventory tanpa NODE_ENV=test agar konfigurasi development dimuat.");
  }
  loadEnvConfig(process.cwd(), true);

  phase = "read source inventory";
  const source = await readStok();
  assert.ok(source.length > 0, "Spreadsheet harus memiliki barang untuk test integrasi ini.");
  const matching = (query: string) => source.filter((item) => normalize(item.sku).includes(query) || normalize(item.namaBarang).includes(query));
  const unique = source.find((item) => matching(normalize(item.sku)).length === 1);
  assert.ok(unique, "Dibutuhkan satu SKU dengan hasil pencarian tunggal untuk test CHECK_STOCK.");

  phase = "CHECK_STOCK";
  const stock = await executeInventoryIntent({ intent: "CHECK_STOCK", product_query: unique.sku.toLowerCase(), quantity: null });
  assert.ok(stock.status === "SUCCESS" && "product" in stock);
  assert.deepEqual(stock.product, {
    sku: unique.sku, name: unique.namaBarang, unit: unique.satuan,
    currentStock: unique.stokAkhir, minimumStock: unique.stokMinimum,
    status: unique.statusStok, rack: unique.lokasiRak, supplier: unique.supplierUtama,
  });
  console.log("PASS: CHECK_STOCK sesuai dengan data sumber Google Sheets.");

  phase = "SEARCH_PRODUCT";
  // Prefer a partial query with multiple matches, deriving it from live data.
  const queries = source.flatMap((item) => [normalize(item.namaBarang).split(" ")[0], normalize(item.sku).slice(0, 2)]);
  const query = queries.find((candidate) => candidate.length > 0 && matching(candidate).length > 1) ?? normalize(unique.namaBarang);
  const search = await executeInventoryIntent({ intent: "SEARCH_PRODUCT", product_query: query.toUpperCase(), quantity: null });
  assert.ok(search.status === "SUCCESS" && "products" in search);
  assert.deepEqual(search.products.map((item) => item.sku), matching(query).map((item) => item.sku));
  console.log(`PASS: SEARCH_PRODUCT mengembalikan ${search.products.length} kandidat sesuai pencarian parsial.`);

  phase = "LOW_STOCK through parser";
  const low = await executeInventoryIntent(parseRuleIntent("barang apa yang hampir habis"));
  assert.ok(low.status === "SUCCESS" && "products" in low);
  assert.deepEqual(low.products.map((item) => item.sku), source.filter((item) => item.stokMinimum !== null && item.stokAkhir <= item.stokMinimum).map((item) => item.sku));
  console.log(`PASS: LOW_STOCK mengembalikan ${low.products.length} barang sesuai batas minimum.`);

  phase = "NOT_FOUND through parser";
  const missing = await executeInventoryIntent(parseRuleIntent(`cari test-missing-${randomUUID()}`));
  assert.equal(missing.status, "NOT_FOUND");
  console.log("PASS: produk tidak ditemukan memiliki status NOT_FOUND.");
  console.log(`BERHASIL: integrasi inventory terhadap ${source.length} barang. Semua operasi hanya membaca.`);
}

main().catch((error: unknown) => {
  // Assertion errors can contain live records, so never print the error object.
  console.error(error instanceof GoogleSheetsError
    ? `[${error.code}] ${error.message}`
    : `Test integrasi inventory gagal pada tahap ${phase}. Detail data tidak ditampilkan; periksa perubahan data sumber atau hasil engine.`);
  process.exitCode = 1;
});
