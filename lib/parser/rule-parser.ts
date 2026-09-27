import type {
  OrderItemRequest, ProductReadIntent, SimpleIntent, StockChangeIntent, StockItemRequest, StructuredIntent,
} from "./intents";

function simple(intent: SimpleIntent): StructuredIntent {
  return { intent, product_query: null, quantity: null };
}

// A deterministic heuristic, not a product dictionary. Unknown names remain searches.
function isProductQuery(query: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(query) || !/^[\p{L}\p{N}\s._/'()&+%-]+$/u.test(query)) return false;
  if (/^(?:barang|produk)$/.test(query)) return false;
  if (/(?:^|\s)(?:cek|lihat|periksa|berapa|stok|stoknya|cari|carikan|temukan|search|tambah|tambahkan|kurangi|kurang|kurangkan|set|atur|ubah|buat|pesanan|order|batal|cancel|confirm|konfirmasi|bantuan|help|hapus|delete|update|kirim|hitung|jual|beli|bayar|transfer|tolong|mohon|ceritakan|jelaskan|tampilkan|lalu|kemudian)(?=\s|$)/.test(query)) return false;
  return !/^(?:apa|apakah|bagaimana|kenapa|mengapa|siapa|kapan|dimana|di mana|halo|hai|hello|hi|terima kasih|makasih|selamat|saya|aku|kamu|cuaca|harga|ya|iya|tidak|nggak|oke|ok)(?=\s|$)/.test(query);
}

function product(intent: ProductReadIntent, query: string): StructuredIntent {
  return isProductQuery(query) ? { intent, product_query: query, quantity: null } : simple("UNKNOWN");
}

function normalize(input: string): string {
  return input.normalize("NFKC").toLowerCase()
    // A line break after a quantity (or "masuk:") separates list items.
    .replace(/(\d(?:[ \t]*[a-z]{1,12})?)[ \t]*\r?\n\s*/g, "$1, ")
    .replace(/:[ \t]*\r?\n\s*/g, ": ")
    .trim().replace(/\s+/g, " ")
    .replace(/[?!]+$/, "").trim()
    .replace(/^(?:(?:tolong|mohon|coba)\s+)+/, "")
    .replace(/\s+(?:dong|ya)$/, "").trim();
}

/** Pure language parser: no environment, inventory lookup, network, or side effects. */
export function parseRuleIntent(input: string): StructuredIntent {
  const text = normalize(input);
  if (!text || text.length > 500) return simple("UNKNOWN");
  const command = text.match(/^\/(start|menu|help)(?:@[a-z0-9_]+)?(?:\s.*)?$/);
  if (command) return simple(command[1] === "help" ? "HELP" : "START");

  // Menu labels arrive as "<emoji> <label>"; dropping the emoji lets typed and tapped
  // text share one rule set. "stock" is a common spelling of "stok".
  const phrase = text.replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]+\s*/u, "")
    .replace(/\bstock(nya)?\b/g, "stok$1");
  if (!phrase) return simple("UNKNOWN");
  return parsePhrase(phrase);
}

// Words that turn a bare item list into a stock command. Also used to rebuild a
// request so it can be parsed again after the user picks a product.
export const STOCK_COMMAND_WORDS: Record<StockChangeIntent, string> = {
  ADD_STOCK: "barang masuk",
  REDUCE_STOCK: "barang keluar",
  SET_STOCK: "koreksi stok",
};

const STOCK_PREFIXES: [RegExp, StockChangeIntent][] = [
  [/^(?:tambah(?:kan)?(?:\s+stok)?|(?:barang|stok)\s+masuk|masuk|restock)(?:\s*:\s*|\s+|$)(.*)$/, "ADD_STOCK"],
  [/^(?:kurang(?:i|kan)?(?:\s+stok)?|(?:barang|stok)\s+keluar|keluar)(?:\s*:\s*|\s+|$)(.*)$/, "REDUCE_STOCK"],
  [/^(?:koreksi(?:\s+stok)?|(?:set|atur|ubah|sesuaikan)(?:\s+stok)?)(?:\s*:\s*|\s+|$)(.*)$/, "SET_STOCK"],
];

const MAX_LIST_ITEMS = 50;
// A comma directly followed by a digit is a decimal comma ("2,5"), not a separator.
const LIST_SEPARATOR = /\s*(?:,(?!\d)|;|\s+dan\s+)\s*/;
const AMOUNT = String.raw`(\d+(?:[.,]\d+)*)`;

