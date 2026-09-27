import type {
  AnalysisMetric, HelpTopic, MissingField, ParseResult, ProductReadIntent, SimpleIntent, StockChangeIntent,
  StockFilter, StockItemRequest, StructuredIntent,
} from "./intents";
import { closestKeyword } from "./fuzzy";
import { COUNT_MULTIPLIERS, parseAmount, parseQuantityPhrase } from "./numbers";
import { extractPeriod } from "./period";
import { canonicalUnit, isKnownUnit } from "./units";

/*
 * Pipeline, each stage pure and separately testable:
 *   1. normalize()        case, spacing, punctuation, emoji, slang ("brp" → "berapa")
 *   2. parsePhrase()      intent rules in priority order (commands before searches)
 *   3. entity helpers     quantities + units, periods, filters, product text
 *   4. typo fallback      only when nothing matched, command words are corrected once
 *   5. analyzeMessage()   flat ParseResult with confidence and missing fields
 * Product text is never looked up here; matching against the sheet happens later.
 */

function simple(intent: SimpleIntent): StructuredIntent {
  return { intent, product_query: null, quantity: null };
}

// ---------------------------------------------------------------- 1. normalization

// Chat spellings mapped word by word. Keys are whole words only, so SKUs such as
// "BRG0006" are never touched.
const SLANG: Record<string, string> = {
  brp: "berapa", brapa: "berapa", berapakah: "berapa", brpa: "berapa",
  stock: "stok", stocknya: "stoknya", stk: "stok",
  gk: "tidak", ga: "tidak", gak: "tidak", nggak: "tidak", ngga: "tidak", enggak: "tidak", engga: "tidak", tdk: "tidak", ndak: "tidak",
  yg: "yang", dgn: "dengan", utk: "untuk", tgl: "tanggal", sampe: "sampai", smp: "sampai", hr: "hari", bln: "bulan", mgg: "minggu",
  udh: "sudah", udah: "sudah", sdh: "sudah", blm: "belum", lg: "lagi", aja: "saja", tlg: "tolong", gmn: "bagaimana", gimana: "bagaimana",
  dibawah: "di bawah", diatas: "di atas", brg: "barang", jml: "jumlah", kmrn: "kemarin", kemaren: "kemarin",
  histori: "riwayat", history: "riwayat",
};

function normalize(input: string): string {
  return input.normalize("NFKC").toLowerCase()
    // A line break after a quantity (or "masuk:") separates list items.
    .replace(/(\d(?:[ \t]*[a-z]{1,12})?)[ \t]*\r?\n\s*/g, "$1, ")
    .replace(/:[ \t]*\r?\n\s*/g, ": ")
    .trim().replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "").trim()
    .replace(/^(?:(?:tolong|mohon|coba)\s+)+/, "")
    .replace(/\s+(?:dong|ya|kak|gan|bos)$/, "").trim();
}

function applySlang(text: string): string {
  return text.split(" ").map((word) => SLANG[word] ?? word).join(" ")
    .replace(/^(?:(?:tolong|mohon|coba)\s+)+/, "");
}

/** Pure language parser: no environment, inventory lookup, network, or side effects. */
export function parseRuleIntent(input: string): StructuredIntent {
  return parseDetailed(input).structured;
}

function parseDetailed(input: string): { structured: StructuredIntent; corrected: boolean } {
  const text = normalize(input);
  if (!text || text.length > 500) return { structured: simple("UNKNOWN"), corrected: false };
  const command = text.match(/^\/(start|menu|help)(?:@[a-z0-9_]+)?(?:\s.*)?$/);
  if (command) return { structured: command[1] === "help" ? help() : simple("START"), corrected: false };

  // Menu labels arrive as "<emoji> <label>"; dropping the emoji lets typed and tapped
  // text share one rule set.
  const phrase = applySlang(text.replace(/^[\p{Extended_Pictographic}️‍⃣]+\s*/u, "")).trim();
  if (!phrase) return { structured: simple("UNKNOWN"), corrected: false };
  const parsed = parsePhrase(phrase);
  if (!isFallback(parsed, phrase)) return { structured: parsed, corrected: false };
  const corrected = correctTypos(phrase);
  return corrected ? { structured: corrected, corrected: true } : { structured: parsed, corrected: false };
}

// ---------------------------------------------------------------- 3. entities: product text

// A deterministic heuristic, not a product dictionary. Unknown names remain searches.
const COMMAND_WORDS = /(?:^|\s)(?:cek|lihat|periksa|berapa|stok|stoknya|cari|carikan|temukan|search|tambah|tambahkan|kurangi|kurang|kurangkan|set|atur|ubah|koreksi|sesuaikan|restock|buat|pesanan|order|batal|cancel|confirm|konfirmasi|bantuan|help|hapus|delete|update|kirim|hitung|jual|beli|bayar|transfer|tolong|mohon|ceritakan|jelaskan|tampilkan|tunjukkan|lalu|kemudian|riwayat|transaksi)(?=\s|$)/;
const NOT_A_PRODUCT_START = /^(?:apa|apakah|bagaimana|kenapa|mengapa|siapa|kapan|dimana|di mana|halo|hai|hello|hi|terima kasih|makasih|selamat|saya|aku|kamu|cuaca|harga|ya|iya|tidak|oke|ok)(?=\s|$)/;

