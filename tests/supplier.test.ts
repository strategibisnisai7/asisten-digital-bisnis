import assert from "node:assert/strict";
import { test } from "node:test";
import { findSupplierByKey, parseSupplierRows, supplierKey } from "../lib/supplier/supplier-service";
import { normalizeWhatsAppNumber, whatsappLink } from "../lib/supplier/whatsapp";
import { escapeHtml, FOOTER_TEXT, footerHtml, getStockFileUrl, stripFooter, visibleLength, withFooter } from "../lib/telegram/footer";

// Fixture modelled on the Supplier tab; no real sheet is read.
const supplierValues = [
  ["Kode Supplier", "Nama Supplier", "Kota", "Kontak", "Keterangan"],
  ["SUP001", "PT Sumber Makmur", "Malang", "083472087316", "Supplier aktif"],
  ["SUP002", "CV Berkah Jaya", "Malang", "-", "Supplier aktif"],
  ["", "UD Tanpa Kode", "Batu", "+62 812-3456-7890", ""],
  ["", "", "", "", ""],
];
const suppliers = parseSupplierRows(supplierValues);

test("WhatsApp numbers are normalized to the wa.me format", () => {
  assert.equal(normalizeWhatsAppNumber("081234567890"), "6281234567890");
  assert.equal(normalizeWhatsAppNumber("+6281234567890"), "6281234567890");
  assert.equal(normalizeWhatsAppNumber("+62 834-7208-7316"), "6283472087316");
  assert.equal(normalizeWhatsAppNumber("6283472087316"), "6283472087316");
  assert.equal(normalizeWhatsAppNumber("83472087316"), "6283472087316");
  for (const invalid of ["", "-", "12345", "0341-123", "email@contoh.id"]) assert.equal(normalizeWhatsAppNumber(invalid), null, invalid);
  assert.equal(whatsappLink("6281234567890"), "https://wa.me/6281234567890");
});

test("the Supplier tab is read by header name; empty rows are skipped", () => {
  assert.deepEqual(suppliers.map((s) => [s.code, s.name, s.city, s.contact, s.whatsapp]), [
    ["SUP001", "PT Sumber Makmur", "Malang", "083472087316", "6283472087316"],
    ["SUP002", "CV Berkah Jaya", "Malang", "-", null],
    ["", "UD Tanpa Kode", "Batu", "+62 812-3456-7890", "6281234567890"],
  ]);
  assert.deepEqual(parseSupplierRows([["Kolom Lain"], ["x"]]), []);
});

test("suppliers are addressed by code, or by position when the code is empty", () => {
  assert.deepEqual(suppliers.map(supplierKey), ["SUP001", "SUP002", "#2"]);
  assert.equal(findSupplierByKey(suppliers, "SUP002")?.name, "CV Berkah Jaya");
  assert.equal(findSupplierByKey(suppliers, "#2")?.name, "UD Tanpa Kode");
  assert.equal(findSupplierByKey(suppliers, "SUP999"), null);
  assert.equal(findSupplierByKey(suppliers, "#9"), null);
});

test("footer: escaped message, one italic link, and removed again from returned text", () => {
  assert.equal(getStockFileUrl({}), "https://tinyurl.com/faststock");
  assert.equal(getStockFileUrl({ STOCK_FILE_URL: "javascript:alert(1)" }), "https://tinyurl.com/faststock");
  assert.equal(footerHtml(), '<i>File stok XLS: <a href="https://tinyurl.com/faststock">Lihat File</a></i>');
  const html = withFooter("Gula <b>&</b> \"Minyak\"");
  assert.equal(html, 'Gula &lt;b&gt;&amp;&lt;/b&gt; &quot;Minyak&quot;\n\n<i>File stok XLS: <a href="https://tinyurl.com/faststock">Lihat File</a></i>');
  assert.equal((withFooter(`Halo\n\n${FOOTER_TEXT}`).match(/Lihat File/g) ?? []).length, 1, "never twice");
  assert.equal(stripFooter(`Halo\n\nKode: UPD-1-ABC\n\n${FOOTER_TEXT}`), "Halo\n\nKode: UPD-1-ABC");
  assert.equal(stripFooter("Tanpa footer"), "Tanpa footer");
  assert.equal(escapeHtml("<a>"), "&lt;a&gt;");
  assert.equal(visibleLength("abc"), 3 + 2 + FOOTER_TEXT.length);
});
