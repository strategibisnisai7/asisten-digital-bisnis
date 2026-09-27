import "server-only";
import { readSheetRange } from "../sheets/google-sheets";
import { normalizeWhatsAppNumber } from "./whatsapp";

// Read-only supplier directory: it never changes stock or the history.

export const SUPPLIER_SHEET = "Supplier";

export interface Supplier { code: string; name: string; city: string; contact: string; note: string; whatsapp: string | null }

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

/** Reads the Supplier tab by header name (Kode Supplier, Nama Supplier, Kota, Kontak, Keterangan). */
export function parseSupplierRows(values: readonly unknown[][]): Supplier[] {
  const [header = [], ...rows] = values;
  const names = header.map((cell) => normalize(text(cell)));
  const [code, name, city, contact, note] = ["Kode Supplier", "Nama Supplier", "Kota", "Kontak", "Keterangan"].map((label) => names.indexOf(normalize(label)));
  if (name === -1) return [];
  const cell = (row: readonly unknown[], index: number) => (index === -1 ? "" : text(row[index]));
  return rows.map((row) => ({
    code: cell(row, code), name: cell(row, name), city: cell(row, city),
    contact: cell(row, contact), note: cell(row, note), whatsapp: normalizeWhatsAppNumber(cell(row, contact)),
  })).filter((supplier) => supplier.name);
}

export async function readSuppliers(): Promise<Supplier[]> {
  const { values } = await readSheetRange(`'${SUPPLIER_SHEET}'!A1:Z`);
  return parseSupplierRows(values);
}

/** The button key of a supplier: its code, or its position when the code is empty. */
export function supplierKey(supplier: Supplier, index: number): string {
  return supplier.code || `#${index}`;
}

export function findSupplierByKey(suppliers: readonly Supplier[], key: string): Supplier | null {
  const byIndex = key.match(/^#(\d+)$/);
  if (byIndex) return suppliers[Number(byIndex[1])] ?? null;
  return suppliers.find((supplier) => supplier.code === key) ?? null;
}
