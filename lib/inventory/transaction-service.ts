import "server-only";
import { stokCellUpdate, type StokCellWrite } from "../google-sheets/service";
import { applyAtomicChanges, ensureSheetWithHeader, readSheetRange } from "../sheets/google-sheets";
import type { StockChangeIntent } from "../parser/intents";
import { formatDate, formatTime, jakartaDateTime, type CalendarDate } from "../time/jakarta";

export const TRANSACTION_SHEET = "Riwayat Transaksi";
export const TRANSACTION_HEADERS = [
  "ID Transaksi", "Tanggal", "Waktu", "Jenis Transaksi", "SKU", "Nama Barang",
  "Quantity", "Satuan", "Stok Sebelum", "Stok Sesudah", "User", "Keterangan",
] as const;
const ID_RANGE = `'${TRANSACTION_SHEET}'!A2:A`;
const DATA_RANGE = `'${TRANSACTION_SHEET}'!A2:L`;
export const MAX_TRANSACTION_ITEMS = 20;

export type TransactionType = StockChangeIntent;
export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  ADD_STOCK: "MASUK",
  REDUCE_STOCK: "KELUAR",
  SET_STOCK: "KOREKSI",
};

export interface TransactionItem {
  sku: string;
  productName: string;
  /** Units moved in (ADD) or out (REDUCE); for SET, the signed correction applied. */
  quantity: number;
  unit: string;
  stockBefore: number;
  stockAfter: number;
  note?: string;
}

export interface TransactionRecord extends Required<TransactionItem> {
  transactionId: string;
  date: string;
  time: string;
  type: TransactionType;
  user: string;
}

export interface TransactionInput {
  type: TransactionType;
  items: readonly TransactionItem[];
  /** The Stok cells (E/F/G) that carry this transaction. */
  stockCells: readonly StokCellWrite[];
  user: string;
  note?: string;
  at?: Date;
}

/** Storage boundary so tests never touch the production spreadsheet. */
export interface TransactionStore {
  readTransactionIds(): Promise<string[]>;
  /** Writes the stock cells and appends the history rows together, or not at all. */
  commit(stockCells: readonly StokCellWrite[], historyRows: (string | number)[][]): Promise<void>;
}

export const sheetsTransactionStore: TransactionStore = {
  async readTransactionIds() {
    const { values } = await readSheetRange(ID_RANGE);
    return values.map((row) => String(row[0] ?? ""));
  },
  async commit(stockCells, historyRows) {
    await applyAtomicChanges(stockCells.map(stokCellUpdate), { sheetTitle: TRANSACTION_SHEET, rows: historyRows });
  },
};

/** Creates the history tab and header when missing; never overwrites existing data. */
export function ensureTransactionSheet() {
  return ensureSheetWithHeader(TRANSACTION_SHEET, TRANSACTION_HEADERS);
}

