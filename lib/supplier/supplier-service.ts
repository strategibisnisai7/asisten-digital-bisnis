import "server-only";
import { executeInventoryIntent, type InventoryProduct } from "../inventory/inventory-engine";
import type { OrderItemRequest } from "../parser/intents";
import { readSheetRange } from "../sheets/google-sheets";
import { normalizeWhatsAppNumber } from "./whatsapp";

// Read-only by design: contacting a supplier never changes stock or the history.

export const SUPPLIER_SHEET = "Supplier";
export const MASTER_SHEET = "Master Barang";

export interface Supplier { code: string; name: string; city: string; contact: string; note: string; whatsapp: string | null }
export interface SupplierDirectory { suppliers: Supplier[]; supplierCodeBySku: Map<string, string> }

const text = (value: unknown) => (value == null ? "" : String(value).trim());
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");

function columns(header: readonly unknown[]): (name: string) => number {
  const names = header.map((cell) => normalize(text(cell)));
  return (name) => names.indexOf(normalize(name));
}

export function parseSupplierRows(values: readonly unknown[][]): Supplier[] {
  const [header = [], ...rows] = values;
  const column = columns(header);
  const [code, name, city, contact, note] = ["Kode Supplier", "Nama Supplier", "Kota", "Kontak", "Keterangan"].map(column);
  if (name === -1) return [];
  return rows.map((row) => {
    const phone = contact === -1 ? "" : text(row[contact]);
    return {
      code: code === -1 ? "" : text(row[code]), name: text(row[name]), city: city === -1 ? "" : text(row[city]),
      contact: phone, note: note === -1 ? "" : text(row[note]), whatsapp: normalizeWhatsAppNumber(phone),
    };
  }).filter((supplier) => supplier.name);
}

export function parseMasterSupplierCodes(values: readonly unknown[][]): Map<string, string> {
  const [header = [], ...rows] = values;
  const column = columns(header);
  const sku = column("SKU");
  const code = column("Kode Supplier");
  const map = new Map<string, string>();
  if (sku === -1 || code === -1) return map;
  for (const row of rows) if (text(row[sku]) && text(row[code])) map.set(text(row[sku]), text(row[code]));
  return map;
}

export async function readSupplierDirectory(): Promise<SupplierDirectory> {
  const [suppliers, master] = await Promise.all([
    readSheetRange(`'${SUPPLIER_SHEET}'!A1:Z`),
    readSheetRange(`'${MASTER_SHEET}'!A1:Z`),
  ]);
  return { suppliers: parseSupplierRows(suppliers.values), supplierCodeBySku: parseMasterSupplierCodes(master.values) };
}

export function findSupplier(product: InventoryProduct, directory: SupplierDirectory): Supplier | null {
  const code = directory.supplierCodeBySku.get(product.sku);
  const byCode = code ? directory.suppliers.find((supplier) => supplier.code === code) : undefined;
  return byCode ?? directory.suppliers.find((supplier) => normalize(supplier.name) === normalize(product.supplier)) ?? null;
}

// ---------------------------------------------------------------- supplier requests

export interface RequestLine { product: InventoryProduct; quantity: number }
export interface SupplierGroup { supplierName: string; supplier: Supplier | null; lines: RequestLine[] }

export type SupplierRequest =
  | { status: "READY"; groups: SupplierGroup[] }
  | { status: "NOT_FOUND"; query: string }
  | { status: "AMBIGUOUS"; query: string; quantity: number; products: InventoryProduct[] };

export interface SupplierDependencies {
  execute?: typeof executeInventoryIntent;
  readDirectory?: () => Promise<SupplierDirectory>;
}

/** Resolves the requested items and groups them per supplier. Reads only. */
export async function prepareSupplierRequest(
  items: readonly OrderItemRequest[],
  dependencies: SupplierDependencies = {},
): Promise<SupplierRequest> {
  const execute = dependencies.execute ?? executeInventoryIntent;
  const lines: RequestLine[] = [];
  for (const item of items) {
    const result = await execute({ intent: "CHECK_STOCK", product_query: item.product_query, quantity: null });
    let product: InventoryProduct;
    if (result.status === "SUCCESS" && "product" in result) {
      product = result.product;
    } else if (result.status === "MULTIPLE_MATCHES") {
      // A full name or SKU typed exactly settles the choice between partial matches.
      const query = normalize(item.product_query);
      const exact = result.products.filter((p) => normalize(p.name) === query || normalize(p.sku) === query);
      if (exact.length !== 1) return { status: "AMBIGUOUS", query: item.product_query, quantity: item.quantity, products: result.products };
      product = exact[0];
    } else {
      return { status: "NOT_FOUND", query: item.product_query };
    }
    const existing = lines.find((line) => line.product.sku === product.sku);
    if (existing) existing.quantity += item.quantity;
    else lines.push({ product, quantity: item.quantity });
  }

  const directory = await (dependencies.readDirectory ?? readSupplierDirectory)();
  const groups: SupplierGroup[] = [];
  for (const line of lines) {
    const supplier = findSupplier(line.product, directory);
    const supplierName = supplier?.name ?? line.product.supplier.trim();
    const group = groups.find((entry) => entry.supplierName === supplierName);
    if (group) group.lines.push(line);
    else groups.push({ supplierName, supplier, lines: [line] });
  }
  return { status: "READY", groups };
}
