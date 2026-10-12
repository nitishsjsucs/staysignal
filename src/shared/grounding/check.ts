// The numeric-grounding check (SPEC 14.4, ADR 0007). Pattern from DataTrust packages/rca/src/summary/validate.ts
// (MIT), adapted to per-turn aliases. Every numeral left after rendering placeholders must be allowed or must equal a
// value in this turn's tool results at its displayed precision; direction words must agree with signs.
import { type AliasMap, PLACEHOLDER, renderPlaceholders, resolvePath } from "./aliases";
import { checkDirections } from "./direction";
import { arrayLengths, extractNumerals, numericLeaves, stringLeaves } from "./numerals";

export interface GroundingInput {
  text: string;
  aliases: AliasMap;
  question: string;
  toolArgs: unknown[];
}

export interface GroundingOutcome {
  ok: boolean;
  violations: string[];
  rendered: string;
  used: { alias: string; path: string; result_id: string; value: unknown }[];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dateVariants(iso: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return [];
  const [, y, mo, d] = m;
  const name = MONTHS[Number(mo) - 1];
  if (!name) return [];
  const cap = name[0]!.toUpperCase() + name.slice(1);
  const day = String(Number(d));
  return [`${cap} ${day}, ${y}`, `${day} ${cap} ${y}`, `${cap} ${day}`, `${cap} ${y}`, `${y}-${mo}-${d}`];
}

function matchesValue(value: number, decimals: number, percent: boolean, leaves: number[]): boolean {
  const tol = 0.5 * 10 ** -decimals + 1e-9;
  for (const v of leaves) {
    if (Math.abs(v - value) <= tol) return true;
    if (percent && Math.abs(v * 100 - value) <= tol) return true;
    if (!percent && decimals === 0 && Math.abs(Math.abs(v) - value) <= tol) return true;
  }
  return false;
}

export function checkGrounding(input: GroundingInput): GroundingOutcome {
  const { aliases } = input;
  const violations: string[] = [];
  const rendered = renderPlaceholders(input.text, aliases);
  for (const u of rendered.unresolved) violations.push(`unknown placeholder ${u}`);

  const results = [...aliases.values()].map((a) => a.values);
  const leaves = numericLeaves(results);
  const lengths = arrayLengths(results);
  const strings = new Set<string>([...stringLeaves(results), ...stringLeaves(input.toolArgs)]);
  const identifiers = [...strings].filter((s) => /\d/.test(s) && (/[A-Za-z@#]/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)) && s.length <= 64);
  const dates = [...strings].filter((s) => /^\d{4}-\d{2}-\d{2}/.test(s)).flatMap(dateVariants);
  const known = [...identifiers, ...dates].sort((a, b) => b.length - a.length);

  let stripped = input.text.replace(PLACEHOLDER, " ");
  if (known.length) stripped = stripped.replace(new RegExp(known.map(escapeRe).join("|"), "g"), " ");
  const questionNums = new Set(extractNumerals(input.question).map((n) => n.value));
  for (const n of extractNumerals(stripped)) {
    if (n.word && n.value === 1) continue; // "one" is ordinary prose ("one of", "no one")
    if (questionNums.has(n.value)) continue;
    if (!n.percent && [1, 3, 6, 30, 90, 180].includes(n.value)) continue;
    if (n.percent && (n.value === 80 || n.value === 95)) continue; // interval levels, not results
    if (!n.percent && Number.isInteger(n.value) && n.value <= 10 && lengths.has(n.value)) continue;
    if (!n.word && matchesValue(n.value, n.decimals, n.percent, leaves)) continue;
    violations.push(`the numeral "${n.raw.trim()}" is not traceable to a tool result in this turn`);
  }
  const resolve = (alias: string, path: string) => {
    const e = aliases.get(alias);
    return e ? resolvePath(e.values, path) : undefined;
  };
  // "Most of the change" is judged against the total size of all factor contributions (factors can offset).
  const total = (alias: string) => {
    const factors = resolve(alias, "factors");
    if (Array.isArray(factors)) return factors.reduce((s: number, f: { phi?: unknown }) => s + Math.abs(Number(f.phi) || 0), 0);
    const v = resolve(alias, "delta");
    return typeof v === "number" ? v : undefined;
  };
  for (const d of checkDirections(input.text, resolve, total)) violations.push(`direction: ${d.reason} ("${d.sentence.slice(0, 80)}")`);
  return { ok: violations.length === 0, violations, rendered: rendered.text, used: rendered.used };
}