/** TRX-001, TRX-002, ... continuing after the highest existing number. */
export function nextTransactionId(existingIds: readonly string[]): string {
  let highest = 0;
  for (const id of existingIds) {
    const match = id.trim().match(/^TRX-(\d+)$/);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `TRX-${String(highest + 1).padStart(3, "0")}`;
}

function validate(input: TransactionInput): void {
  if (!(input.type in TRANSACTION_TYPE_LABELS)) throw new Error("Jenis transaksi tidak dikenal.");
  if (!input.items.length || input.items.length > MAX_TRANSACTION_ITEMS) {
    throw new Error(`Transaksi harus berisi 1–${MAX_TRANSACTION_ITEMS} barang.`);
  }
  for (const item of input.items) {
    if (!item.sku.trim() || ![item.quantity, item.stockBefore, item.stockAfter].every(Number.isFinite)) {
      throw new Error("Data barang pada transaksi tidak valid.");
    }
  }
  // Every stock change must be recorded, and nothing is recorded without a change.
  if (input.stockCells.length !== input.items.length) throw new Error("Setiap barang harus memiliki satu perubahan stok.");
}

/** One action produces one row per item, all sharing the same transaction ID. */
export function buildTransactionRecords(input: Omit<TransactionInput, "stockCells">, transactionId: string): TransactionRecord[] {
  const moment = jakartaDateTime(input.at ?? new Date());
  return input.items.map((item) => ({
    transactionId, date: formatDate(moment), time: formatTime(moment), type: input.type,
    sku: item.sku, productName: item.productName, quantity: item.quantity, unit: item.unit,
    stockBefore: item.stockBefore, stockAfter: item.stockAfter,
    user: input.user, note: item.note ?? input.note ?? "",
  }));
}

export function transactionRow(record: TransactionRecord): (string | number)[] {
  return [
    record.transactionId, record.date, record.time, TRANSACTION_TYPE_LABELS[record.type], record.sku,
    record.productName, record.quantity, record.unit, record.stockBefore, record.stockAfter, record.user, record.note,
  ];
}

/**
 * The only way stock changes are saved: the Stok cells and the history rows go out in
 * one atomic request, so stock never changes without a history entry. The ID is the
 * next sequence number; two actions saved at the very same moment could share one.
 */
export async function recordTransaction(
  input: TransactionInput,
  store: TransactionStore = sheetsTransactionStore,
): Promise<{ transactionId: string; records: TransactionRecord[] }> {
  validate(input);
  const transactionId = nextTransactionId(await store.readTransactionIds());
  const records = buildTransactionRecords(input, transactionId);
  await store.commit(input.stockCells, records.map(transactionRow));
  return { transactionId, records };
}

// ---------------------------------------------------------------- reading the history

export interface TransactionEntry {
  rowNumber: number;
  transactionId: string;
  date: CalendarDate | null;
  /** Seconds since midnight, for ordering. */
  seconds: number;
  dateText: string;
  timeText: string;
  type: TransactionType | null;
  typeLabel: string;
  sku: string;
  productName: string;
  quantity: number;
  unit: string;
  stockBefore: number;
  stockAfter: number;
  user: string;
  note: string;
}

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const pad = (value: number) => String(value).padStart(2, "0");

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const clean = text(value).replace(",", ".");
  return clean && /^[+-]?\d+(?:\.\d+)?$/.test(clean) ? Number(clean) : Number.NaN;
}

function parseType(value: string): TransactionType | null {
  const label = value.toUpperCase().replace(/\s+/g, " ");
  if (/^(?:MASUK|BARANG MASUK|ADD_STOCK)$/.test(label)) return "ADD_STOCK";
  if (/^(?:KELUAR|BARANG KELUAR|REDUCE_STOCK)$/.test(label)) return "REDUCE_STOCK";
  if (/^(?:KOREKSI|KOREKSI STOK|SET_STOCK|ADJUSTMENT)$/.test(label)) return "SET_STOCK";
  return null;
}

// Accepts 27/09/2026, 2026-09-27, or a Sheets date serial number.
function parseDate(value: unknown): CalendarDate | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }
  const raw = text(value);
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const [year, month, day] = dmy ? [dmy[3], dmy[2], dmy[1]].map(Number) : ymd ? [ymd[1], ymd[2], ymd[3]].map(Number) : [];
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

// Accepts 10:15, 10:15:30, or a Sheets time fraction.
function parseSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round((value % 1) * 86_400);
  const match = text(value).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0) : 0;
}

/** Maps Riwayat Transaksi rows (from row 2) to entries; blank rows are skipped. */
export function parseTransactionRows(values: readonly unknown[][]): TransactionEntry[] {
  const entries: TransactionEntry[] = [];
  values.forEach((row, index) => {
    if (row.every((cell) => text(cell) === "")) return;
    const date = parseDate(row[1]);
    const seconds = parseSeconds(row[2]);
    const typeLabel = text(row[3]);
    const type = parseType(typeLabel);
    entries.push({
      rowNumber: index + 2,
      transactionId: text(row[0]),
      date,
      seconds,
      dateText: date ? formatDate(date) : text(row[1]),
      timeText: typeof row[2] === "number" ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}` : text(row[2]),
      type,
      typeLabel: type ? TRANSACTION_TYPE_LABELS[type] : typeLabel,
      sku: text(row[4]),
      productName: text(row[5]),
      quantity: toNumber(row[6]),
      unit: text(row[7]),
      stockBefore: toNumber(row[8]),
      stockAfter: toNumber(row[9]),
      user: text(row[10]),
      note: text(row[11]),
    });
  });
  return entries;
}

export async function readTransactions(): Promise<TransactionEntry[]> {
  const { values } = await readSheetRange(DATA_RANGE);
  return parseTransactionRows(values);
}
