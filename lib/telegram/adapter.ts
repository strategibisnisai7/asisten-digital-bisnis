import "server-only";
import { executeInventoryIntent } from "../inventory/inventory-engine";
import { parseRuleIntent } from "../parser/rule-parser";
import type { StructuredIntent } from "../parser/intents";
import { readCallback } from "./callbacks";
import { formatInventoryResult, HELP_TEXT, menuReply } from "./formatting";
import { parseTelegramEvent, type TelegramBot } from "./types";

export interface AdapterDependencies {
  bot: TelegramBot;
  secret: string;
  execute?: typeof executeInventoryIntent;
  parse?: typeof parseRuleIntent;
}

export async function handleTelegramUpdate(update: unknown, dependencies: AdapterDependencies): Promise<void> {
  const event = parseTelegramEvent(update);
  if (!event) return;
  const { bot, secret } = dependencies;
  const execute = dependencies.execute ?? executeInventoryIntent;
  const parse = dependencies.parse ?? parseRuleIntent;
  const send = (reply: ReturnType<typeof menuReply>) => bot.sendMessage(event.chatId, { ...reply, message_thread_id: event.threadId });
  let parsed: StructuredIntent;
  let page = 0;

  if (event.kind === "callback") {
    // A stale callback can no longer be acknowledged; a fresh reply still works.
    await bot.answerCallbackQuery(event.id).catch(() => undefined);
    const action = readCallback(event, secret);
    if (!action) {
      await send(menuReply("Pilihan tidak valid atau sudah kedaluwarsa. Silakan cari barang kembali."));
      return;
    }
    page = action.page;
    parsed = action.kind === "pick"
      ? { intent: "CHECK_STOCK", product_query: action.value, quantity: null, match: "exact_sku" }
      : action.kind === "low" ? parse("stok menipis")
        : { intent: "SEARCH_PRODUCT", product_query: action.value, quantity: null };
  } else {
    if (event.text === undefined) {
      await send(menuReply("Kirim teks nama barang atau SKU untuk mencari stok."));
      return;
    }
    parsed = parse(event.text);
  }

  let result;
  try {
    // No inventory lookup/filtering in this adapter. All intents go to the engine.
    result = await execute(parsed);
  } catch {
    await send(menuReply("Data stok belum bisa dibaca. Silakan coba lagi beberapa saat lagi."));
    return;
  }
  if (parsed.intent === "HELP") {
    await send(menuReply(HELP_TEXT));
  } else if (parsed.intent === "CANCEL") {
    await send(menuReply("Dibatalkan. Silakan pilih menu atau ketik nama barang."));
  } else if (parsed.intent === "CONFIRM") {
    await send(menuReply("Tidak ada tindakan yang menunggu konfirmasi. Ketik nama barang atau pilih menu."));
  } else if (parsed.intent === "UNKNOWN") {
    await send(menuReply("Perintah belum dipahami. Contoh: stok minyak goreng, cari beras, atau stok menipis."));
  } else {
    await send(formatInventoryResult(result, { chatId: event.chatId, secret, query: parsed.product_query ?? "", page }));
  }
}
