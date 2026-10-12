// Numeral extraction for the grounding check (SPEC 14.4): digits (with separators, decimals and percent signs) and
// written-out numbers.
const WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  thousand: 1000, dozen: 12, half: 0.5, twice: 2, double: 2, triple: 3,
};

export interface Numeral {
  raw: string;
  value: number;
  decimals: number;
  percent: boolean;
  word: boolean;
  index: number;
}

const DIGITS = /(?<![A-Za-z0-9_#@.\-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s?%|\s?percent)?(?![A-Za-z0-9_])/g;
const WORD_RE = new RegExp(`\\b(${Object.keys(WORDS).join("|")})\\b`, "gi");

export function extractNumerals(text: string): Numeral[] {
  const out: Numeral[] = [];
  for (const m of text.matchAll(DIGITS)) {
    const whole = (m[1] ?? "").replace(/,/g, "");
    const frac = m[2] ?? "";
    out.push({ raw: m[0], value: Number(frac ? `${whole}.${frac}` : whole), decimals: frac.length, percent: Boolean(m[3]), word: false, index: m.index ?? 0 });
  }
  for (const m of text.matchAll(WORD_RE)) {
    const w = (m[1] ?? "").toLowerCase();
    out.push({ raw: m[0], value: WORDS[w] ?? 0, decimals: 0, percent: false, word: true, index: m.index ?? 0 });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Every finite number in a JSON value, with nested arrays and objects flattened. */
export function numericLeaves(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  else if (Array.isArray(v)) for (const x of v) numericLeaves(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) numericLeaves(x, out);
  return out;
}

/** Lengths of every array in a JSON value (small counts may cite them). */
export function arrayLengths(v: unknown, out: Set<number> = new Set()): Set<number> {
  if (Array.isArray(v)) {
    out.add(v.length);
    for (const x of v) arrayLengths(x, out);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) arrayLengths(x, out);
  return out;
}

/** Every string leaf (identifiers, dates) in a JSON value. */
export function stringLeaves(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof v === "string") out.add(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      stringLeaves(x, out);
    }
  }
  return out;
}
