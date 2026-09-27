import "server-only";
import { readStok, type StokCellWrite } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import type { StockChangeIntent, StockItemRequest } from "../parser/intents";
import { unitFactor } from "../parser/units";
import { matchesQuery, suggestProducts } from "./inventory-engine";
import { MAX_TRANSACTION_ITEMS, recordTransaction, type TransactionStore, type TransactionType } from "./transaction-service";

export const MAX_STOCK_QUANTITY = 1_000_000;
export { MAX_TRANSACTION_ITEMS };

export interface StockProduct { sku: string; name: string; unit: string; currentStock: number }

/** One product's change. `quantity` is the amount in/out, or the target for SET_STOCK. */
export interface PlannedChange extends StockProduct {
  quantity: number;
  before: number;
  after: number;
  /** Quantities written separately for the same product and merged into one change. */
  merged: number[];
}

export type QuantityProblem = "MISSING" | "NOT_POSITIVE" | "NEGATIVE" | "TOO_LARGE";
export type LineProblem = "NOT_FOUND" | "AMBIGUOUS" | "INSUFFICIENT" | "NO_CHANGE" | "CONFLICTING_DUPLICATE" | "UNIT_MISMATCH";

export type PlanLine =
  | { ok: true; change: PlannedChange }
  | {
    ok: false; query: string; quantity: number; problem: LineProblem; product?: StockProduct; matches?: number;
    /** UNIT_MISMATCH: the unit that was written. */
    unit?: string;
    /** NOT_FOUND: close spellings, shown as hints only. */
    suggestions?: StockProduct[];
  };

export type StockPlan =
  | { status: "EMPTY"; intent: StockChangeIntent }
  | { status: "TOO_MANY_ITEMS"; intent: StockChangeIntent; count: number }
  | { status: "INVALID_QUANTITY"; intent: StockChangeIntent; problems: { query: string; problem: QuantityProblem }[] }
  | { status: "BLOCKED"; intent: StockChangeIntent; lines: PlanLine[] }
  | { status: "AMBIGUOUS"; intent: StockChangeIntent; index: number; query: string; products: StockProduct[]; items: StockItemRequest[] }
  | { status: "READY"; intent: StockChangeIntent; changes: PlannedChange[] };

export type StockReader = () => Promise<readonly StokItem[]>;

const round = (value: number) => Math.round(value * 1e6) / 1e6;
const same = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

function toProduct(item: StokItem): StockProduct {
  return { sku: item.sku, name: item.namaBarang, unit: item.satuan, currentStock: item.stokAkhir };
}

/** Units counted in whole pieces reject decimals; weight and volume units accept them. */
export function allowsDecimal(unit: string): boolean {
  return /^(?:kg|kilo(?:gram)?|g|gr|gram|ons|l|ltr|liter|litre|ml|m|meter)$/i.test(unit.trim());
}

export function quantityProblem(intent: StockChangeIntent, quantity: number): QuantityProblem | null {
  if (!Number.isFinite(quantity)) return "MISSING";
  if (quantity < 0) return "NEGATIVE";
  // A correction to 0 is a real stock count; moving 0 units in or out is not.
  if (quantity === 0 && intent !== "SET_STOCK") return "NOT_POSITIVE";
  if (quantity > MAX_STOCK_QUANTITY) return "TOO_LARGE";
  return null;
}

/** Exact SKU, then exact name, then partial SKU/name matches. */
export function resolveProduct(query: string, inventory: readonly StokItem[]): StokItem[] {
  const wanted = normalize(query);
  const bySku = inventory.filter((item) => normalize(item.sku) === wanted);
  if (bySku.length) return bySku;
  const byName = inventory.filter((item) => normalize(item.namaBarang) === wanted);
  if (byName.length) return byName;
  return inventory.filter((item) => matchesQuery(wanted, item.sku, item.namaBarang));
}

function afterChange(intent: StockChangeIntent, before: number, quantity: number): number {
  if (intent === "ADD_STOCK") return round(before + quantity);
  if (intent === "REDUCE_STOCK") return round(before - quantity);
  return quantity;
}

/**
 * Read-only: resolves and validates every item and computes before/after values.
 * Nothing is written; a READY plan still needs the user's confirmation.
 */
