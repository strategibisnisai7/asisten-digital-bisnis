import "server-only";
import type { StokItem } from "../google-sheets/stok";
import { GoogleSheetsError } from "../google-sheets/errors";
import { executeInventoryIntent } from "../inventory/inventory-engine";
import { applyStockUpdate, planStockUpdate, type StockReader } from "../inventory/stock-update";
import type { TransactionEntry, TransactionStore } from "../inventory/transaction-service";
import { parseOrderReply, parseRuleIntent, parseStockReply } from "../parser/rule-parser";
import type { StockChangeIntent, StructuredIntent } from "../parser/intents";
import { generateReportPdf, type GeneratedPdf } from "../report/pdf-generator";
import { buildMonthlyReport, type MonthlyReport } from "../report/report-service";
import { prepareSupplierRequest, readSupplierDirectory, type SupplierDirectory } from "../supplier/supplier-service";
import { openStockSummary, readCallback, type MenuAction } from "./callbacks";
import { isStockWriteEnabled } from "./config";
import {
  cancelReply, checkStockPromptReply, errorReply, expiredChoiceReply, formatInventoryResult, helpReply,
  isSupplierOrderPrompt, mainMenuReply, nothingToConfirmReply, parseStockSummary, reportErrorReply, reportProgressReply,
  reportReadyReply, searchPromptReply, startReply, stockApplyReply, stockCancelledReply, stockPlanReply, stockPromptIntent,
  stockPromptReply, stockSummaryExpiredReply, stockWriteDisabledReply, supplierCancelledReply, supplierListReply,
  supplierMenuReply, supplierOrderPromptReply, supplierRequestReply, textOnlyReply, unknownReply, updateStockMenuReply,
} from "./formatting";
import { parseTelegramEvent, type TelegramBot, type TelegramEvent, type TelegramReply } from "./types";

/** Stock storage for tests; production reads and writes Google Sheets. */
export interface StockDependencies {
  writeEnabled?: boolean;
  read?: StockReader;
  transactions?: TransactionStore;
  now?: () => number;
}

export interface AdapterDependencies {
  bot: TelegramBot;
  secret: string;
  execute?: typeof executeInventoryIntent;
  parse?: typeof parseRuleIntent;
  stock?: StockDependencies;
  supplier?: { readDirectory?: () => Promise<SupplierDirectory> };
  report?: {
    readTransactions?: () => Promise<readonly TransactionEntry[]>;
    render?: (report: MonthlyReport) => Promise<GeneratedPdf>;
  };
}

const STOCK_MENU: Partial<Record<MenuAction, StockChangeIntent>> = {
  stock_in: "ADD_STOCK",
  stock_out: "REDUCE_STOCK",
  stock_fix: "SET_STOCK",
};

const MENU_REPLIES: Partial<Record<MenuAction, () => TelegramReply>> = {
  menu: mainMenuReply,
  check: checkStockPromptReply,
  search: searchPromptReply,
  update: updateStockMenuReply,
  stock_cancel: stockCancelledReply,
  supplier: supplierMenuReply,
  supplier_order: supplierOrderPromptReply,
  supplier_cancel: supplierCancelledReply,
};

const isStockIntent = (parsed: StructuredIntent): parsed is Extract<StructuredIntent, { intent: StockChangeIntent }> =>
  parsed.intent === "ADD_STOCK" || parsed.intent === "REDUCE_STOCK" || parsed.intent === "SET_STOCK";

// Technical details go to the server log only. GoogleSheetsError messages are
// already sanitized; other errors are reduced to their name.
function logFailure(action: string, error: unknown): void {
  const detail = error instanceof GoogleSheetsError ? `${error.code}: ${error.message}` : error instanceof Error ? error.name : "unknown";
  console.error(`[telegram] ${action} (${detail})`);
}

export async function handleTelegramUpdate(update: unknown, dependencies: AdapterDependencies): Promise<void> {
  const event = parseTelegramEvent(update);
  if (!event) return;
  if (event.kind === "callback") {
    // A stale callback can no longer be acknowledged; a fresh reply still works.
    await dependencies.bot.answerCallbackQuery(event.id).catch(() => undefined);
  }
  const send = (reply: TelegramReply) => dependencies.bot.sendMessage(event.chatId, { ...reply, message_thread_id: event.threadId });
  const reply = await respond(event, dependencies, send);
  if (reply) await send(reply);
}

/**
 * Routes an event to business logic and formats the outcome; holds no user-facing
 * text. Returns the final reply, or null when everything was already sent.
 */
