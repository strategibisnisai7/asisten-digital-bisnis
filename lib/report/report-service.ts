import "server-only";
import { getAppConfig, type AppConfig } from "../config/app";
import { readStok } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import { stockLevel } from "../inventory/inventory-engine";
import { readTransactions, type TransactionEntry } from "../inventory/transaction-service";
import { currentMonthPeriod, formatDate, formatTime, jakartaDateTime, sameMonth, type MonthPeriod } from "../time/jakarta";

export type StockStatus = "Aman" | "Menipis" | "Habis";

export interface StockRow {
  sku: string; name: string; stock: number; unit: string; minimum: number | null; status: StockStatus; rack: string;
}

export interface MovementRow {
  sku: string; name: string; unit: string;
  opening: number; incoming: number; outgoing: number; adjustment: number; closing: number;
}

export interface MovementSection { count: number; quantity: number; rows: TransactionEntry[] }

export interface MonthlyReport {
  config: AppConfig;
  period: MonthPeriod;
  /** 27/09/2026 10:15 WIB */
  generatedAt: string;
  stock: { total: number; safe: number; low: number; out: number; rows: StockRow[] };
  incoming: MovementSection;
  outgoing: MovementSection;
  movements: MovementRow[];
  /** Differences between the history and the stock sheet; reported, never corrected. */
  discrepancies: string[];
  /** No purchase records exist yet; kept empty rather than invented. */
  purchases: never[];
  /** Transactions of the period, newest first. */
  history: TransactionEntry[];
}

export interface ReportDependencies {
  now?: Date;
  readStock?: () => Promise<readonly StokItem[]>;
  readTransactions?: () => Promise<readonly TransactionEntry[]>;
  config?: AppConfig;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const sortKey = (entry: TransactionEntry) =>
  entry.date ? (entry.date.year * 10_000 + entry.date.month * 100 + entry.date.day) * 100_000 + entry.seconds : 0;

// Chronological order; rows written in the same second keep their sheet order.
function chronological(a: TransactionEntry, b: TransactionEntry): number {
  return sortKey(a) - sortKey(b) || a.rowNumber - b.rowNumber;
}

export function statusOf(item: Pick<StokItem, "stokAkhir" | "stokMinimum">): StockStatus {
  const level = stockLevel({ currentStock: item.stokAkhir, minimumStock: item.stokMinimum });
  return level === "OUT_OF_STOCK" ? "Habis" : level === "LOW" ? "Menipis" : "Aman";
}

function section(entries: readonly TransactionEntry[]): MovementSection {
  const rows = [...entries].sort(chronological);
  return { count: rows.length, quantity: round(rows.reduce((sum, entry) => sum + (Number.isFinite(entry.quantity) ? entry.quantity : 0), 0)), rows };
}

/**
 * Per product with activity in the period: opening stock is "Stok Sebelum" of its first
 * transaction in the period, and closing = opening + in − out + adjustment. The
 * history drives the numbers, so a past period is not confused with today's stock.
 */
export function computeMovements(entries: readonly TransactionEntry[], stock: readonly StokItem[], checkAgainstCurrent: boolean) {
  const bySku = new Map<string, TransactionEntry[]>();
  for (const entry of [...entries].sort(chronological)) {
    if (!entry.sku || !entry.type) continue;
    bySku.set(entry.sku, [...(bySku.get(entry.sku) ?? []), entry]);
  }
  const current = new Map(stock.map((item) => [item.sku, item]));
  const movements: MovementRow[] = [];
  const discrepancies: string[] = [];
  for (const [sku, list] of bySku) {
    const first = list[0];
    const last = list[list.length - 1];
    const sum = (type: TransactionEntry["type"], value: (entry: TransactionEntry) => number) =>
      round(list.filter((entry) => entry.type === type).reduce((total, entry) => total + (Number.isFinite(value(entry)) ? value(entry) : 0), 0));
    const incoming = sum("ADD_STOCK", (entry) => entry.quantity);
    const outgoing = sum("REDUCE_STOCK", (entry) => entry.quantity);
    const adjustment = round(
      sum("SET_STOCK", (entry) => entry.stockAfter - entry.stockBefore)
      + sum("STOCK_OPNAME", (entry) => entry.stockAfter - entry.stockBefore),
    );
    const opening = first.stockBefore;
    const closing = round(opening + incoming - outgoing + adjustment);
    const name = current.get(sku)?.namaBarang ?? first.productName;
    movements.push({ sku, name, unit: current.get(sku)?.satuan ?? first.unit, opening, incoming, outgoing, adjustment, closing });

    if (!same(closing, last.stockAfter)) {
      discrepancies.push(`${sku} ${name}: perhitungan histori ${closing}, tetapi transaksi terakhir mencatat ${last.stockAfter}.`);
    }
    const now = current.get(sku);
    if (checkAgainstCurrent && now && !same(now.stokAkhir, last.stockAfter)) {
      discrepancies.push(`${sku} ${name}: stok saat ini ${now.stokAkhir} berbeda dari histori (${last.stockAfter}); kemungkinan ada perubahan di luar Asisten Digital.`);
    }
  }
  movements.sort((a, b) => a.sku.localeCompare(b.sku));
  return { movements, discrepancies };
}

/** Builds the report for the current calendar month in Asia/Jakarta. Reads only. */
export async function buildMonthlyReport(dependencies: ReportDependencies = {}): Promise<MonthlyReport> {
  const now = dependencies.now ?? new Date();
  const period = currentMonthPeriod(now);
  const [stock, transactions] = await Promise.all([
    (dependencies.readStock ?? readStok)(),
    (dependencies.readTransactions ?? readTransactions)(),
  ]);

  const rows: StockRow[] = stock.map((item) => ({
    sku: item.sku, name: item.namaBarang, stock: item.stokAkhir, unit: item.satuan,
    minimum: item.stokMinimum, status: statusOf(item), rack: item.lokasiRak,
  }));
  const inPeriod = transactions.filter((entry) => entry.date && sameMonth(entry.date, period));
  // The period is the running month, so the latest history can be compared with today's stock.
  const { movements, discrepancies } = computeMovements(inPeriod, stock, true);
  const moment = jakartaDateTime(now);

  return {
    config: dependencies.config ?? getAppConfig(),
    period,
    generatedAt: `${formatDate(moment)} ${formatTime(moment)} WIB`,
    stock: {
      total: rows.length,
      safe: rows.filter((row) => row.status === "Aman").length,
      low: rows.filter((row) => row.status === "Menipis").length,
      out: rows.filter((row) => row.status === "Habis").length,
      rows,
    },
    incoming: section(inPeriod.filter((entry) => entry.type === "ADD_STOCK")),
    outgoing: section(inPeriod.filter((entry) => entry.type === "REDUCE_STOCK")),
    movements,
    discrepancies,
    purchases: [],
    history: [...inPeriod].sort((a, b) => chronological(b, a)),
  };
}

export function reportFileName(report: Pick<MonthlyReport, "period">): string {
  return `laporan-stok-transaksi-${report.period.key}.pdf`;
}
