import "server-only";
import { readStok } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import { normalizeWords, productScore } from "../parser/fuzzy";
import type { IntentType, ProductReadIntent, StockFilter, StructuredIntent } from "../parser/intents";
import { canonicalUnit, unitFactor } from "../parser/units";

export interface InventoryProduct {
  sku: string;
  name: string;
  unit: string;
  currentStock: number;
  minimumStock: number | null;
  status: string;
  rack: string;
  supplier: string;
}

export type InventoryResult =
  | { intent: "CHECK_STOCK"; status: "SUCCESS"; product: InventoryProduct }
  | { intent: "SEARCH_PRODUCT" | "LOW_STOCK"; status: "SUCCESS"; products: InventoryProduct[] }
  | { intent: "CHECK_STOCK"; status: "MULTIPLE_MATCHES"; products: InventoryProduct[]; message: string }
  | { intent: "STOCK_FILTER"; status: "SUCCESS"; products: InventoryProduct[]; filter: StockFilter }
  // `suggestions` are close spellings ("minyk" → Minyak Goreng); never picked automatically.
  | { intent: ProductReadIntent; status: "NOT_FOUND"; message: string; suggestions?: InventoryProduct[] }
  | { intent: ProductReadIntent; status: "INVALID_QUERY"; message: string }
  | { intent: IntentType; status: "UNSUPPORTED_INTENT"; message: string };

export type StockReader = () => Promise<readonly StokItem[]>;

export type StockLevel = "OUT_OF_STOCK" | "LOW" | "SAFE" | "NO_MINIMUM";

/** The LOW_STOCK rule: at or below a defined minimum. */
export function isBelowMinimum(product: Pick<InventoryProduct, "currentStock" | "minimumStock">): boolean {
  return product.minimumStock !== null && product.currentStock <= product.minimumStock;
}

export function stockLevel(product: Pick<InventoryProduct, "currentStock" | "minimumStock">): StockLevel {
  if (product.currentStock <= 0) return "OUT_OF_STOCK";
  if (isBelowMinimum(product)) return "LOW";
  return product.minimumStock === null ? "NO_MINIMUM" : "SAFE";
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
}

function toProduct(item: StokItem): InventoryProduct {
  return {
    sku: item.sku,
    name: item.namaBarang,
    unit: item.satuan,
    currentStock: item.stokAkhir,
    minimumStock: item.stokMinimum,
    status: item.statusStok,
    rack: item.lokasiRak,
    supplier: item.supplierUtama,
  };
}

/** Every query word appears in the SKU or the name, in any order ("goreng minyak"). */
export function matchesQuery(query: string, sku: string, name: string): boolean {
  const wanted = normalizeQuery(query);
  if (!wanted) return false;
  if (normalizeQuery(sku).includes(wanted) || normalizeQuery(name).includes(wanted)) return true;
  const haystack = `${normalizeQuery(sku)} ${normalizeQuery(name)}`;
  const words = normalizeWords(wanted);
  return words.length > 1 && words.every((word) => haystack.includes(word));
}

export const MAX_SUGGESTIONS = 5;

/** Close spellings for a query that matched nothing, best first. Read-only hints. */
export function suggestProducts<T extends { sku: string; name: string }>(query: string, products: readonly T[], limit = MAX_SUGGESTIONS): T[] {
  return products
    .map((product) => ({ product, score: productScore(query, product.name, product.sku) }))
    .filter((entry) => entry.score >= 0.6)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
    .slice(0, limit)
    .map((entry) => entry.product);
}

/** Stock filter; a weight/volume unit ("kurang dari 5 kg") limits it to products in a compatible unit. */
export function applyStockFilter(products: readonly InventoryProduct[], filter: StockFilter): InventoryProduct[] {
  const counted = !filter.unit || ["pcs", "unit"].includes(canonicalUnit(filter.unit));
  return products.flatMap((product) => {
    const factor = counted ? 1 : unitFactor(product.unit, filter.unit!);
    if (factor === null) return [];
    const stock = product.currentStock * factor;
    const keep = filter.op === "between" ? stock >= filter.min && stock <= filter.max
      : filter.op === "lt" ? stock < filter.value
        : filter.op === "lte" ? stock <= filter.value
          : filter.op === "gt" ? stock > filter.value
            : filter.op === "gte" ? stock >= filter.value
              : Math.abs(stock - filter.value) < 1e-9;
    return keep ? [product] : [];
  }).sort((a, b) => a.currentStock - b.currentStock || a.name.localeCompare(b.name));
}

/** The optional reader enables isolated tests; production uses fresh Sheets data. */
export async function executeInventoryIntent(
  parsed: StructuredIntent,
  readInventory: StockReader = readStok,
): Promise<InventoryResult> {
  const { intent } = parsed;
  if (intent !== "CHECK_STOCK" && intent !== "SEARCH_PRODUCT" && intent !== "LOW_STOCK" && intent !== "STOCK_FILTER") {
    return {
      intent,
      status: "UNSUPPORTED_INTENT",
      message: "Inventory engine saat ini hanya mendukung cek stok, pencarian produk, stok menipis, dan filter stok.",
    };
  }

  if (intent === "LOW_STOCK") {
    const items = await readInventory();
    return {
      intent,
      status: "SUCCESS",
      products: items.map(toProduct).filter(isBelowMinimum),
    };
  }
  if (intent === "STOCK_FILTER") {
    if (!("filter" in parsed)) return { intent, status: "UNSUPPORTED_INTENT", message: "Filter stok tidak lengkap." };
    const items = await readInventory();
    return { intent, status: "SUCCESS", products: applyStockFilter(items.map(toProduct), parsed.filter), filter: parsed.filter };
  }

  const query = typeof parsed.product_query === "string" ? normalizeQuery(parsed.product_query) : "";
  if (!query) {
    return { intent, status: "INVALID_QUERY", message: "Isi nama barang atau SKU yang ingin dicari." };
  }

  const items = await readInventory();
  const exactSku = items.filter((item) => normalizeQuery(item.sku) === query);
  const products = (parsed.intent === "CHECK_STOCK" && parsed.match === "exact_sku"
    ? exactSku
    // A typed SKU that exists exactly is that product, even if other SKUs contain it.
    : exactSku.length === 1 && parsed.intent === "CHECK_STOCK" ? exactSku
      : items.filter((item) => matchesQuery(query, item.sku, item.namaBarang)))
    .map(toProduct);

  if (products.length === 0) {
    const suggestions = parsed.intent === "CHECK_STOCK" && parsed.match === "exact_sku" ? [] : suggestProducts(query, items.map(toProduct));
    return { intent, status: "NOT_FOUND", message: "Produk tidak ditemukan.", ...(suggestions.length ? { suggestions } : {}) };
  }
  if (intent === "SEARCH_PRODUCT") {
    return { intent, status: "SUCCESS", products };
  }
  if (products.length > 1) {
    return { intent, status: "MULTIPLE_MATCHES", products, message: "Beberapa produk cocok. Pilih satu produk terlebih dahulu." };
  }
  return { intent, status: "SUCCESS", product: products[0] };
}