async function respond(
  event: TelegramEvent,
  dependencies: AdapterDependencies,
  send: (reply: TelegramReply) => Promise<void>,
): Promise<TelegramReply | null> {
  const { secret, bot } = dependencies;
  const execute = dependencies.execute ?? executeInventoryIntent;
  const parse = dependencies.parse ?? parseRuleIntent;
  const stock = dependencies.stock ?? {};
  const now = stock.now?.() ?? Date.now();
  const context = { chatId: event.chatId, secret, now };

  const guarded = async (action: string, work: () => Promise<TelegramReply>): Promise<TelegramReply> => {
    try {
      return await work();
    } catch (error) {
      logFailure(action, error);
      return errorReply();
    }
  };
  const readInventory = (intent: StructuredIntent, page = 0) => guarded("Gagal membaca data inventory", async () =>
    formatInventoryResult(await execute(intent), { ...context, query: intent.product_query ?? "", page }));

  // Read-only: resolves and validates items, then shows a summary to confirm.
  const planStock = (parsed: Extract<StructuredIntent, { intent: StockChangeIntent }>) => guarded("Gagal menyiapkan update stok", async () =>
    stockPlanReply(await planStockUpdate(parsed.intent, parsed.items, stock.read), context));

  // The only path that writes to Google Sheets, reached by an explicit confirmation of a
  // sealed summary in this chat (button, or a reply "ya" to the summary). Stock cells
  // and the transaction history are committed together by the transaction service.
  const confirmStock = (summaryText: string, messageId?: number) => guarded("Gagal menyimpan update stok", async () => {
    const opened = openStockSummary(summaryText, event.chatId, secret, now);
    if (opened.status === "EXPIRED") return stockSummaryExpiredReply();
    const summary = opened.status === "VALID" ? parseStockSummary(opened.body) : null;
    if (!summary) return stockApplyReply({ status: "INVALID" });
    if (messageId !== undefined) await bot.clearInlineKeyboard?.(event.chatId, messageId).catch(() => undefined);
    if (!(stock.writeEnabled ?? isStockWriteEnabled())) return stockWriteDisabledReply();
    const result = await applyStockUpdate(summary.intent, summary.changes, {
      user: event.user,
      read: stock.read,
      transactions: stock.transactions,
      now: new Date(now),
      onError: (error) => logFailure("Stok tersimpan, tetapi verifikasi gagal", error),
    });
    if (result.status === "WRITE_FAILED") logFailure("Penulisan stok gagal", result.error);
    return stockApplyReply(result);
  });

  // Contacting a supplier only reads Sheets; it never changes stock or the history.
  const readDirectory = dependencies.supplier?.readDirectory ?? readSupplierDirectory;
  const listSuppliers = () => guarded("Gagal membaca data supplier", async () => supplierListReply((await readDirectory()).suppliers));

  // Monthly report: progress note, ready note, then exactly one PDF.
  const sendReport = async (): Promise<TelegramReply | null> => {
    await send(reportProgressReply());
    let report: MonthlyReport;
    let pdf: GeneratedPdf;
    try {
      report = await buildMonthlyReport({
        now: new Date(now),
        readStock: stock.read as (() => Promise<readonly StokItem[]>) | undefined,
        readTransactions: dependencies.report?.readTransactions,
      });
      pdf = await (dependencies.report?.render ?? generateReportPdf)(report);
    } catch (error) {
      logFailure("Laporan gagal dibuat", error);
      return reportErrorReply();
    }
    await send(reportReadyReply(report.history.length > 0));
    try {
      await bot.sendDocument(event.chatId, {
        filename: pdf.filename, bytes: pdf.bytes, mimeType: "application/pdf",
        caption: `Laporan Stok & Transaksi — ${report.period.label}`,
      }, event.threadId);
    } catch (error) {
      logFailure("Pengiriman laporan gagal", error);
      return reportErrorReply();
    }
    return null;
  };

  if (event.kind === "callback") {
    const action = readCallback(event, secret);
    if (!action) return expiredChoiceReply();
    switch (action.kind) {
      case "menu": {
        if (action.value === "stock_confirm") return confirmStock(event.text, event.messageId);
        if ((action.value === "stock_cancel" || action.value === "supplier_cancel") && event.messageId !== undefined) {
          await bot.clearInlineKeyboard?.(event.chatId, event.messageId).catch(() => undefined);
        }
        if (action.value === "supplier_list") return listSuppliers();
        const stockIntent = STOCK_MENU[action.value];
        if (stockIntent) return stockPromptReply(stockIntent);
        return (MENU_REPLIES[action.value] ?? mainMenuReply)();
      }
      case "resolve": {
        // Continue the pending request with the picked SKU in place of the ambiguous name.
        const request = parse(action.request);
        if (!isStockIntent(request) || !request.items[action.page]) return expiredChoiceReply();
        const items = request.items.map((item, index) => index === action.page ? { ...item, product_query: action.value } : item);
        return planStock({ ...request, items });
      }
      case "pick": return readInventory({ intent: "CHECK_STOCK", product_query: action.value, quantity: null, match: "exact_sku" });
      case "low": return readInventory({ intent: "LOW_STOCK", product_query: null, quantity: null }, action.page);
      case "search": return readInventory({ intent: "SEARCH_PRODUCT", product_query: action.value, quantity: null }, action.page);
    }
  }

  if (event.text === undefined) return textOnlyReply();
  // A reply to a prompt reads a bare list ("minyak 20, gula 30") in that prompt's context.
  const promptIntent = stockPromptIntent(event.replyToText);
  const parsed = promptIntent ? parseStockReply(promptIntent, event.text)
    : isSupplierOrderPrompt(event.replyToText) ? parseOrderReply(event.text)
      : parse(event.text);
  const repliesToSummary = event.replyToText !== undefined && openStockSummary(event.replyToText, event.chatId, secret, now).status !== "INVALID";

  if (isStockIntent(parsed)) return parsed.items.length ? planStock(parsed) : stockPromptReply(parsed.intent);
  switch (parsed.intent) {
    case "START": return startReply();
    case "HELP": return helpReply();
    case "REPORT": return sendReport();
    case "CONTACT_SUPPLIER": return supplierMenuReply();
    case "LIST_SUPPLIERS": return listSuppliers();
    case "CANCEL": return repliesToSummary ? stockCancelledReply() : cancelReply();
    // "ya" confirms only the summary it replies to, never whatever was sent last.
    case "CONFIRM": return repliesToSummary ? confirmStock(event.replyToText!) : nothingToConfirmReply();
    case "UNKNOWN": return unknownReply();
    case "UPDATE_STOCK": return updateStockMenuReply();
    case "CREATE_ORDER": {
      if (!("items" in parsed)) return supplierOrderPromptReply();
      const items = parsed.items;
      return guarded("Gagal menyiapkan kebutuhan barang", async () =>
        supplierRequestReply(await prepareSupplierRequest(items, { execute, readDirectory })));
    }
    default: return readInventory(parsed);
  }
}
