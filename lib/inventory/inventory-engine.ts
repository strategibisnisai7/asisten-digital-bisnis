import "server-only";
import { readStok } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import type { IntentType, ProductReadIntent, StructuredIntent } from "../parser/intents";

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
  | { intent: ProductReadIntent; status: "NOT_FOUND"; message: string }
  | { intent: ProductReadIntent; status: "INVALID_QUERY"; message: string }
  | { intent: IntentType; status: "UNSUPPORTED_INTENT"; message: string };

export type StockReader = () => Promise<readonly StokItem[]>;

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

/** The optional reader enables isolated tests; production uses fresh Sheets data. */
export async function executeInventoryIntent(
  parsed: StructuredIntent,
  readInventory: StockReader = readStok,
): Promise<InventoryResult> {
  const { intent } = parsed;
  if (intent !== "CHECK_STOCK" && intent !== "SEARCH_PRODUCT" && intent !== "LOW_STOCK") {
    return {
      intent,
      status: "UNSUPPORTED_INTENT",
      message: "Inventory engine saat ini hanya mendukung cek stok, pencarian produk, dan stok menipis.",
    };
  }

  if (intent === "LOW_STOCK") {
    const items = await readInventory();
    return {
      intent,
      status: "SUCCESS",
      products: items
        .filter((item) => item.stokMinimum !== null && item.stokAkhir <= item.stokMinimum)
        .map(toProduct),
    };
  }

  const query = typeof parsed.product_query === "string" ? normalizeQuery(parsed.product_query) : "";
  if (!query) {
    return { intent, status: "INVALID_QUERY", message: "Isi nama barang atau SKU yang ingin dicari." };
  }

  const items = await readInventory();
  const products = items
    .filter((item) => parsed.intent === "CHECK_STOCK" && parsed.match === "exact_sku"
      ? normalizeQuery(item.sku) === query
      : normalizeQuery(item.sku).includes(query) || normalizeQuery(item.namaBarang).includes(query))
    .map(toProduct);

  if (products.length === 0) {
    return { intent, status: "NOT_FOUND", message: "Produk tidak ditemukan." };
  }
  if (intent === "SEARCH_PRODUCT") {
    return { intent, status: "SUCCESS", products };
  }
  if (products.length > 1) {
    return { intent, status: "MULTIPLE_MATCHES", products, message: "Beberapa produk cocok. Pilih satu produk terlebih dahulu." };
  }
  return { intent, status: "SUCCESS", product: products[0] };
}