// "1.500" is Indonesian for 1500; "1.5" and "2,5" are decimals.
function parseAmount(value: string): number {
  if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) return Number(value.replace(/\./g, ""));
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(value)) return Number(value.replace(/\./g, "").replace(",", "."));
  return /^\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(",", ".")) : Number.NaN;
}

// "minyak 20", "minyak +20", "minyak jadi 50", "minyak = 50", "beras 50 kg".
const STOCK_ITEM = new RegExp(String.raw`^(.+?)(?:\s+(?:jadi|menjadi)\s+|\s*=\s*|\s+)([+-]?)\s*${AMOUNT}(?:\s*[a-z]{1,12})?$`);

function parseStockItems(intent: StockChangeIntent, list: string): StockItemRequest[] | null {
  const parts = list.split(LIST_SEPARATOR).filter(Boolean);
  if (parts.length > MAX_LIST_ITEMS) return null;
  const items: StockItemRequest[] = [];
  for (const part of parts) {
    const match = part.match(STOCK_ITEM);
    // An item without a readable number stays in the list with NaN, so the reply can
    // say "jumlah tidak valid" instead of treating the message as a search.
    const query = match ? match[1] : part;
    if (!isProductQuery(query)) return null;
    let quantity = match ? parseAmount(match[3]) : Number.NaN;
    if (match?.[2] === "-") quantity = -quantity;
    // "koreksi minyak +5" reads like a change rather than a target, so it is rejected.
    if (match?.[2] === "+" && intent === "SET_STOCK") quantity = Number.NaN;
    items.push({ product_query: query, quantity });
  }
  return items;
}

function stockCommand(intent: StockChangeIntent, list: string): StructuredIntent {
  const items = parseStockItems(intent, list);
  return items ? { intent, product_query: null, quantity: null, items } : simple("UNKNOWN");
}

// "minyak +20, gula +30" (all +) or "minyak -5, gula -2" (all -), without a command word.
function signedStockList(text: string): StructuredIntent | null {
  const parts = text.split(LIST_SEPARATOR).filter(Boolean);
  const signed = parts.map((part) => part.match(new RegExp(String.raw`^(.+?)\s+([+-])\s*${AMOUNT}(?:\s*[a-z]{1,12})?$`)));
  if (!parts.length || parts.length > MAX_LIST_ITEMS || signed.some((match) => !match || !isProductQuery(match[1]))) return null;
  const signs = new Set(signed.map((match) => match![2]));
  if (signs.size !== 1) return null;
  const intent: StockChangeIntent = signs.has("+") ? "ADD_STOCK" : "REDUCE_STOCK";
  return { intent, product_query: null, quantity: null, items: signed.map((match) => ({ product_query: match![1], quantity: parseAmount(match![3]) })) };
}

/**
 * Reads a reply to a stock prompt ("📥 Barang Masuk"): a bare list such as
 * "minyak 20, gula 30" is read as that command. A full command is kept as typed.
 */
export function parseStockReply(intent: StockChangeIntent, input: string): StructuredIntent {
  const direct = parseRuleIntent(input);
  if (direct.intent === "CHECK_STOCK" || direct.intent === "SEARCH_PRODUCT" || direct.intent === "UNKNOWN") {
    const text = normalize(input);
    if (text) return stockCommand(intent, text);
  }
  return direct;
}

// Asking a supplier for goods: "pesan minyak 20", "butuh minyak 20 botol dan gula 30 kg".
const ORDER_PREFIX = /^(?:(?:buat|bikin)(?:kan)?\s+(?:pesanan|order)|pesan(?:kan)?(?:\s+barang)?|order|butuh|perlu|kebutuhan(?:\s+barang)?)(?:\s*:\s*|\s+)(.+)$/;
const ORDER_PROMPT = /^(?:(?:buat|bikin)(?:kan)?\s+)?(?:pesanan|order)$|^(?:pesan(?:kan)?(?:\s+barang)?|butuh|perlu|kebutuhan(?:\s+barang)?)$/;

/**
 * Reads a reply to the "Pesan Barang" prompt: a bare list such as
 * "minyak goreng 20, gula 30" is a supplier request.
 */
export function parseOrderReply(input: string): StructuredIntent {
  const direct = parseRuleIntent(input);
  if (direct.intent === "CREATE_ORDER" || direct.intent === "CANCEL" || direct.intent === "START" || direct.intent === "HELP") return direct;
  const items = parseOrderItems(normalize(input));
  return items ? { intent: "CREATE_ORDER", product_query: null, quantity: null, items } : simple("CREATE_ORDER");
}

