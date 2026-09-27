import "server-only";
import type { StokItem } from "../google-sheets/stok";
import { GoogleSheetsError } from "../google-sheets/errors";
import { executeInventoryIntent, type InventoryProduct } from "../inventory/inventory-engine";
import { allowsDecimal, applyStockUpdate, MAX_STOCK_QUANTITY, planStockUpdate, type StockReader } from "../inventory/stock-update";
import type { TransactionEntry, TransactionStore } from "../inventory/transaction-service";
import { parseQuantityInput, parseRuleIntent } from "../parser/rule-parser";
import type { StockChangeIntent, StructuredIntent } from "../parser/intents";
import { generateReportPdf, type GeneratedPdf } from "../report/pdf-generator";
import { buildMonthlyReport, type MonthlyReport } from "../report/report-service";
import { findSupplierByKey, readSuppliers, type Supplier } from "../supplier/supplier-service";
import { openSealedMessage, readCallback, readSearchQuery, type MenuAction, type UpdateScope } from "./callbacks";
import { isStockWriteEnabled } from "./config";
import {
  cancelReply, checkStockPromptReply, errorReply, expiredChoiceReply, formatInventoryResult, helpReply, isUpdateSearchPrompt,
  mainMenuReply, nothingToConfirmReply, parseQuantityPrompt, parseStockSummary, QUANTITY_WARNINGS, quantityPromptReply,
  quantityWaitingKeyboard, reportErrorReply, reportProgressReply, reportReadyReply, searchPromptReply, singlePreviewReply,
  startReply, stockApplyReply, stockCancelledReply, stockPlanReply, stockSummaryExpiredReply, stockWriteDisabledReply,
  supplierDetailReply, supplierListReply, supplierNotFoundReply, textOnlyReply, unknownReply, updateNotFoundReply,
  updateProductReply, updateResultsReply, updateSearchPromptReply,
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
  supplier?: { readSuppliers?: () => Promise<Supplier[]> };
  report?: {
    readTransactions?: () => Promise<readonly TransactionEntry[]>;
    render?: (report: MonthlyReport) => Promise<GeneratedPdf>;
  };
}

