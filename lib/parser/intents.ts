import type { PeriodSpec } from "./period";

export type ProductReadIntent = "CHECK_STOCK" | "SEARCH_PRODUCT";
export type StockChangeIntent = "ADD_STOCK" | "REDUCE_STOCK" | "SET_STOCK";
export type SimpleIntent =
  | "START"
  | "LOW_STOCK"
  | "UPDATE_STOCK"
  | "STOCK_OPNAME"
  | "RESTOCK_RECOMMENDATION"
  | "INTEREST"
  | "CANCEL"
  | "CONFIRM"
  | "REPORT"
  | "CONTACT_SUPPLIER"
  | "LIST_SUPPLIERS"
  | "UNKNOWN";
export type InsightIntent = "STOCK_FILTER" | "TRANSACTION_HISTORY" | "STOCK_ANALYSIS";

export type IntentType = ProductReadIntent | StockChangeIntent | SimpleIntent | InsightIntent | "HELP";

/**
 * One requested stock change. The parser keeps whatever number was written
 * (NaN when missing, possibly zero or negative); validation happens later so the
 * user can be told exactly which quantity is wrong. For SET_STOCK it is the target.
 * `unit` is present only when a unit was written ("5 kg"); it is checked against
 * the product's unit before anything is planned.
 */
export interface StockItemRequest { product_query: string; quantity: number; unit?: string }

/** "di bawah 10" → lt 10; "antara 10 sampai 20" → between 10 and 20 (inclusive). */
export type StockFilter =
  | { op: "lt" | "lte" | "gt" | "gte" | "eq"; value: number; unit?: string }
  | { op: "between"; min: number; max: number; unit?: string };

/** TOP_*: largest total quantity; FREQUENT_*: most transactions. */
export type AnalysisMetric = "TOP_OUT" | "TOP_IN" | "FREQUENT_OUT" | "FREQUENT_IN";

export type HelpTopic = "stock" | "update" | "opname" | "report";

/** Language understanding only; parsing an intent never executes an operation. */
export type StructuredIntent =
  | { intent: "CHECK_STOCK"; product_query: string; quantity: null; match?: "exact_sku" }
  | { intent: "SEARCH_PRODUCT"; product_query: string; quantity: null }
  // An empty items list means the command was given without any item.
  | { intent: StockChangeIntent; product_query: null; quantity: null; items: StockItemRequest[] }
  | { intent: "STOCK_FILTER"; product_query: null; quantity: null; filter: StockFilter }
  | { intent: "TRANSACTION_HISTORY"; product_query: string | null; quantity: null; period: PeriodSpec | null; type: StockChangeIntent | null }
  | { intent: "STOCK_ANALYSIS"; product_query: null; quantity: null; metric: AnalysisMetric; period: PeriodSpec | null }
  // General help has no topic; "cara update stok" carries one.
  | { intent: "HELP"; product_query: null; quantity: null; topic?: HelpTopic }
  | { intent: SimpleIntent; product_query: null; quantity: null };

export type MissingField = "product" | "quantity";

/**
 * The flat view of a parsed message, for callers that need more than the intent:
 * how sure the parser is, what is still missing, and whether the request changes
 * stock (and so must be previewed and confirmed before anything is written).
 */
export interface ParseResult {
  intent: IntentType;
  productQuery: string | null;
  /** Set when the product text looks like an SKU code (e.g. "brg0006"). */
  sku: string | null;
  quantity: number | null;
  unit: string | null;
  /** SET_STOCK only: the stock the user says is correct. */
  targetStock: number | null;
  items: StockItemRequest[];
  period: PeriodSpec | null;
  filter: StockFilter | null;
  /** 0–1. Below CLARIFY_BELOW the caller should ask instead of acting. */
  confidence: number;
  missingFields: MissingField[];
  requiresConfirmation: boolean;
  /** True when a typo in a command word was corrected. */
  corrected: boolean;
  structured: StructuredIntent;
}
