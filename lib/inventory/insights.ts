/**
 * Read-only answers from the transaction history: "riwayat minyak", "barang masuk
 * kemarin", "barang paling banyak keluar minggu ini". Pure functions over the rows
 * the transaction service already reads; nothing here writes.
 */
import type { AnalysisMetric, StockChangeIntent } from "../parser/intents";
import { inPeriod, resolvePeriod, type PeriodSpec, type ResolvedPeriod } from "../parser/period";
import type { CalendarDate } from "../time/jakarta";
import { matchesQuery } from "./inventory-engine";
import type { TransactionEntry } from "./transaction-service";

export interface HistoryRequest { productQuery: string | null; period: PeriodSpec | null; type: StockChangeIntent | null }

export type HistoryResult =
  | { status: "SUCCESS"; entries: TransactionEntry[]; period: ResolvedPeriod | null; request: HistoryRequest }
  | { status: "INVALID_PERIOD" };

const sortKey = (entry: TransactionEntry) =>
  entry.date ? (entry.date.year * 10_000 + entry.date.month * 100 + entry.date.day) * 100_000 + entry.seconds : 0;
const newestFirst = (a: TransactionEntry, b: TransactionEntry) => sortKey(b) - sortKey(a) || b.rowNumber - a.rowNumber;

function sameType(entry: TransactionEntry, type: StockChangeIntent | null): boolean {
  if (!type) return entry.type !== null;
  // A stock opname is a correction too.
  return type === "SET_STOCK" ? entry.type === "SET_STOCK" || entry.type === "STOCK_OPNAME" : entry.type === type;
}

/** Matching transactions, newest first. A period that cannot exist ("31/02") is refused. */
export function buildHistory(entries: readonly TransactionEntry[], request: HistoryRequest, today: CalendarDate): HistoryResult {
  const period = request.period ? resolvePeriod(request.period, today) : null;
  if (request.period && !period) return { status: "INVALID_PERIOD" };
  const found = entries
    .filter((entry) => sameType(entry, request.type))
    .filter((entry) => !period || inPeriod(entry.date, period))
    .filter((entry) => !request.productQuery || matchesQuery(request.productQuery, entry.sku, entry.productName))
    .sort(newestFirst);
  return { status: "SUCCESS", entries: found, period, request };
}

export interface AnalysisRow { sku: string; name: string; unit: string; quantity: number; count: number }

export type AnalysisResult =
  | { status: "SUCCESS"; metric: AnalysisMetric; rows: AnalysisRow[]; period: ResolvedPeriod; defaultPeriod: boolean }
  | { status: "INVALID_PERIOD" };

export const ANALYSIS_LIMIT = 5;

/**
 * Ranks products by total quantity (TOP_*) or number of transactions (FREQUENT_*)
 * for incoming or outgoing stock. Without a period, the running month is used.
 */
export function buildAnalysis(entries: readonly TransactionEntry[], metric: AnalysisMetric, periodSpec: PeriodSpec | null, today: CalendarDate): AnalysisResult {
  const period = resolvePeriod(periodSpec ?? { kind: "this_month" }, today);
  if (!period) return { status: "INVALID_PERIOD" };
  const type: StockChangeIntent = metric === "TOP_IN" || metric === "FREQUENT_IN" ? "ADD_STOCK" : "REDUCE_STOCK";
  const bySku = new Map<string, AnalysisRow>();
  for (const entry of entries) {
    if (entry.type !== type || !entry.sku || !inPeriod(entry.date, period) || !Number.isFinite(entry.quantity)) continue;
    const row = bySku.get(entry.sku) ?? { sku: entry.sku, name: entry.productName || entry.sku, unit: entry.unit, quantity: 0, count: 0 };
    row.quantity = Math.round((row.quantity + entry.quantity) * 1e6) / 1e6;
    row.count += 1;
    bySku.set(entry.sku, row);
  }
  const byQuantity = metric === "TOP_IN" || metric === "TOP_OUT";
  const rows = [...bySku.values()]
    .sort((a, b) => (byQuantity ? b.quantity - a.quantity || b.count - a.count : b.count - a.count || b.quantity - a.quantity) || a.name.localeCompare(b.name))
    .slice(0, ANALYSIS_LIMIT);
  return { status: "SUCCESS", metric, rows, period, defaultPeriod: periodSpec === null };
}