function isProductQuery(query: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(query) || !/^[\p{L}\p{N}\s._/'()&+%-]+$/u.test(query)) return false;
  if (/^(?:barang|produk|item)$/.test(query)) return false;
  if (COMMAND_WORDS.test(query)) return false;
  return !NOT_A_PRODUCT_START.test(query);
}

function product(intent: ProductReadIntent, query: string): StructuredIntent {
  return isProductQuery(query) ? { intent, product_query: query, quantity: null } : simple("UNKNOWN");
}

/** SKU-looking text: letters then digits, e.g. "brg0006", "abc-001", "sku12". */
export function looksLikeSku(query: string): boolean {
  return /^[a-z]{1,6}[-_.]?\d{2,}[a-z0-9-]*$/i.test(query.trim());
}

// ---------------------------------------------------------------- 3. entities: quantities and units

export interface QuantityText { quantity: number; unit?: string; sign?: "+" | "-" }

const FILLER_TAIL = /\s+(?:lagi|saja|doang|nya)$/;
const QUANTITY_LEAD = /^(?:jadi|menjadi|sebanyak|sejumlah|=)\s*/;
const MULTIPLIER_WORDS = Object.keys(COUNT_MULTIPLIERS).join("|");
const DIGIT_QUANTITY = new RegExp(String.raw`^(\d+(?:[.,]\d+)*)(?:\s*(${MULTIPLIER_WORDS}))?(?:\s*([a-z]{1,12}))?$`);

/**
 * Reads text that is only a quantity: "20", "+5", "2,5 kg", "dua puluh", "setengah
 * lusin", "3 dus". NaN quantity means a number was expected but is unreadable.
 * Returns null when the text is not a quantity at all.
 */
export function parseQuantityText(value: string): QuantityText | null {
  let text = value.trim().replace(QUANTITY_LEAD, "").replace(FILLER_TAIL, "").trim();
  let sign: "+" | "-" | undefined;
  const signed = text.match(/^([+-])\s*(.*)$/);
  if (signed) { sign = signed[1] as "+" | "-"; text = signed[2]; }
  if (!text) return null;
  const digits = text.match(DIGIT_QUANTITY);
  if (digits) {
    let quantity = parseAmount(digits[1]);
    if (digits[2]) quantity = Math.round(quantity * COUNT_MULTIPLIERS[digits[2]] * 1e6) / 1e6;
    return { quantity, ...(digits[3] ? { unit: canonicalUnit(digits[3]) } : {}), ...(sign ? { sign } : {}) };
  }
  const words = text.split(" ");
  const unit = words.length > 1 && isKnownUnit(words.at(-1)!) && !(words.at(-1)! in COUNT_MULTIPLIERS) ? words.pop() : undefined;
  const quantity = parseQuantityPhrase(words.join(" "));
  if (quantity === null) return null;
  return { quantity, ...(unit ? { unit: canonicalUnit(unit) } : {}), ...(sign ? { sign } : {}) };
}

/**
 * Splits "minyak goreng 2 liter 20 botol" into product text and the trailing quantity.
 * The shortest product text that leaves a readable quantity wins, so sizes inside
 * product names ("2 liter") stay part of the name.
 */
export function splitTrailingQuantity(text: string): { query: string; quantity: QuantityText } | null {
  const spaced = text.replace(/\s*=\s*/g, " = ").replace(/\s+/g, " ").trim();
  const words = spaced.split(" ");
  for (let cut = 1; cut < words.length; cut++) {
    const query = words.slice(0, cut).join(" ").replace(/\s+(?:jadi|menjadi|=)$/, "");
    const quantity = parseQuantityText(words.slice(cut).join(" "));
    if (quantity && query && !/^(?:jadi|menjadi|=)$/.test(query)) return { query, quantity };
  }
  return null;
}

function toItem(query: string, quantity: QuantityText | null): StockItemRequest {
  return { product_query: query, quantity: quantity ? quantity.quantity : Number.NaN, ...(quantity?.unit ? { unit: quantity.unit } : {}) };
}

/**
 * The quantity typed in the product-first Update Stok flow: a plain number only.
 * "20", "1,5", and "1.500" (thousands) are accepted; "20 kg" or "beras 20" are not.
 */
export function parseQuantityInput(input: string): number | null {
  const text = input.normalize("NFKC").trim();
  return /^\d+(?:[.,]\d+)*$/.test(text) && Number.isFinite(parseAmount(text)) ? parseAmount(text) : null;
}

/**
 * The answer to a quantity question when the product is already known: a number or
 * number words, optionally with a unit ("20", "20 botol", "dua lusin", "500 gram").
 * Signs and product names are refused. The caller checks the unit against the product.
 */
export function parseQuantityReply(input: string): { quantity: number; unit: string | null } | null {
  const text = normalize(input);
  if (!text || /^[+-]/.test(text)) return null;
  const parsed = parseQuantityText(text);
  if (!parsed || parsed.sign || !Number.isFinite(parsed.quantity)) return null;
  return { quantity: parsed.quantity, unit: parsed.unit ?? null };
}

// ---------------------------------------------------------------- 2. intent rules

// Words that turn a bare item list into a stock command. Also used to rebuild a
// request so it can be parsed again after the user picks a product.
export const STOCK_COMMAND_WORDS: Record<StockChangeIntent, string> = {
  ADD_STOCK: "barang masuk",
  REDUCE_STOCK: "barang keluar",
  SET_STOCK: "koreksi stok",
};

/**
 * Synonym dictionary. Extend a list to teach the parser a new word; the rules below
 * are built from these lists.
 */
export const SYNONYMS = {
  /** Command first: "tambah beras 5", "baru datang gula 10". */
  addPrefix: ["tambah", "tambahkan", "tambah stok", "tambahkan stok", "barang masuk", "stok masuk", "barang datang", "baru datang", "datang", "masuk", "masukkan", "restock", "terima barang", "input masuk"],
  reducePrefix: ["kurangi", "kurangkan", "kurang", "kurangi stok", "kurangkan stok", "kurang stok", "barang keluar", "stok keluar", "keluar", "keluarkan", "terjual", "jual", "barang terjual", "pakai"],
  setPrefix: ["koreksi", "koreksi stok", "set", "set stok", "atur", "atur stok", "ubah", "ubah stok", "sesuaikan", "sesuaikan stok", "ganti stok"],
  /** Product first: "minyak masuk 20", "beras terjual 10 kg", "stok minyak sekarang 25". */
  addAfter: ["masuk", "datang", "bertambah", "diterima", "ditambah", "tambah"],
  reduceAfter: ["keluar", "terjual", "laku", "dijual", "dipakai", "terpakai", "berkurang", "dikurangi"],
  setAfter: ["sekarang", "jadi", "menjadi", "seharusnya", "harusnya", "sebenarnya", "yang benar", "aslinya"],
  /** "sisa", "tersisa", "tinggal": asking how much stock is left. */
  stockWords: ["stok", "stoknya", "sisa", "tersisa", "tinggal", "jumlah", "persediaan"],
  searchPrefix: ["cari", "carikan", "temukan", "search", "tampilkan", "tunjukkan", "cari barang", "cari produk"],
  cancel: ["batal", "batalkan", "tidak", "cancel", "no", "tidak jadi", "tidak usah", "jangan", "stop", "gajadi", "gakjadi", "urungkan"],
  confirm: ["ya", "iya", "yap", "ok", "oke", "okay", "konfirmasi", "confirm", "yes", "lanjut", "lanjutkan", "simpan", "setuju", "benar", "betul", "ya simpan", "ya lanjut", "ya benar", "oke simpan", "sip", "siap"],
} as const;

const alternatives = (words: readonly string[]) => [...words].sort((a, b) => b.length - a.length).map((word) => word.replace(/\s+/g, "\\s+")).join("|");

const STOCK_PREFIXES: [RegExp, StockChangeIntent][] = [
  [new RegExp(`^(?:${alternatives(SYNONYMS.addPrefix)})(?:\\s*:\\s*|\\s+|$)(.*)$`), "ADD_STOCK"],
  [new RegExp(`^(?:${alternatives(SYNONYMS.reducePrefix)})(?:\\s*:\\s*|\\s+|$)(.*)$`), "REDUCE_STOCK"],
  [new RegExp(`^(?:${alternatives(SYNONYMS.setPrefix)})(?:\\s*:\\s*|\\s+|$)(.*)$`), "SET_STOCK"],
];
const VERBS_AFTER: [readonly string[], StockChangeIntent][] = [
  [SYNONYMS.addAfter, "ADD_STOCK"], [SYNONYMS.reduceAfter, "REDUCE_STOCK"], [SYNONYMS.setAfter, "SET_STOCK"],
];
const CANCEL = new RegExp(`^(?:${alternatives(SYNONYMS.cancel)})$`);
const CONFIRM = new RegExp(`^(?:${alternatives(SYNONYMS.confirm)})$`);

const MAX_LIST_ITEMS = 50;
// A comma directly followed by a digit is a decimal comma ("2,5"), not a separator.
const LIST_SEPARATOR = /\s*(?:,(?!\d)|;|\s+dan\s+)\s*/;

function parseStockItems(intent: StockChangeIntent, list: string): StockItemRequest[] | null {
  const parts = list.split(LIST_SEPARATOR).filter(Boolean);
  if (parts.length > MAX_LIST_ITEMS) return null;
  const items: StockItemRequest[] = [];
  for (const part of parts) {
    const split = splitTrailingQuantity(part);
    // An item without a readable number stays in the list with NaN, so the reply can
    // say "jumlah tidak valid" instead of treating the message as a search.
    const query = split ? split.query : part;
    if (!isProductQuery(query)) return null;
    const item = toItem(query, split?.quantity ?? null);
    if (split?.quantity.sign === "-") item.quantity = -item.quantity;
    // "koreksi minyak +5" reads like a change rather than a target, so it is rejected.
    if (split?.quantity.sign === "+" && intent === "SET_STOCK") item.quantity = Number.NaN;
    items.push(item);
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
  if (!parts.length || parts.length > MAX_LIST_ITEMS) return null;
  const items: StockItemRequest[] = [];
  const signs = new Set<string>();
  for (const part of parts) {
    const match = part.match(/^(.+?)\s+([+-])\s*(\S.*)$/);
    const quantity = match ? parseQuantityText(match[3]) : null;
    if (!match || !quantity || quantity.sign || !isProductQuery(match[1])) return null;
    signs.add(match[2]);
    items.push(toItem(match[1], quantity));
  }
  if (signs.size !== 1) return null;
  return { intent: signs.has("+") ? "ADD_STOCK" : "REDUCE_STOCK", product_query: null, quantity: null, items };
}

// "minyak masuk 20", "beras terjual 10 kg", "stok minyak sekarang 25": the verb follows the product.
function verbAfterProduct(text: string): StructuredIntent | null {
  const parts = text.split(LIST_SEPARATOR).filter(Boolean);
  if (!parts.length || parts.length > MAX_LIST_ITEMS) return null;
  // "minyak masuk" without a number: a stock change whose quantity is still missing.
  const bare = parts.length === 1 ? parts[0].replace(/^stok\s+/, "") : "";
  for (const [verbs, intent] of VERBS_AFTER.slice(0, 2)) {
    const match = bare.match(new RegExp(`^(.+?)\\s+(?:${alternatives(verbs)})$`));
    if (match && isProductQuery(match[1])) return { intent, product_query: null, quantity: null, items: [toItem(match[1], null)] };
  }
  let found: StockChangeIntent | null = null;
  const items: StockItemRequest[] = [];
  for (const raw of parts) {
    const part = raw.replace(/^stok\s+/, "");
    let matched = false;
    for (const [verbs, intent] of VERBS_AFTER) {
      const match = part.match(new RegExp(`^(.+?)\\s+(?:stok(?:nya)?\\s+)?(?:${alternatives(verbs)})\\s+(?:ada\\s+|jadi\\s+)?(\\S.*)$`));
      const quantity = match ? parseQuantityText(match[2]) : null;
      if (!match || !quantity || quantity.sign || !isProductQuery(match[1])) continue;
      if (found && found !== intent) return null;
      found = intent;
      items.push(toItem(match[1], quantity));
      matched = true;
      break;
    }
    if (!matched) return null;
  }
  return found ? { intent: found, product_query: null, quantity: null, items } : null;
}

// Supplier ordering is not offered; these phrases open the supplier directory instead.
const SUPPLIER_PHRASE = /^(?:(?:buat|bikin)(?:kan)?\s+)?(?:pesanan|order)(?:\s.*)?$|^(?:pesan(?:kan)?|butuh|perlu|kebutuhan)(?:\s.*)?$/;

function help(topic?: HelpTopic): StructuredIntent {
  return topic ? { intent: "HELP", product_query: null, quantity: null, topic } : { intent: "HELP", product_query: null, quantity: null };
}

const GENERAL_HELP = /^(?:bantuan|help|cara pakai|cara pakainya|cara penggunaan|cara menggunakan|menu bantuan|panduan|tutorial|petunjuk|bantu|bantu saya|(?:bagaimana\s+)?cara(?:nya)?\s+pakai(?:nya)?|(?:apa|fitur)\s+(?:saja\s+)?(?:yang\s+)?(?:bisa\s+(?:dilakukan|kamu lakukan)|tersedia)|(?:kamu|bot ini|faststock)\s+bisa\s+apa(?:\s+saja)?|bisa\s+apa(?:\s+saja)?|fitur\s+apa\s+saja)$/;
const HELP_TOPIC_PREFIX = /^(?:bantuan|panduan|help|tutorial|petunjuk|(?:bagaimana\s+)?cara(?:nya)?)\s+(?:untuk\s+|melakukan\s+|menggunakan\s+)?(.+)$/;

function helpTopic(rest: string): HelpTopic | null {
  if (/^(?:(?:cek|lihat|periksa)\s+stok|cari(?:\s+(?:barang|produk))?|pencarian|mencari(?:\s+barang)?|cek\s+barang)$/.test(rest)) return "stock";
  if (/^(?:(?:update|ubah|perbarui|tambah|kurangi|koreksi)\s+stok|barang\s+(?:masuk|keluar)|koreksi|mengubah\s+stok|input\s+stok)$/.test(rest)) return "update";
  if (/^(?:stok\s+opname|opname(?:\s+stok)?|menghitung\s+stok|hitung\s+stok)$/.test(rest)) return "opname";
  if (/^(?:laporan|lihat\s+laporan|riwayat|riwayat\s+transaksi|transaksi|analisis|analisa)$/.test(rest)) return "report";
  return null;
}

// ---- stock filter: "barang di bawah 10", "stok kurang dari 5 pcs", "stok antara 10 sampai 20"

const FILTER_SUBJECT = String.raw`^(?:(?:tampilkan|lihat|cek|cari|daftar|mana|apa)\s+)?(?:(?:saja\s+)?(?:barang|produk|item|stok)\s+)?(?:(?:apa|mana)\s+(?:saja\s+)?)?(?:yang\s+)?(?:stok(?:nya)?\s+|jumlah(?:nya)?\s+|sisa(?:nya)?\s+)?`;
const FILTER_NUMBER = String.raw`(\d+(?:[.,]\d+)*)`;
const FILTER_UNIT = String.raw`(?:\s*([a-z]{1,12}))?`;
const FILTER_OPS: [string, "lt" | "lte" | "gt" | "gte" | "eq"][] = [
  [String.raw`(?:di\s+bawah|kurang\s+dari|lebih\s+kecil\s+dari|<)`, "lt"],
  [String.raw`(?:maksimal|maks|paling\s+banyak|tidak\s+lebih\s+dari|<=|≤)`, "lte"],
  [String.raw`(?:di\s+atas|lebih\s+dari|lebih\s+besar\s+dari|>)`, "gt"],
  [String.raw`(?:minimal|min|paling\s+sedikit|>=|≥)`, "gte"],
  [String.raw`(?:sama\s+dengan|tepat|pas|=)`, "eq"],
];

function filterUnit(unit: string | undefined): { unit?: string } {
  return unit && isKnownUnit(unit) ? { unit: canonicalUnit(unit) } : {};
}

function parseFilter(text: string): StockFilter | null | "INVALID" {
  const between = text.match(new RegExp(`${FILTER_SUBJECT}(?:antara|dari)\\s+${FILTER_NUMBER}${FILTER_UNIT}\\s*(?:sampai|hingga|dan|s\\/d|sd|-|–)\\s*${FILTER_NUMBER}${FILTER_UNIT}$`));
  if (between && (!between[2] || isKnownUnit(between[2])) && (!between[4] || isKnownUnit(between[4]))) {
    const min = parseAmount(between[1]);
    const max = parseAmount(between[3]);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return "INVALID";
    return { op: "between", min: Math.min(min, max), max: Math.max(min, max), ...filterUnit(between[4] ?? between[2]) };
  }
  for (const [operator, op] of FILTER_OPS) {
    const match = text.match(new RegExp(`${FILTER_SUBJECT}${operator}\\s*${FILTER_NUMBER}${FILTER_UNIT}$`));
    if (!match || (match[2] && !isKnownUnit(match[2]))) continue;
    const value = parseAmount(match[1]);
    return Number.isFinite(value) ? { op, value, ...filterUnit(match[2]) } : "INVALID";
  }
  if (/^(?:(?:barang|produk|item)\s+)?(?:(?:apa|mana)\s+(?:saja\s+)?)?(?:yang\s+)?(?:stok(?:nya)?\s+)?(?:kosong|nol|0)$/.test(text) && /kosong|nol|stok/.test(text)) {
    return { op: "lte", value: 0 };
  }
  return null;
}

// ---- low stock: any mix of filler words around one "low" phrase

const LOW_PHRASES = /(?:hampir|mau|akan|sudah|segera)\s+habis|menipis|tipis|kritis|minim|sedikit|rendah|habis|di\s+bawah\s+(?:stok\s+)?minimum|(?:perlu|harus|butuh)\s+(?:di)?restock|(?:perlu|harus)\s+(?:dibeli|belanja|diisi)(?:\s+lagi)?/;
const LOW_FILLERS = new Set(["barang", "produk", "item", "stok", "stoknya", "apa", "saja", "yang", "mana", "cek", "lihat", "tampilkan", "cari", "daftar", "list", "ada", "sekarang", "lagi", "sudah", "di", "toko", "gudang", "semua", "status"]);

function isLowStock(text: string): boolean {
  const marked = text.replace(new RegExp(`(?<=^|\\s)(?:${LOW_PHRASES.source})(?=\\s|$)`, "g"), " LOW ").trim().split(/\s+/);
  return marked.includes("LOW") && marked.every((word) => word === "LOW" || LOW_FILLERS.has(word)) && marked.filter((word) => word === "LOW").length === 1;
}

// ---- analysis: "barang paling banyak keluar minggu ini", "produk terlaris bulan ini"

const ANALYSIS = /(?:^|\s)(?:paling\s+(?:banyak|sering|laku|laris|cepat\s+habis)|terlaris|terlaku|terbanyak|tersering|top(?:\s+\d+)?)(?=\s|$)/;

function parseAnalysis(text: string): StructuredIntent | null {
  const extracted = extractPeriod(text);
  const rest = extracted?.rest ?? text;
  if (!ANALYSIS.test(rest)) return null;
  if (/\d/.test(rest.replace(/top\s+\d+/, ""))) return null;
  const incoming = /(?:^|\s)(?:masuk|datang|diterima|restock|dibeli|ditambah)(?=\s|$)/.test(rest);
  const outgoing = /(?:^|\s)(?:keluar|terjual|dijual|laku|laris|terlaris|terlaku|cepat\s+habis|dipakai)(?=\s|$)/.test(rest);
  // "paling banyak masuk dan keluar" asks two things; it is not guessed.
  if (incoming && outgoing) return simple("UNKNOWN");
  const frequent = /(?:sering|tersering)/.test(rest);
  const metric: AnalysisMetric = incoming ? (frequent ? "FREQUENT_IN" : "TOP_IN") : (frequent ? "FREQUENT_OUT" : "TOP_OUT");
  return { intent: "STOCK_ANALYSIS", product_query: null, quantity: null, metric, period: extracted?.period ?? null };
}

// ---- transaction history: "riwayat minyak", "transaksi hari ini", "barang masuk kemarin"

const TYPE_WORDS: [RegExp, StockChangeIntent][] = [
  [/(?:^|\s)(?:barang\s+|yang\s+|stok\s+)?(?:masuk|datang|diterima)(?=\s|$)/, "ADD_STOCK"],
  [/(?:^|\s)(?:barang\s+|yang\s+|stok\s+)?(?:keluar|terjual|penjualan)(?=\s|$)/, "REDUCE_STOCK"],
  [/(?:^|\s)(?:koreksi|penyesuaian|adjustment)(?:\s+stok)?(?=\s|$)/, "SET_STOCK"],
];

function historyParts(rest: string): { query: string | null; type: StockChangeIntent | null } | null {
  let remaining = rest;
  let type: StockChangeIntent | null = null;
  for (const [pattern, intent] of TYPE_WORDS) {
    if (pattern.test(remaining)) {
      if (type) return null;
      type = intent;
      remaining = remaining.replace(pattern, " ");
    }
  }
  remaining = remaining.replace(/(?:^|\s)(?:apa\s+saja|apa|saja|yang|untuk|barang|produk|item|stok|semua|dari|pada|di)(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
  if (!remaining) return { query: null, type };
  if (/\d/.test(remaining) && !looksLikeSku(remaining)) return null;
  return isProductQuery(remaining) ? { query: remaining, type } : null;
}

function parseHistory(text: string): StructuredIntent | null {
  const extracted = extractPeriod(text);
  const body = extracted?.rest ?? text;
  const keyword = body.match(/^(?:riwayat|log|mutasi|catatan|rekap)(?:\s+(?:transaksi|stok|barang))?(?:\s+(.*))?$|^(?:transaksi|pergerakan\s+stok)(?:\s+(.*))?$|^(?:lihat|cek|tampilkan)\s+(?:riwayat|transaksi)(?:\s+transaksi)?(?:\s+(.*))?$/);
  if (keyword) {
    const parts = historyParts((keyword[1] ?? keyword[2] ?? keyword[3] ?? "").trim());
    if (!parts) return null;
    return { intent: "TRANSACTION_HISTORY", product_query: parts.query, quantity: null, period: extracted?.period ?? null, type: parts.type };
  }
  // Without a history word, a period plus "masuk"/"keluar" still asks for the history.
  if (!extracted) return null;
  const typed = body.match(/^(?:(?:apa\s+saja|apa)\s+)?(?:(?:barang|stok|produk)\s+)?(?:yang\s+)?(?:masuk|keluar|terjual|datang|penjualan)$|^(?:penjualan|pemasukan\s+barang)$|^(.+?)\s+(?:yang\s+)?(?:masuk|keluar|terjual|datang)$/);
  if (!typed) return null;
  const parts = historyParts(body);
  if (!parts || !parts.type) return null;
  return { intent: "TRANSACTION_HISTORY", product_query: parts.query, quantity: null, period: extracted.period, type: parts.type };
}

// ---- stock questions

const STOCK_WORD = alternatives(SYNONYMS.stockWords);
const CHECK_PREFIX = new RegExp(`^(?:berapa(?:\\s+(?:${STOCK_WORD})){0,2}|(?:cek|lihat|periksa|tampilkan|tunjukkan)(?:\\s+(?:${STOCK_WORD})){1,2}|(?:cek|lihat|periksa)|(?:${STOCK_WORD})(?:\\s+(?:${STOCK_WORD}|berapa))?)\\s+(.+)$`);
const CHECK_SUFFIX = new RegExp(`^(.+?)\\s+(?:(?:masih\\s+)?(?:ada|${STOCK_WORD})\\s+)?berapa(?:\\s+lagi)?$`);
const AVAILABLE_SUFFIX = /^(.+?)\s+(?:masih\s+)?(?:ada|tersedia|ready|hampir\s+habis|mau\s+habis)(?:\s+(?:tidak|kah|nya|belum|lagi))?$/;
const AVAILABLE_PREFIX = /^(?:masih\s+)?(?:ada|tersedia)\s+(?:stok\s+)?(.+?)(?:\s+(?:tidak|kah|nya|lagi))?$/;

function cleanCheckQuery(query: string): string {
  return query
    .replace(new RegExp(`\\s+(?:(?:masih\\s+)?(?:ada|${STOCK_WORD})\\s+)?berapa(?:\\s+lagi)?$`), "")
    .replace(/\s+(?:masih\s+)?(?:hampir|mau)\s+habis(?:\s+(?:belum|tidak))?$/, "")
    .replace(/\s+(?:sekarang|saat\s+ini|sekarang\s+ini|hari\s+ini)$/, "")
    .replace(new RegExp(`\\s+(?:${STOCK_WORD})$`), "")
    .trim();
}

function parsePhrase(text: string): StructuredIntent {
  if (/^(?:terima\s*kasih|makasih|thanks|thank\s+you|trims|tq)(?:\s|$)/.test(text)) return simple("UNKNOWN");
  if (/^(?:menu|menu utama|kembali|mulai|home|beranda)$/.test(text)) return simple("START");
  if (CANCEL.test(text)) return simple("CANCEL");
  if (CONFIRM.test(text)) return simple("CONFIRM");
  if (GENERAL_HELP.test(text)) return help();
  const topic = text.match(HELP_TOPIC_PREFIX);
  if (topic) {
    const found = helpTopic(topic[1].replace(/^(?:ber)?(?:gunakan\s+)?(?:fitur\s+)?/, "").trim());
    if (found) return help(found);
  }
  if (/^(?:laporan|lihat laporan|report|laporan bulanan|laporan bulan ini|minta laporan|kirim laporan)$/.test(text)) return simple("REPORT");
  if (/^(?:update|perbarui|ubah)\s+stok$/.test(text)) return simple("UPDATE_STOCK");
  if (/^stok\s+opname$|^opname(?:\s+stok)?$|^(?:mulai|lakukan)\s+(?:stok\s+)?opname$/.test(text)) return simple("STOCK_OPNAME");
  if (/^(?:rekomendasi|saran)\s+(?:restock|belanja)$|^restock\s+(?:apa|barang)$|^(?:apa\s+)?yang\s+(?:harus|perlu)\s+(?:dibeli|dibelanjakan)$/.test(text)) return simple("RESTOCK_RECOMMENDATION");
  if (/^(?:berminat|saya\s+berminat|info\s+faststock|minat)$/.test(text)) return simple("INTEREST");
  if (/^(?:hubungi|kontak)\s+supplier$|^supplier$|^kontak\s+pemasok$/.test(text)) return simple("CONTACT_SUPPLIER");
  if (/^(?:lihat|daftar)\s+supplier$/.test(text)) return simple("LIST_SUPPLIERS");
  if (SUPPLIER_PHRASE.test(text)) return simple("CONTACT_SUPPLIER");

  // Insights come before stock commands: "barang masuk kemarin" is a question about
  // the past, and "kurang dari 5" is a filter, not "kurangi dari 5".
  const analysis = parseAnalysis(text);
  if (analysis) return analysis;
  if (isLowStock(text)) return simple("LOW_STOCK");
  const filter = parseFilter(text);
  if (filter === "INVALID") return simple("UNKNOWN");
  if (filter) return { intent: "STOCK_FILTER", product_query: null, quantity: null, filter };
  const history = parseHistory(text);
  if (history) return history;

  // "stok minyak sekarang 25" must win over the stock question "stok minyak ...".
  const after = verbAfterProduct(text);
  if (after) return after;
  for (const [pattern, intent] of STOCK_PREFIXES) {
    const match = text.match(pattern);
    if (match) return stockCommand(intent, match[1].trim());
  }
  const signed = signedStockList(text);
  if (signed) return signed;

  // A bare command opens the matching prompt ("cek stok", "cari barang").
  if (new RegExp(`^(?:(?:cek|lihat|periksa|berapa)\\s+)?(?:sisa\\s+)?stok(?:nya)?$`).test(text)) return { intent: "CHECK_STOCK", product_query: "", quantity: null };
  if (/^(?:cari|carikan|temukan|search)(?:\s+(?:barang|produk))?$/.test(text)) return { intent: "SEARCH_PRODUCT", product_query: "", quantity: null };

  const search = text.match(new RegExp(`^(?:${alternatives(SYNONYMS.searchPrefix)})(?:\\s+(?:barang|produk|item))?(?:\\s+(?:merek|merk|brand|bernama|dengan nama))?\\s+(.+)$`));
  if (search && !new RegExp(`^(?:${STOCK_WORD})\\s`).test(search[1])) return product("SEARCH_PRODUCT", search[1]);
  const brand = text.match(/^(?:apa\s+)?(?:ada|punya)\s+(?:barang|produk|item)\s+(?:merek|merk|brand|bernama)?\s*(.+)$|^(?:barang|produk)\s+(?:merek|merk|brand)\s+(.+)$/);
  if (brand) return product("SEARCH_PRODUCT", (brand[1] ?? brand[2]).trim());

  const stockPrefix = text.match(CHECK_PREFIX);
  if (stockPrefix) return product("CHECK_STOCK", cleanCheckQuery(stockPrefix[1]));
  const stockSuffix = text.match(CHECK_SUFFIX);
  if (stockSuffix) return product("CHECK_STOCK", cleanCheckQuery(stockSuffix[1]));
  const available = text.match(AVAILABLE_PREFIX) ?? text.match(AVAILABLE_SUFFIX);
  if (available && !/^(?:yang|apa)(?:\s|$)/.test(available[1])) return product("CHECK_STOCK", cleanCheckQuery(available[1]));

  return product("SEARCH_PRODUCT", text);
}

// ---------------------------------------------------------------- 4. typo fallback

/** Only these words are corrected; product names never are. */
const KEYWORDS = [
  "stok", "stoknya", "cari", "carikan", "berapa", "tinggal", "tersisa", "masuk", "keluar", "tambah", "tambahkan", "kurangi", "koreksi",
  "riwayat", "transaksi", "laporan", "bantuan", "supplier", "menipis", "terjual", "hampir", "habis", "barang", "produk", "datang",
  "sekarang", "opname", "restock", "rekomendasi", "kemarin", "minggu", "bulan", "paling", "banyak", "sering", "terlaris", "batal",
  "batalkan", "konfirmasi", "lanjutkan", "simpan", "hubungi", "periksa", "tampilkan", "kritis", "update", "lihat",
];
const MUTATING = new Set<string>(["ADD_STOCK", "REDUCE_STOCK", "SET_STOCK"]);

function isFallback(parsed: StructuredIntent, phrase: string): boolean {
  return parsed.intent === "UNKNOWN" || (parsed.intent === "SEARCH_PRODUCT" && parsed.product_query === phrase);
}

/**
 * A second, stricter pass when no rule matched. Read-only requests may have any
 * command word corrected ("stik mnyak" stays a search, "riwayt minyak" becomes a
 * history). A stock change is accepted only when the typo is in the FIRST word
 * ("tambh gula 10"), so a product name is never bent into a command.
 */
function correctTypos(phrase: string): StructuredIntent | null {
  const words = phrase.split(" ");
  // Short words ("hari", "gula") are too close to keywords to correct safely.
  const fix = (word: string) => (word.length < 5 || /\d/.test(word) ? null : closestKeyword(word, KEYWORDS));
  const all = words.map((word) => fix(word) ?? word).join(" ");
  if (all !== phrase) {
    const parsed = parsePhrase(all);
    if (!isFallback(parsed, all) && !MUTATING.has(parsed.intent)) return parsed;
  }
  const firstFixed = fix(words[0]);
  if (firstFixed) {
    const first = [firstFixed, ...words.slice(1)].join(" ");
    const parsed = parsePhrase(first);
    if (!isFallback(parsed, first) && MUTATING.has(parsed.intent)) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------- 5. flat result

/** Below this confidence a caller should ask before acting. */
export const CLARIFY_BELOW = 0.5;

/**
 * The parsed message as a flat record. Stock changes always report
 * requiresConfirmation: the caller must preview them and wait for an explicit "ya".
 */
export function analyzeMessage(input: string): ParseResult {
  const { structured, corrected } = parseDetailed(input);
  const items = "items" in structured ? structured.items : [];
  const productQuery = structured.product_query ?? (items.length === 1 ? items[0].product_query : null);
  const missingFields: MissingField[] = [];
  const mutating = MUTATING.has(structured.intent);
  if (mutating) {
    if (!items.length) missingFields.push("product", "quantity");
    else if (items.some((item) => !Number.isFinite(item.quantity))) missingFields.push("quantity");
  }
  if ((structured.intent === "CHECK_STOCK" || structured.intent === "SEARCH_PRODUCT") && !structured.product_query) missingFields.push("product");
  const single = items.length === 1 ? items[0] : null;
  const fallbackSearch = structured.intent === "SEARCH_PRODUCT" && !!structured.product_query && structured.product_query === applySlang(normalize(input));
  let confidence = structured.intent === "UNKNOWN" ? 0 : fallbackSearch ? 0.6 : 0.95;
  if (corrected) confidence = Math.min(confidence, 0.7);
  if (missingFields.length) confidence = Math.min(confidence, 0.8);
  return {
    intent: structured.intent,
    productQuery,
    sku: productQuery && looksLikeSku(productQuery) ? productQuery.toUpperCase() : null,
    quantity: single && Number.isFinite(single.quantity) && structured.intent !== "SET_STOCK" ? single.quantity : null,
    unit: single?.unit ?? ("filter" in structured ? structured.filter.unit ?? null : null),
    targetStock: single && structured.intent === "SET_STOCK" && Number.isFinite(single.quantity) ? single.quantity : null,
    items,
    period: "period" in structured ? structured.period : null,
    filter: "filter" in structured ? structured.filter : null,
    confidence,
    missingFields,
    requiresConfirmation: mutating,
    corrected,
    structured,
  };
}
