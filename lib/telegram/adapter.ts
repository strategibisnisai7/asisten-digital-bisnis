import "server-only";
import type { StokItem } from "../google-sheets/stok";
import { GoogleSheetsError } from "../google-sheets/errors";
import { readStok } from "../google-sheets/service";
import { buildAnalysis, buildHistory } from "../inventory/insights";
import { executeInventoryIntent, type InventoryProduct, type InventoryResult } from "../inventory/inventory-engine";
import { allowsDecimal, applyStockOpname, applyStockUpdate, MAX_STOCK_QUANTITY, planStockUpdate, type StockReader } from "../inventory/stock-update";
import { readTransactions, type TransactionEntry, type TransactionStore } from "../inventory/transaction-service";
import { getNotificationPreference, setNotificationPreference, type NotificationStore } from "../notifications/notification-store";
import { parseQuantityReply, parseRuleIntent, splitTrailingQuantity, STOCK_COMMAND_WORDS } from "../parser/rule-parser";
import { unitFactor } from "../parser/units";
import { jakartaDateTime } from "../time/jakarta";
import type { StockChangeIntent, StructuredIntent } from "../parser/intents";
import { generateReportPdf, type GeneratedPdf } from "../report/pdf-generator";
import { buildMonthlyReport, type MonthlyReport } from "../report/report-service";
import { buildRestockRecommendations, type MasterItemSupplier, type RestockRecommendation } from "../restock/restock-service";
import { findSupplierByKey, readSuppliers, type Supplier } from "../supplier/supplier-service";
import { openSealedMessage, readCallback, readSearchQuery, type MenuAction, type UpdateScope } from "./callbacks";
import { isStockWriteEnabled } from "./config";
import {
  analysisReply, bareNumberReply, clarifyQuantityReply, helpTopicReply, historyReply, stockActionChoiceReply,
  cancelReply, checkStockPromptReply, errorReply, expiredChoiceReply, formatInventoryResult, helpReply, interestReply,
  isOpnameSearchPrompt, isUpdateSearchPrompt, notificationPreferenceErrorReply, notificationPreferenceReply,
  mainMenuReply, nothingToConfirmReply, parseQuantityPrompt, parseStockSummary, QUANTITY_WARNINGS, quantityPromptReply,
  OPNAME_WARNINGS, opnameApplyReply, opnameCancelledReply, opnameNotFoundReply, opnamePreviewReply,
  opnameProductReply, opnameQuantityPromptReply, opnameResultsReply, opnameSearchPromptReply, opnameStockMatchesReply,
  opnameWaitingKeyboard, opnameWriteDisabledReply, parseOpnameQuantityPrompt, parseOpnameSummary, restockReply,
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
  notifications?: { store?: NotificationStore };
  restock?: {
    build?: () => Promise<readonly RestockRecommendation[]>;
    readMasterItems?: () => Promise<readonly MasterItemSupplier[]>;
  };
  report?: {
    readTransactions?: () => Promise<readonly TransactionEntry[]>;
    render?: (report: MonthlyReport) => Promise<GeneratedPdf>;
  };
}

