import assert from "node:assert/strict";
import { test } from "node:test";
import { executeInventoryIntent } from "../lib/inventory/inventory-engine";
import type { StokItem } from "../lib/google-sheets/stok";
import {
  findSupplier, parseMasterSupplierCodes, parseSupplierRows, prepareSupplierRequest, type SupplierDirectory,
} from "../lib/supplier/supplier-service";
import { normalizeWhatsAppNumber, whatsappLink } from "../lib/supplier/whatsapp";

// Fixtures modelled on the Supplier and Master Barang tabs; no real sheet is read.
const supplierValues = [
  ["Kode Supplier", "Nama Supplier", "Kota", "Kontak", "Keterangan"],
  ["SUP001", "PT Sumber Makmur", "Malang", "083472087316", "Supplier aktif"],
  ["SUP002", "CV Berkah Jaya", "Malang", "-", "Supplier aktif"],
  ["", "", "", "", ""],
];
const masterValues = [
  ["SKU", "Nama Barang", "Kategori", "Satuan", "Supplier Utama", "Kode Supplier"],
  ["BRG0001", "Beras Premium 5kg", "Sembako", "kg", "CV Berkah Jaya", "SUP002"],
  ["BRG0003", "Gula Pasir 1kg", "Sembako", "kg", "PT Sumber Makmur", "SUP001"],
];
const directory: SupplierDirectory = { suppliers: parseSupplierRows(supplierValues), supplierCodeBySku: parseMasterSupplierCodes(masterValues) };
const stock: StokItem[] = [
  ["BRG0001", "Beras Premium 5kg", "CV Berkah Jaya"], ["BRG0003", "Gula Pasir 1kg", "PT Sumber Makmur"], ["BRG0009", "Kopi Lokal", "UD Baru"],
].map(([sku, namaBarang, supplierUtama], i) => ({
  rowNumber: i + 2, sku, namaBarang, satuan: "kg", stokAwal: 5, barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: 5,
  stokMinimum: 1, statusStok: "", lokasiRak: "", supplierUtama,
}));
const execute = ((intent) => executeInventoryIntent(intent, async () => stock)) as typeof executeInventoryIntent;

test("WhatsApp numbers are normalized to the wa.me format", () => {
  assert.equal(normalizeWhatsAppNumber("083472087316"), "6283472087316");
  assert.equal(normalizeWhatsAppNumber("+62 834-7208-7316"), "6283472087316");
  assert.equal(normalizeWhatsAppNumber("6283472087316"), "6283472087316");
  assert.equal(normalizeWhatsAppNumber("83472087316"), "6283472087316");
  for (const invalid of ["", "-", "12345", "0341-123", "email@contoh.id"]) assert.equal(normalizeWhatsAppNumber(invalid), null, invalid);
});

test("WhatsApp deep links carry the URL-encoded message and never send by themselves", () => {
  assert.equal(whatsappLink("6283472087316", "Halo & terima kasih\n• Gula — 30 kg"),
    "https://wa.me/6283472087316?text=Halo%20%26%20terima%20kasih%0A%E2%80%A2%20Gula%20%E2%80%94%2030%20kg");
  assert.equal(whatsappLink(null, "Halo"), "https://wa.me/?text=Halo");
});

test("supplier and master rows are read by header name", () => {
  assert.deepEqual(directory.suppliers.map((s) => [s.code, s.name, s.city, s.whatsapp]), [
    ["SUP001", "PT Sumber Makmur", "Malang", "6283472087316"],
    ["SUP002", "CV Berkah Jaya", "Malang", null],
  ]);
  assert.equal(directory.supplierCodeBySku.get("BRG0003"), "SUP001");
  assert.deepEqual(parseSupplierRows([["Kolom Lain"], ["x"]]), []);
});

test("a product's supplier comes from its Kode Supplier, then from the supplier name", () => {
  const product = (sku: string, supplier: string) => ({ sku, name: "x", unit: "kg", currentStock: 1, minimumStock: 1, status: "", rack: "", supplier });
  assert.equal(findSupplier(product("BRG0003", "Nama Lama"), directory)?.code, "SUP001");
  assert.equal(findSupplier(product("BRG0099", "cv berkah jaya"), directory)?.code, "SUP002");
  assert.equal(findSupplier(product("BRG0099", "UD Baru"), directory), null);
});

test("requests are grouped per supplier and duplicate items are added up", async () => {
  const request = await prepareSupplierRequest([
    { product_query: "gula", quantity: 20 }, { product_query: "beras", quantity: 5 }, { product_query: "brg0003", quantity: 10 }, { product_query: "kopi", quantity: 2 },
  ], { execute, readDirectory: async () => directory });
  assert.equal(request.status, "READY");
  assert.ok(request.status === "READY");
  assert.deepEqual(request.groups.map((group) => [group.supplierName, group.supplier?.code ?? null, group.lines.map((line) => [line.product.sku, line.quantity])]), [
    ["PT Sumber Makmur", "SUP001", [["BRG0003", 30]]],
    ["CV Berkah Jaya", "SUP002", [["BRG0001", 5]]],
    ["UD Baru", null, [["BRG0009", 2]]],
  ]);
});

test("unknown or unclear items stop the request before any supplier is chosen", async () => {
  let directoryReads = 0;
  const readDirectory = async () => { directoryReads++; return directory; };
  assert.deepEqual(await prepareSupplierRequest([{ product_query: "sabun", quantity: 1 }], { execute, readDirectory }), { status: "NOT_FOUND", query: "sabun" });
  const ambiguous = await prepareSupplierRequest([{ product_query: "brg000", quantity: 3 }], { execute, readDirectory });
  assert.equal(ambiguous.status, "AMBIGUOUS");
  assert.equal(directoryReads, 0);
});

test("contacting a supplier only reads: the inventory engine sees read intents only", async () => {
  const seen: string[] = [];
  const spy = (async (intent) => { seen.push(intent.intent); return execute(intent); }) as (typeof executeInventoryIntent);
  await prepareSupplierRequest([{ product_query: "gula", quantity: 1 }, { product_query: "beras", quantity: 1 }], { execute: spy, readDirectory: async () => directory });
  assert.deepEqual(seen, ["CHECK_STOCK", "CHECK_STOCK"]);
});
