import "server-only";
import { readSheetRange, type GridCellUpdate } from "../sheets/google-sheets";
import { GoogleSheetsError } from "./errors";
import { parseStokRows, type StokItem } from "./stok";

export const STOK_SHEET = "Stok";
export const STOK_RANGE = `'${STOK_SHEET}'!A1:L`;

// Call from Node.js server code only. Each read fetches current Sheets values.
export async function readStok(): Promise<StokItem[]> {
  const { values } = await readSheetRange(STOK_RANGE);
  return parseStokRows(values);
}

/**
 * Stock movements may only touch E (Barang Masuk), F (Barang Keluar), and
 * G (Adjustment). H (Stok Akhir) is a formula and is never written. Writing goes
 * through the transaction service so every change is recorded in the history.
 */
export type StokMovementColumn = "E" | "F" | "G";
export interface StokCellWrite { rowNumber: number; column: StokMovementColumn; value: number }

const COLUMN_INDEX: Record<StokMovementColumn, number> = { E: 4, F: 5, G: 6 };

export function stokCellUpdate(write: StokCellWrite): GridCellUpdate {
  if (!Object.hasOwn(COLUMN_INDEX, write.column)) {
    throw new GoogleSheetsError("SCHEMA", "Hanya kolom Barang Masuk, Barang Keluar, dan Adjustment yang boleh diubah.");
  }
  if (!Number.isSafeInteger(write.rowNumber) || write.rowNumber < 2) {
    throw new GoogleSheetsError("SCHEMA", "Baris Stok tidak valid untuk perubahan.");
  }
  if (!Number.isFinite(write.value)) {
    throw new GoogleSheetsError("SCHEMA", "Nilai perubahan stok tidak valid.");
  }
  return { sheetTitle: STOK_SHEET, rowNumber: write.rowNumber, columnIndex: COLUMN_INDEX[write.column], value: write.value };
}
