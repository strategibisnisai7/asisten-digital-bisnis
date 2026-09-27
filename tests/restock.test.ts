import assert from "node:assert/strict";
import { test } from "node:test";
import type { StokItem } from "../lib/google-sheets/stok";
import { buildRestockRecommendations, parseMasterItemSuppliers } from "../lib/restock/restock-service";
import type { Supplier } from "../lib/supplier/supplier-service";
import { restockReply } from "../lib/telegram/formatting";
import type { UrlButton } from "../lib/telegram/types";

const stock = (sku: string, name: string, current: number, minimum: number | null, supplier = ""): StokItem => ({
  rowNumber: 2, sku, namaBarang: name, satuan: "kg", stokAwal: current,
  barangMasuk: 0, barangKeluar: 0, adjustment: 0, stokAkhir: current, stokMinimum: minimum,
  statusStok: "", lokasiRak: "", supplierUtama: supplier,
});

const suppliers: Supplier[] = [
  { code: "SUP-1", name: "Supplier Satu", city: "Malang", contact: "081234567890", note: "", whatsapp: "6281234567890" },
  { code: "SUP-2", name: "Supplier Dua", city: "Batu", contact: "-", note: "", whatsapp: null },
];

test("Master Barang supplier fields are read by header name", () => {
  assert.deepEqual(parseMasterItemSuppliers([
    ["Nama Barang", "Kode Supplier", "SKU", "Supplier Utama"],
    ["Gula", "SUP-1", "SKU-1", "Supplier Satu"],
  ]), [{ sku: "SKU-1", supplierName: "Supplier Satu", supplierCode: "SUP-1" }]);
  assert.deepEqual(parseMasterItemSuppliers([["Nama Barang"], ["Gula"]]), []);
});

test("restock recommendations include equality, exact need, and supplier contact without inventing data", async () => {
  const recommendations = await buildRestockRecommendations({
    readStock: async () => [
      stock("SKU-1", "Gula", 8, 10),
      stock("SKU-2", "Beras", 5, 5),
      stock("SKU-3", "Minyak", 20, 10, "Supplier Satu"),
      stock("SKU-4", "Tanpa Minimum", 0, null),
    ],
    readMasterItems: async () => [
      { sku: "SKU-1", supplierName: "Supplier Satu", supplierCode: "SUP-1" },
      { sku: "SKU-2", supplierName: "Supplier Dua", supplierCode: "SUP-2" },
    ],
    readSuppliers: async () => suppliers,
  });
  assert.deepEqual(recommendations.map((item) => [item.sku, item.recommendedQuantity, item.supplierName, item.supplierWhatsapp]), [
    ["SKU-1", 2, "Supplier Satu", "6281234567890"],
    ["SKU-2", 0, "Supplier Dua", null],
  ]);
});

test("restock Telegram output warns at the minimum and links only valid WhatsApp contacts", async () => {
  const recommendations = await buildRestockRecommendations({
    readStock: async () => [stock("SKU-1", "Gula", 8, 10), stock("SKU-2", "Beras", 5, 5)],
    readMasterItems: async () => [
      { sku: "SKU-1", supplierName: "Supplier Satu", supplierCode: "SUP-1" },
      { sku: "SKU-2", supplierName: "Supplier Dua", supplierCode: "SUP-2" },
    ],
    readSuppliers: async () => suppliers,
  });
  const reply = restockReply(recommendations, { chatId: 42, secret: "test-secret" });
  assert.match(reply.text, /Gula[\s\S]*Rekomendasi: 2 kg[\s\S]*Supplier: Supplier Satu/);
  assert.match(reply.text, /Beras[\s\S]*Rekomendasi: 0 \(sudah tepat di batas minimum\)[\s\S]*Kontak WhatsApp belum tersedia/);
  assert.ok(reply.reply_markup && "inline_keyboard" in reply.reply_markup);
  const links = reply.reply_markup.inline_keyboard.flat().filter((button): button is UrlButton => "url" in button);
  assert.deepEqual(links, [{ text: "💬 Hubungi Supplier Satu", url: "https://wa.me/6281234567890" }]);
});
