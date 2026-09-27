export type ProductReadIntent = "CHECK_STOCK" | "SEARCH_PRODUCT";
export type StockChangeIntent = "ADD_STOCK" | "REDUCE_STOCK" | "SET_STOCK";
export type SimpleIntent =
  | "START"
  | "LOW_STOCK"
  | "UPDATE_STOCK"
  | "CANCEL"
  | "CONFIRM"
  | "HELP"
  | "REPORT"
  | "CONTACT_SUPPLIER"
  | "LIST_SUPPLIERS"
  | "UNKNOWN";

export type IntentType = ProductReadIntent | StockChangeIntent | SimpleIntent;

/**
 * One requested stock change. The parser keeps whatever number was written
 * (NaN when missing, possibly zero or negative); validation happens later so the
 * user can be told exactly which quantity is wrong. For SET_STOCK it is the target.
 */
export interface StockItemRequest { product_query: string; quantity: number }

/** Language understanding only; parsing an intent never executes an operation. */
export type StructuredIntent =
  | { intent: "CHECK_STOCK"; product_query: string; quantity: null; match?: "exact_sku" }
  | { intent: "SEARCH_PRODUCT"; product_query: string; quantity: null }
  // An empty items list means the command was given without any item.
  | { intent: StockChangeIntent; product_query: null; quantity: null; items: StockItemRequest[] }
  | { intent: SimpleIntent; product_query: null; quantity: null };
