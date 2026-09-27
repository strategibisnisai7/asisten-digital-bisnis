export type ProductReadIntent = "CHECK_STOCK" | "SEARCH_PRODUCT";
export type StockChangeIntent = "ADD_STOCK" | "REDUCE_STOCK" | "SET_STOCK";
export type SimpleIntent =
  | "LOW_STOCK"
  | "CREATE_ORDER"
  | "CANCEL"
  | "CONFIRM"
  | "HELP"
  | "UNKNOWN";

export type IntentType = ProductReadIntent | StockChangeIntent | SimpleIntent;

/** Language understanding only; parsing an intent never executes an operation. */
export type StructuredIntent =
  | { intent: "CHECK_STOCK"; product_query: string; quantity: null; match?: "exact_sku" }
  | { intent: "SEARCH_PRODUCT"; product_query: string; quantity: null }
  | { intent: StockChangeIntent; product_query: string; quantity: number }
  | { intent: SimpleIntent; product_query: null; quantity: null };
