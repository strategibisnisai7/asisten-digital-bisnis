import "server-only";
import { readStok } from "../google-sheets/service";
import type { StokItem } from "../google-sheets/stok";
import { isBelowMinimum, type InventoryProduct } from "../inventory/inventory-engine";
import { lowStockNotificationReply } from "../telegram/formatting";
import type { TelegramBot } from "../telegram/types";
import { sheetsNotificationStore, type NotificationStore } from "./notification-store";

export interface NotificationRunDependencies {
  store?: NotificationStore;
  readStock?: () => Promise<readonly StokItem[]>;
  send: TelegramBot["sendMessage"];
  now?: Date;
  onError?: (error: unknown) => void;
}

export interface NotificationRunResult { subscriptions: number; notified: number; recovered: number; failed: number }

const product = (item: StokItem): InventoryProduct => ({
  sku: item.sku,
  name: item.namaBarang,
  unit: item.satuan,
  currentStock: item.stokAkhir,
  minimumStock: item.stokMinimum,
  status: item.statusStok,
  rack: item.lokasiRak,
  supplier: item.supplierUtama,
});

/** Reconciles each subscriber's last low-SKU set and sends only newly-low items. */
export async function runLowStockNotifications(dependencies: NotificationRunDependencies): Promise<NotificationRunResult> {
  const store = dependencies.store ?? sheetsNotificationStore;
  await store.ensure();
  const [preferences, stock] = await Promise.all([store.list(), (dependencies.readStock ?? readStok)()]);
  const enabled = preferences.filter((entry) => entry.enabled);
  const low = stock.filter((item) => isBelowMinimum({ currentStock: item.stokAkhir, minimumStock: item.stokMinimum }));
  const currentSkus = low.map((item) => item.sku).sort();
  const bySku = new Map(low.map((item) => [item.sku, item]));
  const states: { rowNumber: number; lowSkus: string[]; at: Date }[] = [];
  let notified = 0;
  let recovered = 0;
  let failed = 0;

  for (const preference of enabled) {
    const previous = new Set(preference.lowSkus);
    const newlyLow = currentSkus.filter((sku) => !previous.has(sku)).map((sku) => bySku.get(sku)!).filter(Boolean);
    if (preference.lowSkus.some((sku) => !bySku.has(sku))) recovered++;
    if (newlyLow.length) {
      try {
        await dependencies.send(preference.chatId, {
          ...lowStockNotificationReply(newlyLow.map(product)),
          message_thread_id: preference.threadId,
        });
        notified++;
      } catch (error) {
        failed++;
        dependencies.onError?.(error);
        continue;
      }
    }
    states.push({ rowNumber: preference.rowNumber, lowSkus: currentSkus, at: dependencies.now ?? new Date() });
  }
  await store.saveLowStockStates(states);
  return { subscriptions: enabled.length, notified, recovered, failed };
}
