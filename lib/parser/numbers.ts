/**
 * Numbers as people type them in Indonesian chat: digits ("20", "1.500", "2,5") and
 * common number words ("dua puluh", "seratus", "setengah lusin"). Pure functions.
 */

const DIGIT_AMOUNT = /^\d+(?:[.,]\d+)*$/;

/** "1.500" is Indonesian for 1500; "1.5" and "2,5" are decimals. NaN when unreadable. */
export function parseAmount(value: string): number {
  if (/^\d{1,3}(?:\.\d{3})+$/.test(value)) return Number(value.replace(/\./g, ""));
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(value)) return Number(value.replace(/\./g, "").replace(",", "."));
  return /^\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(",", ".")) : Number.NaN;
}

const UNITS: Record<string, number> = {
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, delapan: 8, sembilan: 9,
};
const TEENS: Record<string, number> = { sepuluh: 10, sebelas: 11 };
const SCALES: Record<string, number> = { puluh: 10, ratus: 100, ribu: 1000, juta: 1_000_000 };
const PREFIXED: Record<string, [number, number]> = {
  // "seratus" = se + ratus
  seratus: [1, 100], seribu: [1, 1000], sejuta: [1, 1_000_000],
};
/** Counting units that multiply: "dua lusin" = 24, "setengah lusin" = 6. */
export const COUNT_MULTIPLIERS: Record<string, number> = { lusin: 12, kodi: 20, gross: 144, gros: 144 };

export const NUMBER_WORDS = new Set([
  ...Object.keys(UNITS), ...Object.keys(TEENS), ...Object.keys(SCALES), ...Object.keys(PREFIXED),
  "belas", "setengah", "seperempat", "stengah",
]);

/**
 * Reads a phrase made only of number words. Supports 0–999.999.999 with "belas",
 * "puluh", "ratus", "ribu", "juta", the "se-" forms, and "setengah"/"seperempat"
 * (alone, or as "dua setengah" = 2,5). Returns null for anything else.
 */
export function parseNumberWords(phrase: string): number | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.some((word) => !NUMBER_WORDS.has(word))) return null;
  if (words.length === 1 && (words[0] === "setengah" || words[0] === "stengah")) return 0.5;
  if (words.length === 1 && words[0] === "seperempat") return 0.25;
  let fraction = 0;
  if (words.length > 1 && ["setengah", "stengah", "seperempat"].includes(words.at(-1)!)) {
    fraction = words.pop() === "seperempat" ? 0.25 : 0.5;
  }
  let total = 0;
  let group = 0; // value below the current thousand scale
  let last = 0; // the pending digit for puluh/belas/ratus
  let seen = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word in PREFIXED) {
      const [digit, scale] = PREFIXED[word];
      if (scale >= 1000) { total += (group + last + digit) * scale; group = 0; last = 0; } else { group += last + digit * scale; last = 0; }
      seen = true;
    } else if (word in TEENS) {
      group += last + TEENS[word]; last = 0; seen = true;
    } else if (word in UNITS) {
      if (last) return null; // "dua tiga"
      last = UNITS[word]; seen = true;
    } else if (word === "belas") {
      if (!last) return null;
      group += 10 + last; last = 0;
    } else if (word === "puluh" || word === "ratus") {
      if (!last) return null;
      group += last * SCALES[word]; last = 0;
    } else if (word === "ribu" || word === "juta") {
      if (!last && !group) return null;
      total += (group + last) * SCALES[word]; group = 0; last = 0;
    } else {
      return null;
    }
  }
  if (!seen) return null;
  return total + group + last + fraction;
}

/**
 * A quantity phrase: digits or number words, optionally followed by a counting
 * multiplier ("2 lusin", "setengah lusin", "1 kodi"). Returns null when unreadable.
 */
export function parseQuantityPhrase(phrase: string): number | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let multiplier = 1;
  if (words.length > 1 && words.at(-1)! in COUNT_MULTIPLIERS) multiplier = COUNT_MULTIPLIERS[words.pop()!];
  else if (words.length === 1 && words[0] in COUNT_MULTIPLIERS) return COUNT_MULTIPLIERS[words[0]];
  const joined = words.join(" ");
  const value = words.length === 1 && DIGIT_AMOUNT.test(joined) ? parseAmount(joined) : parseNumberWords(joined);
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * multiplier * 1e6) / 1e6;
}
