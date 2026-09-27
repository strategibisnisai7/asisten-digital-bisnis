import type { ProductReadIntent, SimpleIntent, StockChangeIntent, StructuredIntent } from "./intents";

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

/** Pure language parser: no environment, inventory lookup, network, or side effects. */
export function parseRuleIntent(input: string): StructuredIntent {
  const text = input.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ")
    .replace(/[?!]+$/, "").trim()
    .replace(/^(?:(?:tolong|mohon|coba)\s+)+/, "")
    .replace(/\s+(?:dong|ya)$/, "").trim();

  if (!text || text.length > 500) return simple("UNKNOWN");
  // Interface labels are understood here so every Telegram text uses this parser.
  if (/^\/(?:start|help|menu)(?:@[a-z0-9_]+)?(?:\s.*)?$/.test(text) || text === "❓ bantuan") return simple("HELP");
  if (text === "🔍 cek stok") return { intent: "CHECK_STOCK", product_query: "", quantity: null };
  if (text === "📋 cari barang") return { intent: "SEARCH_PRODUCT", product_query: "", quantity: null };
  if (/^⚠️? stok menipis$/.test(text)) return simple("LOW_STOCK");
  if (/^(?:batal|batalkan|tidak|nggak|enggak|cancel|no)$/.test(text)) return simple("CANCEL");
  if (/^(?:ya|iya|yap|ok|oke|konfirmasi|confirm|yes)$/.test(text)) return simple("CONFIRM");
  if (/^(?:bantuan|help|menu|cara pakai)$/.test(text)) return simple("HELP");
  if (/^(?:buat|bikin)(?:kan)?\s+(?:pesanan|order)$/.test(text)) return simple("CREATE_ORDER");

  if (/^(?:(?:cek|lihat|cari|tampilkan)\s+)?(?:barang|produk|stok)(?:\s+apa)?(?:\s+yang)?(?:\s+stoknya)?\s+(?:hampir habis|menipis|habis|rendah|di bawah minimum)$/.test(text)) {
    return simple("LOW_STOCK");
  }

  const change = text.match(/^(tambah|tambahkan|kurangi|kurang|kurangkan|set|atur|ubah)\s+(?:stok\s+)?(.+?)\s+([+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+))$/);
  if (change) {
    const [, verb, query, amount] = change;
    const intent: StockChangeIntent = /^(?:tambah|tambahkan)$/.test(verb)
      ? "ADD_STOCK" : /^(?:kurangi|kurang|kurangkan)$/.test(verb) ? "REDUCE_STOCK" : "SET_STOCK";
    const quantity = Number(amount.replace(",", "."));
    if (!isProductQuery(query) || !Number.isFinite(quantity) || quantity > Number.MAX_SAFE_INTEGER || quantity < 0 || (quantity === 0 && intent !== "SET_STOCK")) {
      return simple("UNKNOWN");
    }
    return { intent, product_query: query, quantity };
  }

  const search = text.match(/^(?:cari|carikan|temukan|search)(?:\s+(?:barang|produk))?\s+(.+)$/);
  if (search) return product("SEARCH_PRODUCT", search[1]);

  const stockPrefix = text.match(/^(?:berapa(?:\s+(?:sisa\s+)?stok(?:nya)?)?|(?:cek|lihat|periksa)(?:\s+(?:sisa\s+)?stok(?:nya)?)?|stok(?:nya)?)\s+(.+)$/);
  if (stockPrefix) {
    const query = stockPrefix[1].replace(/\s+(?:(?:tinggal|sisa|tersisa)\s+)?berapa(?:\s+lagi)?$/, "").trim();
    return product("CHECK_STOCK", query);
  }

  const stockSuffix = text.match(/^(.+?)\s+(?:(?:tinggal|sisa|tersisa|stok|stoknya)\s+)?berapa(?:\s+lagi)?$/);
  if (stockSuffix) return product("CHECK_STOCK", stockSuffix[1]);

  return product("SEARCH_PRODUCT", text);
}