const MENU_REPLIES: Partial<Record<MenuAction, () => TelegramReply>> = {
  menu: mainMenuReply,
  help: helpReply,
  help_stock: () => helpTopicReply("stock"),
  help_update: () => helpTopicReply("update"),
  help_opname: () => helpTopicReply("opname"),
  help_report: () => helpTopicReply("report"),
  check: checkStockPromptReply,
  search: searchPromptReply,
  update: updateSearchPromptReply,
  upd_search: updateSearchPromptReply,
  opname: opnameSearchPromptReply,
  opn_search: opnameSearchPromptReply,
  opn_cancel: opnameCancelledReply,
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
  // Reads before a confirmation may share one Sheets read per update; confirmations
  // always read fresh (applyStockUpdate uses stock.read directly).
  let planningRows: ReturnType<NonNullable<StockReader>> | null = null;
  const planningRead: StockReader = () => (planningRows ??= (stock.read ?? readStok)().catch((error) => { planningRows = null; throw error; }));
  const find = (intent: StructuredIntent) => execute(intent, planningRead);

  // "minyak 20" that matches no product name: ask what the number means.
  const clarifyNotFound = async (query: string): Promise<TelegramReply | null> => {
    const split = splitTrailingQuantity(query);
    if (!split || split.quantity.sign || !Number.isFinite(split.quantity.quantity)) return null;
    const found = await find({ intent: "SEARCH_PRODUCT", product_query: split.query, quantity: null });
    if (found.status !== "SUCCESS" || !("products" in found) || !found.products.length) return null;
    const request = `${split.query} ${String(split.quantity.quantity).replace(".", ",")}${split.quantity.unit ? ` ${split.quantity.unit}` : ""}`;
    return clarifyQuantityReply(split.query, split.quantity.quantity, request, scope);
  };
  const readInventory = (intent: StructuredIntent, page = 0, clarify = false) => guarded("Gagal membaca data inventory", async () => {
    const result: InventoryResult = await find(intent);
    const empty = result.status === "NOT_FOUND" || (result.status === "SUCCESS" && "products" in result && !result.products.length);
    if (clarify && empty && intent.product_query) {
      const question = await clarifyNotFound(intent.product_query);
      if (question) return question;
    }
    return formatInventoryResult(result, { ...context, query: intent.product_query ?? "", page });
  });
  // Pagination edits the list in place; if Telegram refuses, a new message is sent.
  const replaceOrSend = async (reply: TelegramReply): Promise<TelegramReply | null> => {
    if (event.kind !== "callback" || event.messageId === undefined || !bot.editMessage) return reply;
    try {
      await bot.editMessage(event.chatId, event.messageId, reply);
      return null;
    } catch {
      return reply;
    }
  };
  const loadTransactions = dependencies.report?.readTransactions ?? readTransactions;
  const today = () => jakartaDateTime(new Date(now));

  const notificationStatus = async (): Promise<boolean | null> => {
    try {
      return (await getNotificationPreference(event.chatId, event.userId, dependencies.notifications?.store))?.enabled ?? false;
    } catch (error) {
      logFailure("Gagal membaca preferensi notifikasi", error);
      return null;
    }
  };
  const readLowStock = (page = 0) => guarded("Gagal membaca stok menipis", async () => {
    const [result, notificationsEnabled] = await Promise.all([
      execute({ intent: "LOW_STOCK", product_query: null, quantity: null }),
      notificationStatus(),
    ]);
    return formatInventoryResult(result, { ...context, page, notificationsEnabled });
  });
  const changeNotificationPreference = async (enabled: boolean): Promise<TelegramReply> => {
    try {
      await setNotificationPreference({
        chatId: event.chatId, userId: event.userId, enabled, threadId: event.threadId, at: new Date(now),
      }, dependencies.notifications?.store);
      return notificationPreferenceReply(enabled);
    } catch (error) {
      logFailure("Gagal menyimpan preferensi notifikasi", error);
      return notificationPreferenceErrorReply();
    }
  };

  // ---- 📝 Update Stok, product-first: search → product → action → number → preview → confirm

  const lookupProduct = async (sku: string): Promise<InventoryProduct | null> => {
    const result = await find({ intent: "CHECK_STOCK", product_query: sku, quantity: null, match: "exact_sku" });
    return result.status === "SUCCESS" && "product" in result ? result.product : null;
  };

  const updateSearch = (query: string) => guarded("Gagal mencari barang untuk update", async () => {
    const result = await find({ intent: "SEARCH_PRODUCT", product_query: query, quantity: null });
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
    const answer = parse(input).intent;
    if (answer === "CANCEL") return updateProductReply(product, null, scope);
    if (answer === "START") return mainMenuReply();
    const again = (warning: string[]) => quantityPromptReply(intent, product, scope, now, warning);
    const typed = parseQuantityReply(input);
    if (typed === null) return again(QUANTITY_WARNINGS.invalid);
    const factor = typed.unit ? unitFactor(typed.unit, product.unit) : 1;
    if (factor === null) return again(QUANTITY_WARNINGS.unit(product, typed.unit!));
    const quantity = Math.round(typed.quantity * factor * 1e6) / 1e6;
    if (!Number.isInteger(quantity) && !allowsDecimal(product.unit)) return again(QUANTITY_WARNINGS.wholeNumber(product.unit));
    if (quantity > MAX_STOCK_QUANTITY) return again(QUANTITY_WARNINGS.tooLarge);
    if (quantity <= 0 && intent !== "SET_STOCK") return again(QUANTITY_WARNINGS.positive);

    const plan = await planStockUpdate(intent, [{ product_query: sku, quantity }], planningRead);
    if (plan.status === "READY" && plan.changes.length === 1) return singlePreviewReply(intent, plan.changes[0], scope, now);
    if (plan.status === "BLOCKED") {
      const failed = plan.lines.find((line) => !line.ok);
      if (failed && !failed.ok && failed.problem === "INSUFFICIENT") return again(QUANTITY_WARNINGS.insufficient(product));
      if (failed && !failed.ok && failed.problem === "NO_CHANGE") return again(QUANTITY_WARNINGS.unchanged(product));
    }
    if (plan.status === "INVALID_QUANTITY") return again(QUANTITY_WARNINGS.invalid);
    return updateNotFoundReply(sku);
  });

  // ---- Stock Opname: search → product → physical count → preview → confirm

  const opnameSearch = (query: string) => guarded("Gagal mencari barang untuk stock opname", async () => {
    const result = await find({ intent: "SEARCH_PRODUCT", product_query: query, quantity: null });
    if (result.status === "INVALID_QUERY") return opnameSearchPromptReply();
    if (result.status !== "SUCCESS" || !("products" in result) || !result.products.length) return opnameNotFoundReply(query);
    if (result.products.length === 1) return opnameProductReply(result.products[0], null, scope);
    return opnameResultsReply(result.products, query, scope);
  });

  const showOpnameProduct = (sku: string, query: string | null) => guarded("Gagal membaca barang untuk stock opname", async () => {
    const product = await lookupProduct(sku);
    return product ? opnameProductReply(product, query, scope) : opnameNotFoundReply(sku);
  });

  const enterOpnameQuantity = (sku: string, input: string) => guarded("Gagal menyiapkan stock opname", async () => {
    const product = await lookupProduct(sku);
    if (!product) return opnameNotFoundReply(sku);
    const answer = parse(input).intent;
    if (answer === "CANCEL") return opnameProductReply(product, null, scope);
    if (answer === "START") return mainMenuReply();
    const again = (warning: string[]) => opnameQuantityPromptReply(product, scope, now, warning);
    if (input.normalize("NFKC").trim().startsWith("-")) return again(OPNAME_WARNINGS.negative);
    const typed = parseQuantityReply(input);
    if (typed === null) return again(OPNAME_WARNINGS.invalid);
    const factor = typed.unit ? unitFactor(typed.unit, product.unit) : 1;
    if (factor === null) return again(OPNAME_WARNINGS.unit(product, typed.unit!));
    const physicalStock = Math.round(typed.quantity * factor * 1e6) / 1e6;
    if (!Number.isInteger(physicalStock) && !allowsDecimal(product.unit)) return again(OPNAME_WARNINGS.wholeNumber(product.unit));
    if (physicalStock > MAX_STOCK_QUANTITY) return again(OPNAME_WARNINGS.tooLarge);
    if (Math.abs(physicalStock - product.currentStock) < 1e-9) return opnameStockMatchesReply(product);
    return opnamePreviewReply(product, physicalStock, scope, now);
  });

  const confirmOpname = (summaryText: string, messageId?: number) => guarded("Gagal menyimpan stock opname", async () => {
    const opened = openSealedMessage("OPN", summaryText, scope, now);
    if (opened.status === "EXPIRED") return stockSummaryExpiredReply();
    const change = opened.status === "VALID" ? parseOpnameSummary(opened.body) : null;
    if (!change) return opnameApplyReply({ status: "INVALID" });
    await setButtons(messageId, []);
    if (!(stock.writeEnabled ?? isStockWriteEnabled())) return opnameWriteDisabledReply();
    const result = await applyStockOpname([change], {
      user: event.user,
      read: stock.read,
      transactions: stock.transactions,
      now: new Date(now),
      onError: (error) => logFailure("Stock opname tersimpan, tetapi verifikasi gagal", error),
    });
    if (result.status === "WRITE_FAILED") logFailure("Penulisan stock opname gagal", result.error);
    return opnameApplyReply(result);
  });

  // ---- free-text stock commands ("tambah stok minyak 20, gula 30")

  const planStock = (parsed: Extract<StructuredIntent, { intent: StockChangeIntent }>) => guarded("Gagal menyiapkan update stok", async () => {
    const [only] = parsed.items;
    // "minyak masuk" (no number): pick the product if needed, then ask only for the number.
    if (parsed.items.length === 1 && !Number.isFinite(only.quantity)) {
      const found = await find({ intent: "SEARCH_PRODUCT", product_query: only.product_query, quantity: null });
      const products = found.status === "SUCCESS" && "products" in found ? found.products : [];
      if (products.length === 1) return quantityPromptReply(parsed.intent, products[0], scope, now);
      if (products.length > 1) return stockActionChoiceReply(parsed.intent, products, only.product_query, scope);
    }
    return stockPlanReply(await planStockUpdate(parsed.intent, parsed.items, planningRead), context);
  });

  const showHistory = (parsed: Extract<StructuredIntent, { intent: "TRANSACTION_HISTORY" }>) => guarded("Gagal membaca riwayat transaksi", async () =>
    historyReply(buildHistory(await loadTransactions(), { productQuery: parsed.product_query, period: parsed.period, type: parsed.type }, today())));
  const showAnalysis = (parsed: Extract<StructuredIntent, { intent: "STOCK_ANALYSIS" }>) => guarded("Gagal membaca riwayat transaksi", async () =>
    analysisReply(buildAnalysis(await loadTransactions(), parsed.metric, parsed.period, today())));

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

  const showRestock = (page = 0) => guarded("Gagal membuat rekomendasi restock", async () => {
    const recommendations = dependencies.restock?.build
      ? await dependencies.restock.build()
      : await buildRestockRecommendations({
        readStock: stock.read as (() => Promise<readonly StokItem[]>) | undefined,
        readMasterItems: dependencies.restock?.readMasterItems,
        readSuppliers: loadSuppliers,
      });
    return restockReply(recommendations, { ...context, page });
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
        if (action.value === "opn_confirm") return confirmOpname(event.text, event.messageId);
        if (action.value === "stock_cancel") await setButtons(event.messageId, []);
        if (action.value === "opn_cancel") await setButtons(event.messageId, []);
        if (action.value === "supplier") return listSuppliers();
        if (action.value === "low") return readLowStock();
        if (action.value === "restock") return showRestock();
        if (action.value === "notif_on") return changeNotificationPreference(true);
        if (action.value === "notif_off") return changeNotificationPreference(false);
        if (action.value === "report") return sendReport();
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
      case "opn_pick":
        return showOpnameProduct(action.sku, readSearchQuery(event.text) || null);
      case "opn_count":
        return guarded("Gagal membaca barang untuk stock opname", async () => {
          const product = await lookupProduct(action.sku);
          if (!product) return opnameNotFoundReply(action.sku);
          await setButtons(event.messageId, opnameWaitingKeyboard(action.sku, scope));
          return opnameQuantityPromptReply(product, scope, now);
        });
      case "opn_detail":
        await setButtons(event.messageId, []);
        return showOpnameProduct(action.sku, null);
      case "opn_results":
        return opnameSearch(action.query);
      case "supplier":
        return showSupplier(action.code);
      case "clarify": {
        // The chosen meaning becomes an ordinary command; it still ends in a preview.
        await setButtons(event.messageId, []);
        const request = parse(`${STOCK_COMMAND_WORDS[action.intent]}: ${action.request}`);
        if (!isStockIntent(request) || request.items.length !== 1) return expiredChoiceReply();
        return planStock(request);
      }
      case "resolve": {
        // Continue a free-text request with the picked SKU in place of the ambiguous name.
        const request = parse(action.request);
        if (!isStockIntent(request) || !request.items[action.page]) return expiredChoiceReply();
        const items = request.items.map((item, index) => index === action.page ? { ...item, product_query: action.value } : item);
        return planStock({ ...request, items });
      }
      case "pick": return readInventory({ intent: "CHECK_STOCK", product_query: action.value, quantity: null, match: "exact_sku" });
      case "low": return replaceOrSend(await readLowStock(action.page));
      case "restock": return replaceOrSend(await showRestock(action.page));
      case "search": return replaceOrSend(await readInventory({ intent: "SEARCH_PRODUCT", product_query: action.value, quantity: null }, action.page));
    }
  }

  // ---- messages

  if (event.text === undefined) return textOnlyReply();
  const replyTo = event.replyToText;

  // Replies inside the Update Stok flow carry their context in the replied-to message.
  if (replyTo !== undefined) {
    if (isOpnameSearchPrompt(replyTo)) {
      return parse(event.text).intent === "CANCEL" ? cancelReply() : opnameSearch(event.text.trim());
    }
    if (isUpdateSearchPrompt(replyTo)) {
      return parse(event.text).intent === "CANCEL" ? cancelReply() : updateSearch(event.text.trim());
    }
    const prompt = openSealedMessage("QTY", replyTo, scope, now);
    if (prompt.status === "EXPIRED") return stockSummaryExpiredReply();
    const target = prompt.status === "VALID" ? parseQuantityPrompt(prompt.body) : null;
    if (target) return enterQuantity(target.intent, target.sku, event.text);
    const opnamePrompt = openSealedMessage("OPQ", replyTo, scope, now);
    if (opnamePrompt.status === "EXPIRED") return stockSummaryExpiredReply();
    const opnameTarget = opnamePrompt.status === "VALID" ? parseOpnameQuantityPrompt(opnamePrompt.body) : null;
    if (opnameTarget) return enterOpnameQuantity(opnameTarget.sku, event.text);
  }
  const repliesToSummary = replyTo !== undefined && openSealedMessage("UPD", replyTo, scope, now).status !== "INVALID";
  const repliesToOpname = replyTo !== undefined && openSealedMessage("OPN", replyTo, scope, now).status !== "INVALID";

  // A bare number is only a quantity inside a quantity question (handled above).
  // Outside one it may still be an exact numeric SKU, but never a partial search.
  const bare = event.text.normalize("NFKC").trim();
  if (/^[+-]?\d+(?:[.,]\d+)*$/.test(bare)) {
    return guarded("Gagal membaca data inventory", async () => {
      const result = await find({ intent: "CHECK_STOCK", product_query: bare, quantity: null, match: "exact_sku" });
      return result.status === "SUCCESS" && "product" in result
        ? formatInventoryResult(result, { ...context, query: bare })
        : bareNumberReply(bare);
    });
  }

  const parsed = parse(event.text);
  if (isStockIntent(parsed)) return parsed.items.length ? planStock(parsed) : updateSearchPromptReply();
  switch (parsed.intent) {
    case "START": return startReply();
    case "HELP": return parsed.topic ? helpTopicReply(parsed.topic) : helpReply();
    case "TRANSACTION_HISTORY": return showHistory(parsed);
    case "STOCK_ANALYSIS": return showAnalysis(parsed);
    case "REPORT": return sendReport();
    case "STOCK_OPNAME": return opnameSearchPromptReply();
    case "RESTOCK_RECOMMENDATION": return showRestock();
    case "INTEREST": return interestReply();
    case "CONTACT_SUPPLIER":
    case "LIST_SUPPLIERS": return listSuppliers();
    case "CANCEL": return repliesToSummary ? stockCancelledReply() : repliesToOpname ? opnameCancelledReply() : cancelReply();
    // "ya" confirms only the summary it replies to, never whatever was sent last.
    case "CONFIRM": return repliesToSummary ? confirmStock(replyTo!) : repliesToOpname ? confirmOpname(replyTo!) : nothingToConfirmReply();
    case "UNKNOWN": return unknownReply();
    case "UPDATE_STOCK": return updateSearchPromptReply();
    case "LOW_STOCK": return readLowStock();
    case "STOCK_FILTER": return readInventory(parsed);
    default: return readInventory(parsed, 0, true);
  }
}
