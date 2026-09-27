import assert from "node:assert/strict";
import { loadEnvConfig } from "@next/env";
import { ensureTransactionSheet, TRANSACTION_HEADERS, TRANSACTION_SHEET } from "../lib/inventory/transaction-service";
import { readSheetRange } from "../lib/sheets/google-sheets";

// The spreadsheet this project is connected to; a different configured ID aborts.
const EXPECTED_SPREADSHEET_ID = "1kmZOAUUd2Nx_xYQwBYHPwDWokgMH9WTCD1ENr8Px1ak";

async function main() {
  loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
  if (process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() !== EXPECTED_SPREADSHEET_ID) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID tidak sama dengan spreadsheet yang diharapkan. Tidak ada perubahan.");
  }

  // Only adds the tab and header when missing; existing data is never touched.
  const result = await ensureTransactionSheet();
  console.log(result.sheetCreated ? `Tab '${TRANSACTION_SHEET}' dibuat.` : `Tab '${TRANSACTION_SHEET}' sudah ada; tidak dibuat ulang.`);
  console.log(result.headerWritten ? "Header ditulis ke baris 1." : "Baris 1 sudah berisi; header tidak ditimpa.");

  const { values } = await readSheetRange(`'${TRANSACTION_SHEET}'!A1:L1`);
  const header = (values[0] ?? []).map((cell) => String(cell));
  assert.deepEqual(header, [...TRANSACTION_HEADERS], "Header di spreadsheet berbeda dari yang diharapkan.");
  console.log(`VERIFIKASI: header dibaca ulang dan sesuai (${header.length} kolom: ${header.join(" | ")}).`);
}

main().catch((error: unknown) => {
  // Sanitized service errors only; never print credentials or raw API responses.
  console.error(`Setup gagal: ${error instanceof Error ? error.message : "kesalahan tidak dikenal"}`);
  process.exitCode = 1;
});