export async function planStockUpdate(
  intent: StockChangeIntent,
  items: readonly StockItemRequest[],
  readInventory: StockReader = readStok,
): Promise<StockPlan> {
  if (!items.length) return { status: "EMPTY", intent };
  if (items.length > MAX_TRANSACTION_ITEMS) return { status: "TOO_MANY_ITEMS", intent, count: items.length };
  const problems = items.flatMap((item) => {
    const problem = quantityProblem(intent, item.quantity);
    return problem ? [{ query: item.product_query, problem }] : [];
  });
  if (problems.length) return { status: "INVALID_QUANTITY", intent, problems };

  const inventory = await readInventory();
  const failures: Extract<PlanLine, { ok: false }>[] = [];
  const ambiguous: { index: number; query: string; products: StockProduct[] }[] = [];
  const groups = new Map<string, { item: StokItem; quantities: number[] }>();
  items.forEach((request, index) => {
    const matches = resolveProduct(request.product_query, inventory);
    if (matches.length === 0) {
      const suggestions = suggestProducts(request.product_query, inventory.map(toProduct), 3);
      failures.push({ ok: false, query: request.product_query, quantity: request.quantity, problem: "NOT_FOUND", ...(suggestions.length ? { suggestions } : {}) });
    } else if (matches.length > 1) {
      ambiguous.push({ index, query: request.product_query, products: matches.map(toProduct) });
    } else {
      // "500 gram" for a product in kg becomes 0,5; "2 dus" for one counted in botol is refused.
      const factor = request.unit ? unitFactor(request.unit, matches[0].satuan) : 1;
      if (factor === null) {
        failures.push({ ok: false, query: matches[0].namaBarang, quantity: request.quantity, problem: "UNIT_MISMATCH", product: toProduct(matches[0]), unit: request.unit });
        return;
      }
      const group = groups.get(matches[0].sku) ?? { item: matches[0], quantities: [] };
      group.quantities.push(round(request.quantity * factor));
      groups.set(matches[0].sku, group);
    }
  });

  const changes: PlannedChange[] = [];
  for (const { item, quantities } of groups.values()) {
    const product = toProduct(item);
    // Same product twice: amounts add up; two different targets cannot both be right.
    if (intent === "SET_STOCK" && new Set(quantities).size > 1) {
      failures.push({ ok: false, query: item.namaBarang, quantity: quantities[0], problem: "CONFLICTING_DUPLICATE", product });
      continue;
    }
    const quantity = intent === "SET_STOCK" ? quantities[0] : round(quantities.reduce((sum, value) => sum + value, 0));
    const before = item.stokAkhir;
    const after = afterChange(intent, before, quantity);
    if (after < 0) failures.push({ ok: false, query: item.namaBarang, quantity, problem: "INSUFFICIENT", product });
    else if (intent === "SET_STOCK" && same(after, before)) failures.push({ ok: false, query: item.namaBarang, quantity, problem: "NO_CHANGE", product });
    else changes.push({ ...product, quantity, before, after, merged: quantities.length > 1 ? quantities : [] });
  }

  if (failures.length) {
    const unresolved = ambiguous.map((entry): PlanLine => ({
      ok: false, query: entry.query, quantity: items[entry.index].quantity, problem: "AMBIGUOUS", matches: entry.products.length,
    }));
    return { status: "BLOCKED", intent, lines: [...changes.map((change): PlanLine => ({ ok: true, change })), ...failures, ...unresolved] };
  }
  if (ambiguous.length) return { status: "AMBIGUOUS", intent, ...ambiguous[0], items: [...items] };
  return { status: "READY", intent, changes };
}

// ---------------------------------------------------------------- applying a confirmed plan

/** What the confirmed summary promised for one product. */
export interface ConfirmedChange { sku: string; before: number; after: number }

export interface AppliedChange { sku: string; name: string; unit: string; before: number; after: number; actual?: number | null }

export type ApplyResult =
  | { status: "SAVED"; changes: AppliedChange[]; transactionId: string }
  | { status: "UNVERIFIED"; changes: AppliedChange[]; transactionId: string }
  | { status: "ALREADY_APPLIED"; changes: AppliedChange[] }
  | { status: "CONFLICT"; changes: AppliedChange[] }
  | { status: "INVALID" }
  | { status: "WRITE_FAILED"; outcome: "NOTHING_SAVED" | "UNKNOWN"; error: unknown };

export interface StockWriteDependencies {
  user: string;
  read?: StockReader;
  transactions?: TransactionStore;
  /** Receives technical errors (history append, verification) for server logs. */
  onError?: (error: unknown) => void;
  now?: Date;
  /** Overrides the history type for a SET operation, used only by Stock Opname. */
  transactionType?: TransactionType;
  transactionNote?: string;
}

function validDirection(intent: StockChangeIntent, change: ConfirmedChange): boolean {
  if (![change.before, change.after].every(Number.isFinite) || change.after < 0) return false;
  if (Math.abs(change.after - change.before) > MAX_STOCK_QUANTITY && intent !== "SET_STOCK") return false;
  if (intent === "ADD_STOCK") return change.after > change.before;
  if (intent === "REDUCE_STOCK") return change.after < change.before;
  return !same(change.after, change.before) && change.after <= MAX_STOCK_QUANTITY;
}

