import "server-only";
import { readSheetRange } from "../sheets/google-sheets";
import { parseStokRows, type StokItem } from "./stok";

export const STOK_RANGE = "'Stok'!A1:L";

// Call from Node.js server code only. Each read fetches current Sheets values.
export async function readStok(): Promise<StokItem[]> {
  const { values } = await readSheetRange(STOK_RANGE);
  return parseStokRows(values);
}
