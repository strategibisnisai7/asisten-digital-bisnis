import "server-only";
import { applyAtomicChanges, ensureSheetWithHeader, readSheetRange, type GridCellUpdate } from "../sheets/google-sheets";

export const NOTIFICATION_SHEET = "Notifikasi Stok";
export const NOTIFICATION_HEADERS = [
  "Chat ID", "User ID", "Aktif", "Thread ID", "SKU Menipis Terakhir", "Diperbarui",
] as const;

export interface NotificationPreference {
  rowNumber: number;
  chatId: number;
  userId: number;
  enabled: boolean;
  threadId?: number;
  lowSkus: string[];
  updatedAt: string;
}

export interface NotificationStore {
  ensure(): Promise<void>;
  list(): Promise<NotificationPreference[]>;
  setPreference(input: { chatId: number; userId: number; enabled: boolean; threadId?: number; at?: Date }): Promise<NotificationPreference>;
  saveLowStockStates(states: readonly { rowNumber: number; lowSkus: readonly string[]; at?: Date }[]): Promise<void>;
}

const value = (cell: unknown) => cell == null ? "" : String(cell).trim();
const integer = (cell: unknown): number | null => {
  const parsed = Number(value(cell));
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const encodeSkus = (skus: readonly string[]) => JSON.stringify([...new Set(skus)].sort());

export function parseNotificationRows(values: readonly unknown[][]): NotificationPreference[] {
  const rows = values.slice(1);
  return rows.flatMap((row, index) => {
    const chatId = integer(row[0]);
    const userId = integer(row[1]);
    if (chatId === null || userId === null) return [];
    let lowSkus: string[] = [];
    try {
      const parsed = JSON.parse(value(row[4]) || "[]");
      if (Array.isArray(parsed)) lowSkus = parsed.filter((sku): sku is string => typeof sku === "string" && sku.length > 0);
    } catch { /* A malformed old snapshot is safely treated as empty. */ }
    const threadId = integer(row[3]);
    return [{
      rowNumber: index + 2,
      chatId,
      userId,
      enabled: /^(?:true|ya|aktif|1)$/i.test(value(row[2])),
      ...(threadId === null ? {} : { threadId }),
      lowSkus: [...new Set(lowSkus)].sort(),
      updatedAt: value(row[5]),
    }];
  });
}

async function listPreferences(): Promise<NotificationPreference[]> {
  const { values } = await readSheetRange(`'${NOTIFICATION_SHEET}'!A1:F`);
  return parseNotificationRows(values);
}

export const sheetsNotificationStore: NotificationStore = {
  async ensure() {
    await ensureSheetWithHeader(NOTIFICATION_SHEET, NOTIFICATION_HEADERS);
  },
  list: listPreferences,
  async setPreference({ chatId, userId, enabled, threadId, at = new Date() }) {
    await this.ensure();
    const existing = (await this.list()).find((entry) => entry.chatId === chatId && entry.userId === userId);
    const updatedAt = at.toISOString();
    if (!existing) {
      await applyAtomicChanges([], {
        sheetTitle: NOTIFICATION_SHEET,
        rows: [[String(chatId), String(userId), enabled ? "TRUE" : "FALSE", threadId === undefined ? "" : String(threadId), "[]", updatedAt]],
      });
      const created = (await this.list()).find((entry) => entry.chatId === chatId && entry.userId === userId);
      if (!created) throw new Error("Preferensi notifikasi belum dapat dibaca setelah disimpan.");
      return created;
    }
    const updates: GridCellUpdate[] = [
      { sheetTitle: NOTIFICATION_SHEET, rowNumber: existing.rowNumber, columnIndex: 2, value: enabled ? "TRUE" : "FALSE" },
      { sheetTitle: NOTIFICATION_SHEET, rowNumber: existing.rowNumber, columnIndex: 3, value: threadId === undefined ? "" : String(threadId) },
      { sheetTitle: NOTIFICATION_SHEET, rowNumber: existing.rowNumber, columnIndex: 5, value: updatedAt },
    ];
    if (!enabled) updates.push({ sheetTitle: NOTIFICATION_SHEET, rowNumber: existing.rowNumber, columnIndex: 4, value: "[]" });
    await applyAtomicChanges(updates);
    return { ...existing, enabled, threadId, lowSkus: enabled ? existing.lowSkus : [], updatedAt };
  },
  async saveLowStockStates(states) {
    const updates: GridCellUpdate[] = states.flatMap(({ rowNumber, lowSkus, at = new Date() }) => [
      { sheetTitle: NOTIFICATION_SHEET, rowNumber, columnIndex: 4, value: encodeSkus(lowSkus) },
      { sheetTitle: NOTIFICATION_SHEET, rowNumber, columnIndex: 5, value: at.toISOString() },
    ]);
    await applyAtomicChanges(updates);
  },
};

export async function getNotificationPreference(chatId: number, userId: number, store: NotificationStore = sheetsNotificationStore) {
  await store.ensure();
  return (await store.list()).find((entry) => entry.chatId === chatId && entry.userId === userId) ?? null;
}

export function setNotificationPreference(
  input: { chatId: number; userId: number; enabled: boolean; threadId?: number; at?: Date },
  store: NotificationStore = sheetsNotificationStore,
) {
  return store.setPreference(input);
}
