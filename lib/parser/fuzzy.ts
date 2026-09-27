/**
 * Small, deterministic typo tolerance: an edit distance with transpositions and a
 * word-by-word product scorer. No dictionary or external service is involved.
 */

/** Optimal string alignment distance (insert, delete, substitute, swap neighbours). */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i][j] = value;
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
  }
  return rows[a.length][b.length];
}

/** Typos allowed for a word of this length: none below 4 letters, 1 up to 7, then 2. */
export function allowedTypos(word: string): number {
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2;
}

export function normalizeWords(value: string): string[] {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
}

/**
 * How well a query matches a product name/SKU, 0–1. Every query word must match some
 * name word exactly, as a prefix, or within the allowed typos; otherwise 0.
 */
export function productScore(query: string, name: string, sku: string): number {
  const words = normalizeWords(query);
  const target = [...normalizeWords(name), ...normalizeWords(sku)];
  if (!words.length || !target.length) return 0;
  let total = 0;
  for (const word of words) {
    let best = 0;
    for (const candidate of target) {
      if (candidate === word) { best = 1; break; }
      if (word.length >= 3 && candidate.startsWith(word)) best = Math.max(best, 0.9);
      const typos = Math.min(allowedTypos(word), allowedTypos(candidate));
      if (typos) {
        const distance = editDistance(word, candidate, typos);
        if (distance <= typos) best = Math.max(best, 0.8 - 0.1 * distance);
      }
    }
    if (!best) return 0;
    total += best;
  }
  return total / words.length;
}

/** Corrects one word to a keyword within the allowed typos; ties are not corrected. */
export function closestKeyword(word: string, keywords: readonly string[]): string | null {
  const typos = allowedTypos(word);
  if (!typos) return null;
  let found: string | null = null;
  let bestDistance = Infinity;
  let tie = false;
  for (const keyword of keywords) {
    if (Math.abs(keyword.length - word.length) > typos || allowedTypos(keyword) === 0) continue;
    const distance = editDistance(word, keyword, typos);
    if (distance > typos) continue;
    if (distance < bestDistance) { found = keyword; bestDistance = distance; tie = false; } else if (distance === bestDistance && keyword !== found) tie = true;
  }
  return found && !tie && bestDistance > 0 ? found : null;
}
