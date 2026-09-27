import "server-only";
import { readStok } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import { isBelowMinimum } from "../inventory/inventory-engine";
import { readSheetRange } from "../sheets/google-sheets";
import { readSuppliers, type Supplier } from "../supplier/supplier-service";

export const MASTER_ITEM_SHEET = "Master Barang";

export interface MasterItemSupplier {
  sku: string;
  supplierName: string;
  supplierCode: string;
}

export interface RestockRecommendation {
  sku: string;
  name: string;
  unit: string;
  currentStock: number;
  minimumStock: number;
  recommendedQuantity: number;
  supplierName: string;
  supplierContact: string;
  supplierWhatsapp: string | null;
}

const text = (value: unknown) => value == null ? "" : String(value).trim();
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
const round = (value: number) => Math.round(value * 1e6) / 1e6;

/** Reads only the supplier fields needed from Master Barang, matched by header name. */
export function parseMasterItemSuppliers(values: readonly unknown[][]): MasterItemSupplier[] {
  const [header = [], ...rows] = values;
  const names = header.map((cell) => normalize(text(cell)));
  const sku = names.indexOf(normalize("SKU"));
  const supplierName = names.indexOf(normalize("Supplier Utama"));
  const supplierCode = names.indexOf(normalize("Kode Supplier"));
  if (sku === -1) return [];
  return rows.map((row) => ({
    sku: text(row[sku]),
    supplierName: supplierName === -1 ? "" : text(row[supplierName]),
    supplierCode: supplierCode === -1 ? "" : text(row[supplierCode]),
  })).filter((item) => item.sku);
}

export async function readMasterItemSuppliers(): Promise<MasterItemSupplier[]> {
  const { values } = await readSheetRange(`'${MASTER_ITEM_SHEET}'!A1:Z`);
  return parseMasterItemSuppliers(values);
}

export interface RestockDependencies {
  readStock?: () => Promise<readonly StokItem[]>;
  readMasterItems?: () => Promise<readonly MasterItemSupplier[]>;
  readSuppliers?: () => Promise<readonly Supplier[]>;
}

/** Builds recommendations only from sheet data; it never creates an order or changes stock. */
export async function buildRestockRecommendations(dependencies: RestockDependencies = {}): Promise<RestockRecommendation[]> {
  const [stock, masterItems, suppliers] = await Promise.all([
    (dependencies.readStock ?? readStok)(),
    (dependencies.readMasterItems ?? readMasterItemSuppliers)(),
    (dependencies.readSuppliers ?? readSuppliers)(),
  ]);
  const masterBySku = new Map(masterItems.map((item) => [normalize(item.sku), item]));
  const supplierByCode = new Map(suppliers.filter((supplier) => supplier.code).map((supplier) => [normalize(supplier.code), supplier]));
  const supplierByName = new Map(suppliers.map((supplier) => [normalize(supplier.name), supplier]));

  return stock
    .filter((item) => item.stokMinimum !== null && isBelowMinimum({ currentStock: item.stokAkhir, minimumStock: item.stokMinimum }))
    .map((item) => {
      const master = masterBySku.get(normalize(item.sku));
      const requestedName = master?.supplierName || item.supplierUtama;
      const supplier = (master?.supplierCode ? supplierByCode.get(normalize(master.supplierCode)) : undefined)
        ?? (requestedName ? supplierByName.get(normalize(requestedName)) : undefined);
      return {
        sku: item.sku,
        name: item.namaBarang,
        unit: item.satuan,
        currentStock: item.stokAkhir,
        minimumStock: item.stokMinimum!,
        recommendedQuantity: round(Math.max(0, item.stokMinimum! - item.stokAkhir)),
        supplierName: supplier?.name || requestedName,
        supplierContact: supplier?.contact || "",
        supplierWhatsapp: supplier?.whatsapp ?? null,
      };
    })
    .sort((a, b) => b.recommendedQuantity - a.recommendedQuantity || a.name.localeCompare(b.name, "id"));
}
