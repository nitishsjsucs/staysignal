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

export function renderPlaceholders(text: string, aliases: AliasMap): RenderResult {
  const unresolved: string[] = [];
  const used: RenderResult["used"] = [];
  const out = text.replace(PLACEHOLDER, (whole, alias: string, path: string, fmt: Fmt | undefined) => {
    const entry = aliases.get(alias);
    const v = entry ? resolvePath(entry.values, path) : undefined;
    const s = entry ? fmtValue(v, fmt, entry.step) : null;
    if (!entry || s === null) {
      unresolved.push(whole);
      return whole;
    }
    used.push({ alias, path, result_id: entry.result_id, value: v });
    return s;
  });
  return { text: out, unresolved, used };
}