// "minyak goreng 20, gula pasir 30 kg": the last number is the quantity and an optional
// trailing unit word is accepted but not trusted; the sheet's unit is used instead.
function parseOrderItems(list: string): OrderItemRequest[] | null {
  const parts = list.split(LIST_SEPARATOR).filter(Boolean);
  if (!parts.length || parts.length > 10) return null;
  const items: OrderItemRequest[] = [];
  for (const part of parts) {
    const match = part.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)(?:\s+[a-z]{1,12})?$/);
    if (!match || !isProductQuery(match[1])) return null;
    const quantity = Number(match[2].replace(",", "."));
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > Number.MAX_SAFE_INTEGER) return null;
    items.push({ product_query: match[1], quantity });
  }
  return items;
}

function parsePhrase(text: string): StructuredIntent {
  if (/^(?:menu|menu utama|kembali|mulai)$/.test(text)) return simple("START");
  if (/^(?:batal|batalkan|tidak|nggak|enggak|cancel|no)$/.test(text)) return simple("CANCEL");
  if (/^(?:ya|iya|yap|ok|oke|konfirmasi|confirm|yes)$/.test(text)) return simple("CONFIRM");
  if (/^(?:bantuan|help|cara pakai)$/.test(text)) return simple("HELP");
  if (/^(?:laporan|lihat laporan|report)$/.test(text)) return simple("REPORT");
  if (/^(?:update|perbarui|ubah)\s+stok$/.test(text)) return simple("UPDATE_STOCK");
  if (/^(?:hubungi|kontak)\s+supplier$|^supplier$/.test(text)) return simple("CONTACT_SUPPLIER");
  if (/^(?:lihat|daftar)\s+supplier$/.test(text)) return simple("LIST_SUPPLIERS");
  if (ORDER_PROMPT.test(text)) return simple("CREATE_ORDER");

  const order = text.match(ORDER_PREFIX);
  if (order) {
    const items = parseOrderItems(order[1]);
    // An incomplete order still opens the order guide instead of a product search.
    return items ? { intent: "CREATE_ORDER", product_query: null, quantity: null, items } : simple("CREATE_ORDER");
  }

  if (/^(?:(?:cek|lihat|cari|tampilkan)\s+)?(?:barang|produk|stok)(?:\s+apa)?(?:\s+yang)?(?:\s+stoknya)?\s+(?:hampir habis|menipis|habis|rendah|di bawah minimum)$/.test(text)) {
    return simple("LOW_STOCK");
  }

  for (const [pattern, intent] of STOCK_PREFIXES) {
    const match = text.match(pattern);
    if (match) return stockCommand(intent, match[1].trim());
  }
  const signed = signedStockList(text);
  if (signed) return signed;

  // A bare command opens the matching prompt ("cek stok", "cari barang").
  if (/^(?:(?:cek|lihat|periksa|berapa)\s+)?(?:sisa\s+)?stok(?:nya)?$/.test(text)) return { intent: "CHECK_STOCK", product_query: "", quantity: null };
  if (/^(?:cari|carikan|temukan|search)(?:\s+(?:barang|produk))?$/.test(text)) return { intent: "SEARCH_PRODUCT", product_query: "", quantity: null };

  const search = text.match(/^(?:cari|carikan|temukan|search)(?:\s+(?:barang|produk))?\s+(.+)$/);
  if (search) return product("SEARCH_PRODUCT", search[1]);

  const stockPrefix = text.match(/^(?:berapa(?:\s+(?:sisa\s+)?stok(?:nya)?)?|(?:cek|lihat|periksa)(?:\s+(?:sisa\s+)?stok(?:nya)?)?|stok(?:nya)?)\s+(.+)$/);
  if (stockPrefix) {
    const query = stockPrefix[1].replace(/\s+(?:(?:masih\s+)?(?:ada|tinggal|sisa|tersisa)\s+)?berapa(?:\s+lagi)?$/, "").trim();
    return product("CHECK_STOCK", query);
  }

  const stockSuffix = text.match(/^(.+?)\s+(?:(?:masih\s+)?(?:ada|tinggal|sisa|tersisa|stok|stoknya)\s+)?berapa(?:\s+lagi)?$/);
  if (stockSuffix) return product("CHECK_STOCK", stockSuffix[1]);

  return product("SEARCH_PRODUCT", text);
}
