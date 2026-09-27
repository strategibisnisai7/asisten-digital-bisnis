/**
 * Units typed after a quantity ("20 pcs", "5 kg", "2 dus"). Aliases map to one
 * canonical name; only weight and volume convert between units. Package units
 * (dus, box, pack) never convert, because their content size is unknown.
 */

const ALIASES: Record<string, string[]> = {
  pcs: ["pcs", "pc", "psc", "pieces", "piece"],
  unit: ["unit", "buah", "bh", "biji", "butir"],
  kg: ["kg", "kilo", "kilogram", "kgs"],
  gram: ["gram", "gr", "g", "grm"],
  ons: ["ons"],
  liter: ["liter", "litre", "ltr", "l", "lt"],
  ml: ["ml", "mili", "mililiter"],
  dus: ["dus", "dos", "karton", "kardus"],
  box: ["box", "boks", "kotak"],
  pack: ["pack", "pak", "pck", "bungkus", "bks"],
  botol: ["botol", "btl"],
  karung: ["karung", "krg"],
  sak: ["sak"],
  sachet: ["sachet", "saset"],
  kaleng: ["kaleng"],
  galon: ["galon"],
  lembar: ["lembar", "lbr"],
  rim: ["rim"],
  roll: ["roll", "rol"],
  renteng: ["renteng"],
  ikat: ["ikat"],
  meter: ["meter", "m", "mtr"],
};

const CANONICAL = new Map<string, string>();
for (const [unit, aliases] of Object.entries(ALIASES)) for (const alias of aliases) CANONICAL.set(alias, unit);

/** Units that can be written after a number; also used to strip them from queries. */
export const KNOWN_UNITS: ReadonlySet<string> = new Set(CANONICAL.keys());

// Generic piece words fit any product counted in pieces (botol, pcs, unit, …).
const GENERIC_PIECES = new Set(["pcs", "unit"]);
const MEASURES: Record<string, { base: string; factor: number }> = {
  kg: { base: "g", factor: 1000 }, gram: { base: "g", factor: 1 }, ons: { base: "g", factor: 100 },
  liter: { base: "ml", factor: 1000 }, ml: { base: "ml", factor: 1 },
  meter: { base: "m", factor: 1 },
};

/** The canonical unit ("kilo" → "kg"); an unknown word stays as written, lowercased. */
export function canonicalUnit(unit: string): string {
  const clean = unit.normalize("NFKC").toLowerCase().trim().replace(/\.$/, "");
  return CANONICAL.get(clean) ?? clean;
}

export function isKnownUnit(word: string): boolean {
  return KNOWN_UNITS.has(word.normalize("NFKC").toLowerCase().trim());
}

/**
 * The factor that turns a quantity in `given` units into the product's unit, or null
 * when they do not fit ("5 kg" for a product counted in botol). An empty product
 * unit accepts only generic piece words.
 */
export function unitFactor(given: string, productUnit: string): number | null {
  const from = canonicalUnit(given);
  const to = canonicalUnit(productUnit);
  if (!from || from === to) return 1;
  const a = MEASURES[from];
  const b = MEASURES[to];
  if (a && b) return a.base === b.base ? a.factor / b.factor : null;
  if (GENERIC_PIECES.has(from) && !b) return 1;
  return null;
}
