import { loadEnvConfig } from "@next/env";
import { GoogleSheetsError } from "../lib/google-sheets/errors";
import { readStok, STOK_RANGE } from "../lib/google-sheets/service";

async function main() {
  // A live integration check, run with the same local env as next dev.
  if (process.env.NODE_ENV === "test") {
    throw new GoogleSheetsError("CONFIG", "Jalankan test:sheets tanpa NODE_ENV=test agar konfigurasi development dimuat.");
  }
  loadEnvConfig(process.cwd(), true);
  const items = await readStok();
  console.log(`BERHASIL: membaca ${STOK_RANGE}; ${items.length} barang valid.`);
  if (items.length === 0) console.log("Header valid; belum ada baris barang untuk diperiksa.");
  // Print only a summary, never raw rows, auth objects, or Google API errors.
  const mismatchCount = items.filter((item) => {
    const expected = item.stokAwal + item.barangMasuk - item.barangKeluar + item.adjustment;
    return Math.abs(item.stokAkhir - expected) > 1e-9 * Math.max(1, Math.abs(expected), Math.abs(item.stokAkhir));
  }).length;
  if (mismatchCount) {
    throw new GoogleSheetsError("SCHEMA", `${mismatchCount} baris memiliki Stok Akhir yang tidak sesuai D + E - F + G. Periksa rumus di spreadsheet.`);
  }
  console.log("Pemeriksaan nilai Stok Akhir selesai. Tidak ada data spreadsheet yang diubah.");
}

main().catch((error: unknown) => {
  console.error(error instanceof GoogleSheetsError ? `[${error.code}] ${error.message}` : "Test gagal karena kesalahan internal. Detail disembunyikan untuk melindungi credentials.");
  process.exitCode = 1;
});
