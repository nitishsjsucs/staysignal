// Per-turn result aliases and placeholders (SPEC 14.4, ADR 0007). The model writes {{r1.expected|int}}; the server
// maps r1 to the turn's result ID and renders the value from the stored result. Pattern from DataTrust
// packages/rca/src/summary/render.ts (MIT), adapted to aliases.
import { type Fmt, fmtNumber, fmtRange } from "../format";

export const PLACEHOLDER = /\{\{\s*(r\d+)\.([A-Za-z0-9_.]+)\s*(?:\|\s*(int|1dp|pct|range|raw))?\s*\}\}/g;

export interface AliasEntry {
  alias: string;
  result_id: string;
  tool: string;
  values: unknown;
  step: number | null; // the cohort's disclosure rounding step, when the result has one
}

export type AliasMap = Map<string, AliasEntry>;

export function resolvePath(values: unknown, path: string): unknown {
  let cur: unknown = values;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function fmtValue(v: unknown, fmt: Fmt | undefined, step: number | null): string | null {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return fmtRange(v as [number, number]);
  if (typeof v === "number") {
    if (fmt === "pct") return fmtNumber(v, "pct");
    if (fmt === "int" || (step !== null && step >= 1 && fmt !== "raw")) return fmtNumber(v, "int");
    if (fmt === "1dp") return fmtNumber(v, "1dp");
    return fmtNumber(v, "raw", step ?? undefined);
  }
  if (typeof v === "string") return v;
  return null;
}

export interface RenderResult {
  text: string;
  unresolved: string[];
  used: { alias: string; path: string; result_id: string; value: unknown }[];
}

/** A downward word just before a placeholder ("fell by", "reduced the forecast by", "subtracted"): the word carries the
 * sign, so a negative value renders as its size. The grounding check has already required the word to agree with the
 * sign, so nothing is lost, and "fell by -0.4" never reaches a reader. */
const DOWN_BEFORE = /\b(fell|falls|dropped|drops|declined|declines|decreased|decreases|reduced|reduces|reducing|lowered|lowers|cut|cuts|subtracted|subtracts|removed|removes|shrank|lost|down)\b[^.{}\n]{0,30}$/i;

/** The value a reader sees for a placeholder at `offset` in `text`: after a downward word, a negative value's size. The
 * server's renderer and the chat dock both use it, so the dock never shows "fell by -0.4". */
export function shownValue(v: unknown, text: string, offset: number): unknown {
  return typeof v === "number" && v < 0 && DOWN_BEFORE.test(text.slice(Math.max(0, offset - 48), offset)) ? -v : v;
}

export function renderPlaceholders(text: string, aliases: AliasMap): RenderResult {
  const unresolved: string[] = [];
  const used: RenderResult["used"] = [];
  const out = text.replace(PLACEHOLDER, (whole, alias: string, path: string, fmt: Fmt | undefined, offset: number, all: string) => {
    const entry = aliases.get(alias);
    const v = entry ? resolvePath(entry.values, path) : undefined;
    const shown = shownValue(v, all, offset);
    const s = entry ? fmtValue(shown, fmt, entry.step) : null;
    if (!entry || s === null) {
      unresolved.push(whole);
      return whole;
    }
    used.push({ alias, path, result_id: entry.result_id, value: v });
    return s;
  });
  return { text: out, unresolved, used };
}