const MENU_REPLIES: Partial<Record<MenuAction, () => TelegramReply>> = {
  menu: mainMenuReply,
  check: checkStockPromptReply,
  search: searchPromptReply,
  update: updateSearchPromptReply,
  upd_search: updateSearchPromptReply,
  stock_cancel: stockCancelledReply,
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
  const context = { chatId: event.chatId, userId: event.userId, secret, now };
  // Update Stok state is bound to this chat and this user.
  const scope: UpdateScope = { chatId: event.chatId, userId: event.userId, secret };

  const guarded = async (action: string, work: () => Promise<TelegramReply>): Promise<TelegramReply> => {
    try {
      return await work();
    } catch (error) {
      logFailure(action, error);
      return errorReply();
    }
  };
  const setButtons = async (messageId: number | undefined, rows: Parameters<NonNullable<TelegramBot["setInlineKeyboard"]>>[2]) => {
    if (messageId !== undefined) await bot.setInlineKeyboard?.(event.chatId, messageId, rows).catch(() => undefined);
  };
  const readInventory = (intent: StructuredIntent, page = 0) => guarded("Gagal membaca data inventory", async () =>
    formatInventoryResult(await execute(intent), { ...context, query: intent.product_query ?? "", page }));

  // ---- 📝 Update Stok, product-first: search → product → action → number → preview → confirm

  const lookupProduct = async (sku: string): Promise<InventoryProduct | null> => {
    const result = await execute({ intent: "CHECK_STOCK", product_query: sku, quantity: null, match: "exact_sku" });
    return result.status === "SUCCESS" && "product" in result ? result.product : null;
  };

  const updateSearch = (query: string) => guarded("Gagal mencari barang untuk update", async () => {
    const result = await execute({ intent: "SEARCH_PRODUCT", product_query: query, quantity: null });
    if (result.status === "INVALID_QUERY") return updateSearchPromptReply();
    if (result.status !== "SUCCESS" || !("products" in result) || !result.products.length) return updateNotFoundReply(query);
    if (result.products.length === 1) return updateProductReply(result.products[0], null, scope);
    return updateResultsReply(result.products, query, scope);
  });

  const showProduct = (sku: string, query: string | null) => guarded("Gagal membaca barang", async () => {
    const product = await lookupProduct(sku);
    return product ? updateProductReply(product, query, scope) : updateNotFoundReply(sku);
  });

  // The typed text is only ever a quantity here: the product comes from the sealed prompt.
  const enterQuantity = (intent: StockChangeIntent, sku: string, input: string) => guarded("Gagal menyiapkan update stok", async () => {
    const product = await lookupProduct(sku);
    if (!product) return updateNotFoundReply(sku);
    if (parse(input).intent === "CANCEL") return updateProductReply(product, null, scope);
    const again = (warning: string[]) => quantityPromptReply(intent, product, scope, now, warning);
    const quantity = parseQuantityInput(input);
    if (quantity === null) return again(QUANTITY_WARNINGS.invalid);
    if (!Number.isInteger(quantity) && !allowsDecimal(product.unit)) return again(QUANTITY_WARNINGS.wholeNumber(product.unit));
    if (quantity > MAX_STOCK_QUANTITY) return again(QUANTITY_WARNINGS.tooLarge);
    if (quantity <= 0 && intent !== "SET_STOCK") return again(QUANTITY_WARNINGS.positive);

    const plan = await planStockUpdate(intent, [{ product_query: sku, quantity }], stock.read);
    if (plan.status === "READY" && plan.changes.length === 1) return singlePreviewReply(intent, plan.changes[0], scope, now);
    if (plan.status === "BLOCKED") {
      const failed = plan.lines.find((line) => !line.ok);
      if (failed && !failed.ok && failed.problem === "INSUFFICIENT") return again(QUANTITY_WARNINGS.insufficient(product));
      if (failed && !failed.ok && failed.problem === "NO_CHANGE") return again(QUANTITY_WARNINGS.unchanged(product));
    }
    if (plan.status === "INVALID_QUANTITY") return again(QUANTITY_WARNINGS.invalid);
    return updateNotFoundReply(sku);
  });

  // ---- free-text stock commands ("tambah stok minyak 20, gula 30")

  const planStock = (parsed: Extract<StructuredIntent, { intent: StockChangeIntent }>) => guarded("Gagal menyiapkan update stok", async () =>
    stockPlanReply(await planStockUpdate(parsed.intent, parsed.items, stock.read), context));

  // The only path that writes to Google Sheets, reached by an explicit confirmation of a
  // sealed summary by the same user in this chat (button, or a reply "ya"). Stock cells
  // and the transaction history are committed together by the transaction service.
  const confirmStock = (summaryText: string, messageId?: number) => guarded("Gagal menyimpan update stok", async () => {
    const opened = openSealedMessage("UPD", summaryText, scope, now);
    if (opened.status === "EXPIRED") return stockSummaryExpiredReply();
    const summary = opened.status === "VALID" ? parseStockSummary(opened.body) : null;
    if (!summary) return stockApplyReply({ status: "INVALID" });
    // Removing the buttons first keeps a second tap from reaching this point again.
    await setButtons(messageId, []);
    if (!(stock.writeEnabled ?? isStockWriteEnabled())) return stockWriteDisabledReply();
    const result = await applyStockUpdate(summary.intent, summary.changes, {
      user: event.user,
      read: stock.read,
      transactions: stock.transactions,
      now: new Date(now),
      onError: (error) => logFailure("Stok tersimpan, tetapi verifikasi gagal", error),
    });
    if (result.status === "WRITE_FAILED") logFailure("Penulisan stok gagal", result.error);
    return stockApplyReply(result, summary.intent);
  });

  // ---- supplier directory (read-only)

  const loadSuppliers = dependencies.supplier?.readSuppliers ?? readSuppliers;
  const listSuppliers = () => guarded("Gagal membaca data supplier", async () => supplierListReply(await loadSuppliers()));
  const showSupplier = (key: string) => guarded("Gagal membaca data supplier", async () => {
    const supplier = findSupplierByKey(await loadSuppliers(), key);
    return supplier ? supplierDetailReply(supplier) : supplierNotFoundReply();
  });

  // ---- monthly report: progress note, ready note, then exactly one PDF

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

  // ---- callbacks

  if (event.kind === "callback") {
    const action = readCallback(event, secret);
    if (!action) return expiredChoiceReply();
    switch (action.kind) {
      case "menu":
        if (action.value === "stock_confirm") return confirmStock(event.text, event.messageId);
        if (action.value === "stock_cancel") await setButtons(event.messageId, []);
        if (action.value === "supplier") return listSuppliers();
        return (MENU_REPLIES[action.value] ?? mainMenuReply)();
      case "upd_pick":
        return showProduct(action.sku, readSearchQuery(event.text) || null);
      case "upd_action": {
        const sku = action.sku;
        const intent = action.intent;
        return guarded("Gagal membaca barang", async () => {
          const product = await lookupProduct(sku);
          if (!product) return updateNotFoundReply(sku);
          // While the number is typed, the detail message offers only "Batal".
          await setButtons(event.messageId, quantityWaitingKeyboard(sku, scope));
          return quantityPromptReply(intent, product, scope, now);
        });
      }
      case "upd_detail":
        // Cancel on the quantity step or on the preview: back to the product detail.
        await setButtons(event.messageId, []);
        return showProduct(action.sku, null);
      case "upd_results":
        return updateSearch(action.query);
      case "supplier":
        return showSupplier(action.code);
      case "resolve": {
        // Continue a free-text request with the picked SKU in place of the ambiguous name.
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

  // ---- messages

  if (event.text === undefined) return textOnlyReply();
  const replyTo = event.replyToText;

  // Replies inside the Update Stok flow carry their context in the replied-to message.
  if (replyTo !== undefined) {
    if (isUpdateSearchPrompt(replyTo)) {
      return parse(event.text).intent === "CANCEL" ? cancelReply() : updateSearch(event.text.trim());
    }
    const prompt = openSealedMessage("QTY", replyTo, scope, now);
    if (prompt.status === "EXPIRED") return stockSummaryExpiredReply();
    const target = prompt.status === "VALID" ? parseQuantityPrompt(prompt.body) : null;
    if (target) return enterQuantity(target.intent, target.sku, event.text);
  }
  const repliesToSummary = replyTo !== undefined && openSealedMessage("UPD", replyTo, scope, now).status !== "INVALID";

  const parsed = parse(event.text);
  if (isStockIntent(parsed)) return parsed.items.length ? planStock(parsed) : updateSearchPromptReply();
  switch (parsed.intent) {
    case "START": return startReply();
    case "HELP": return helpReply();
    case "REPORT": return sendReport();
    case "CONTACT_SUPPLIER":
    case "LIST_SUPPLIERS": return listSuppliers();
    case "CANCEL": return repliesToSummary ? stockCancelledReply() : cancelReply();
    // "ya" confirms only the summary it replies to, never whatever was sent last.
    case "CONFIRM": return repliesToSummary ? confirmStock(replyTo!) : nothingToConfirmReply();
    case "UNKNOWN": return unknownReply();
    case "UPDATE_STOCK": return updateSearchPromptReply();
    default: return readInventory(parsed);
  }
}
