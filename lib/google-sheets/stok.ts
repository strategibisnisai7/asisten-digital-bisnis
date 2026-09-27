import { GoogleSheetsError } from "./errors";

export const STOK_HEADERS = [
  "SKU", "Nama Barang", "Satuan", "Stok Awal", "Barang Masuk", "Barang Keluar",
  "Adjustment", "Stok Akhir", "Stok Minimum", "Status Stok", "Lokasi Rak", "Supplier Utama",
] as const;

export interface StokItem {
  rowNumber: number;
  sku: string;
  namaBarang: string;
  satuan: string;
  stokAwal: number;
  barangMasuk: number;
  barangKeluar: number;
  adjustment: number;
  stokAkhir: number;
  stokMinimum: number | null;
  statusStok: string;
  lokasiRak: string;
  supplierUtama: string;
}

function cellText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function numberCell(value: unknown, row: number, column: string, blank: number | null): number | null {
  if (cellText(value) === "") return blank;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  throw new GoogleSheetsError("SCHEMA", `Nilai numerik tidak valid pada Stok!${column}${row}. Periksa isi sel atau rumus.`);
}

export function parseStokRows(values: unknown[][]): StokItem[] {
  const header = values[0] ?? [];
  const mismatch = STOK_HEADERS.findIndex((expected, index) => cellText(header[index]).toLowerCase() !== expected.toLowerCase());
  if (mismatch !== -1) {
    throw new GoogleSheetsError("SCHEMA", `Header Stok!${String.fromCharCode(65 + mismatch)}1 harus ${STOK_HEADERS[mismatch]}. Header diharapkan berada pada baris 1.`);
  }

  const items: StokItem[] = [];
  const skus = new Set<string>();
  for (let index = 1; index < values.length; index++) {
    const row = values[index];
    const rowNumber = index + 1;
    // Ignore unused template rows even when H/J contain prefilled formulas.
    if ([0, 1, 2, 3, 4, 5, 6, 8, 10, 11].every((column) => cellText(row[column]) === "")) continue;
    const sku = cellText(row[0]);
    if (!sku || !cellText(row[1])) {
      throw new GoogleSheetsError("SCHEMA", `SKU dan Nama Barang wajib diisi pada baris Stok ${rowNumber}.`);
    }
    if (skus.has(sku)) {
      throw new GoogleSheetsError("SCHEMA", `SKU duplikat pada baris Stok ${rowNumber}. Periksa kolom A.`);
    }
    skus.add(sku);
    const stokAkhir = numberCell(row[7], rowNumber, "H", null);
    if (stokAkhir === null) {
      throw new GoogleSheetsError("SCHEMA", `Stok!H${rowNumber} kosong. Isi rumus Stok Awal + Barang Masuk - Barang Keluar + Adjustment di spreadsheet.`);
    }
    items.push({
      rowNumber, sku, namaBarang: cellText(row[1]), satuan: cellText(row[2]),
      stokAwal: numberCell(row[3], rowNumber, "D", 0)!,
      barangMasuk: numberCell(row[4], rowNumber, "E", 0)!,
      barangKeluar: numberCell(row[5], rowNumber, "F", 0)!,
      adjustment: numberCell(row[6], rowNumber, "G", 0)!,
      // Read the calculated Sheets value; do not replace the source of truth.
      stokAkhir,
      stokMinimum: numberCell(row[8], rowNumber, "I", null),
      statusStok: cellText(row[9]), lokasiRak: cellText(row[10]), supplierUtama: cellText(row[11]),
    });
  }
  return items;
}
