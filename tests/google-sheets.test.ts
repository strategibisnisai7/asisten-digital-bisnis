import assert from "node:assert/strict";
import { test } from "node:test";
import { getGoogleSheetsConfig } from "../lib/google-sheets/config";
import { GoogleSheetsError, sanitizeGoogleSheetsError } from "../lib/google-sheets/errors";
import { parseStokRows, STOK_HEADERS } from "../lib/google-sheets/stok";

const exampleRow = ["SKU-001", "Kopi", "pak", 10, 5, 3, -2, 10, 4, "Aman", "A1", "Supplier A"];

test("maps all twelve columns and preserves the sheet's Stok Akhir", () => {
  const [item] = parseStokRows([[...STOK_HEADERS], [...exampleRow.slice(0, 7), 99, ...exampleRow.slice(8)]]);
  assert.deepEqual(item, {
    rowNumber: 2, sku: "SKU-001", namaBarang: "Kopi", satuan: "pak",
    stokAwal: 10, barangMasuk: 5, barangKeluar: 3, adjustment: -2,
    stokAkhir: 99, stokMinimum: 4, statusStok: "Aman", lokasiRak: "A1", supplierUtama: "Supplier A",
  });
});

test("keeps decimal and negative quantities; handles omitted optional cells", () => {
  const [item] = parseStokRows([[...STOK_HEADERS], ["001", "Kopi", "kg", "1.5", "", 2, -0.25, -0.75]]);
  assert.equal(item.sku, "001");
  assert.equal(item.stokAwal, 1.5);
  assert.equal(item.barangMasuk, 0);
  assert.equal(item.stokAkhir, -0.75);
  assert.equal(item.stokMinimum, null);
  assert.equal(item.supplierUtama, "");
});

test("ignores blank and formula-only template rows while preserving row numbers", () => {
  const items = parseStokRows([[...STOK_HEADERS], [], ["", "", "", "", "", "", "", 0, "", "Habis"], exampleRow]);
  assert.equal(items.length, 1);
  assert.equal(items[0].rowNumber, 4);
  assert.deepEqual(parseStokRows([[...STOK_HEADERS]]), []);
});

test("rejects missing or reordered headers before mapping inventory", () => {
  assert.throws(() => parseStokRows([]), /Header Stok!A1/);
  const headers: string[] = [...STOK_HEADERS];
  [headers[4], headers[5]] = [headers[5], headers[4]];
  assert.throws(() => parseStokRows([headers, exampleRow]), /Header Stok!E1/);
});

test("rejects formula errors, ambiguous formatted numbers, and missing totals", () => {
  for (const value of ["#REF!", "1,234", true, Infinity, ""]) {
    const row = [...exampleRow];
    const invalidRow: unknown[] = row;
    invalidRow[7] = value;
    assert.throws(() => parseStokRows([[...STOK_HEADERS], invalidRow]), GoogleSheetsError);
  }
});

test("rejects missing and duplicate SKUs", () => {
  assert.throws(() => parseStokRows([[...STOK_HEADERS], ["", "Kopi"]]), /SKU dan Nama Barang/);
  assert.throws(() => parseStokRows([[...STOK_HEADERS], exampleRow, exampleRow]), /SKU duplikat/);
});

test("reports missing env names without leaking configured secrets", () => {
  assert.throws(() => getGoogleSheetsConfig({ GOOGLE_SHEETS_PRIVATE_KEY: "secret-sentinel" }), (error: unknown) => {
    assert.ok(error instanceof GoogleSheetsError);
    assert.equal(error.code, "CONFIG");
    assert.match(error.message, /GOOGLE_SHEETS_CLIENT_EMAIL/);
    assert.doesNotMatch(error.message, /secret-sentinel/);
    return true;
  });
});

test("normalizes escaped PEM newlines and validates configuration", () => {
  const env = {
    GOOGLE_SHEETS_SPREADSHEET_ID: "example_id",
    GOOGLE_SHEETS_CLIENT_EMAIL: "test@example.iam.gserviceaccount.com",
    // Deliberately fake fixture; no real key is used by unit tests.
    GOOGLE_SHEETS_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nFAKE\\n-----END PRIVATE KEY-----",
  };
  assert.ok(getGoogleSheetsConfig(env).privateKey.includes("\nFAKE\n"));
  assert.throws(() => getGoogleSheetsConfig({ ...env, GOOGLE_SHEETS_SPREADSHEET_ID: "https://example.com" }), /ID, bukan URL/);
  assert.throws(() => getGoogleSheetsConfig({ ...env, GOOGLE_SHEETS_PRIVATE_KEY: "secret-sentinel" }), /PEM lengkap/);
});

test("sanitizes Google errors without retaining requests or credentials", () => {
  for (const [status, code] of [[401, "AUTH"], [403, "ACCESS"], [404, "NOT_FOUND"], [429, "API"], [500, "API"]] as const) {
    const safe = sanitizeGoogleSheetsError({ response: { status }, message: "secret-sentinel", config: { private_key: "secret-sentinel" } });
    assert.equal(safe.code, code);
    assert.doesNotMatch(String(safe) + JSON.stringify(safe), /secret-sentinel/);
    assert.equal(safe.cause, undefined);
  }
});