/**
 * Writes a confirmed change set. Current values are read again first: if any stock
 * moved since the summary was made (including a second confirmation of the same
 * summary), nothing is written. ADD adds to column E, REDUCE to F, and SET adds
 * (target − current) to G; H stays a formula. All cells go out in one batch.
 * Two confirmations processed at the very same moment are not serialized.
 */
export async function applyStockUpdate(
  intent: StockChangeIntent,
  confirmed: readonly ConfirmedChange[],
  dependencies: StockWriteDependencies,
): Promise<ApplyResult> {
  const read = dependencies.read ?? readStok;
  if (!confirmed.length || confirmed.length > MAX_TRANSACTION_ITEMS || new Set(confirmed.map((c) => c.sku)).size !== confirmed.length
    || !confirmed.every((change) => validDirection(intent, change))) {
    return { status: "INVALID" };
  }

  const fresh = new Map((await read()).map((item) => [item.sku, item]));
  const describe = (change: ConfirmedChange): AppliedChange => {
    const item = fresh.get(change.sku);
    return { sku: change.sku, name: item?.namaBarang ?? change.sku, unit: item?.satuan ?? "", before: change.before, after: change.after, actual: item?.stokAkhir ?? null };
  };
  if (confirmed.every((change) => fresh.has(change.sku) && same(fresh.get(change.sku)!.stokAkhir, change.after))) {
    return { status: "ALREADY_APPLIED", changes: confirmed.map(describe) };
  }
  if (!confirmed.every((change) => fresh.has(change.sku) && same(fresh.get(change.sku)!.stokAkhir, change.before))) {
    return { status: "CONFLICT", changes: confirmed.map(describe) };
  }

  const writes: StokCellWrite[] = confirmed.map((change) => {
    const item = fresh.get(change.sku)!;
    const delta = round(change.after - change.before);
    if (intent === "ADD_STOCK") return { rowNumber: item.rowNumber, column: "E", value: round(item.barangMasuk + delta) };
    if (intent === "REDUCE_STOCK") return { rowNumber: item.rowNumber, column: "F", value: round(item.barangKeluar - delta) };
    return { rowNumber: item.rowNumber, column: "G", value: round(item.adjustment + delta) };
  });

  // Stock cells and history rows are committed together by the transaction service.
  let transactionId: string;
  try {
    const recorded = await recordTransaction({
      type: dependencies.transactionType ?? intent,
      user: dependencies.user,
      at: dependencies.now,
      stockCells: writes,
      items: confirmed.map((change) => {
        const { name, unit } = describe(change);
        return {
          sku: change.sku, productName: name, unit,
          quantity: intent === "REDUCE_STOCK" ? round(change.before - change.after) : round(change.after - change.before),
          stockBefore: change.before, stockAfter: change.after,
          note: dependencies.transactionNote ?? (intent === "SET_STOCK" ? `Koreksi ke ${change.after}` : ""),
        };
      }),
    }, dependencies.transactions);
    transactionId = recorded.transactionId;
  } catch (error) {
    // Report "nothing saved" only when a fresh read proves it.
    let outcome: "NOTHING_SAVED" | "UNKNOWN" = "UNKNOWN";
    try {
      const after = new Map((await read()).map((item) => [item.sku, item]));
      if (confirmed.every((change) => after.has(change.sku) && same(after.get(change.sku)!.stokAkhir, change.before))) outcome = "NOTHING_SAVED";
    } catch { /* outcome stays UNKNOWN */ }
    return { status: "WRITE_FAILED", outcome, error };
  }

  // Stok Akhir is a formula; reading it back confirms the sheet recalculated as expected.
  let changes = confirmed.map(describe);
  try {
    const after = new Map((await read()).map((item) => [item.sku, item]));
    changes = changes.map((change) => ({ ...change, actual: after.get(change.sku)?.stokAkhir ?? null }));
  } catch (error) {
    dependencies.onError?.(error);
    changes = changes.map((change) => ({ ...change, actual: null }));
  }
  const verified = changes.every((change) => typeof change.actual === "number" && same(change.actual, change.after));
  return { status: verified ? "SAVED" : "UNVERIFIED", changes, transactionId };
}

/** Applies a physical count as an Adjustment and records the dedicated history type. */
export function applyStockOpname(
  confirmed: readonly ConfirmedChange[],
  dependencies: StockWriteDependencies,
): Promise<ApplyResult> {
  const [change] = confirmed;
  const difference = change ? round(change.after - change.before) : 0;
  return applyStockUpdate("SET_STOCK", confirmed, {
    ...dependencies,
    transactionType: "STOCK_OPNAME",
    transactionNote: `Stock opname; selisih ${difference >= 0 ? "+" : ""}${difference}`,
  });
}
