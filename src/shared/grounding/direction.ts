// Direction and emphasis checks (SPEC 14.4): rose/fell and their kin must agree with the sign of the referenced change;
// "most of the change" needs the referenced share to exceed one half; an interval bound may not be called expected.
import { PLACEHOLDER } from "./aliases";

const UP = /\b(rose|rise|rises|risen|increase[sd]?|increasing|grew|grow|grows|higher|up|more|added|adds|raised|raises|climb(?:ed|s)?)\b/i;
const DOWN = /\b(fell|fall|falls|fallen|decrease[sd]?|decreasing|drop(?:ped|s)?|lower|down|fewer|less|reduced|reduces|declined?|declines)\b/i;
const SIGNED = /(?:^|\.)(delta|phi|change|diff)$/;
const BOUND = /(?:^|\.)(i80|i95|lo80|hi80|lo95|hi95|lo|hi)(?:\.\d)?$/;

export interface DirectionViolation {
  sentence: string;
  reason: string;
}

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z{])/).filter((s) => s.trim().length > 0);
}

export function checkDirections(text: string, resolve: (alias: string, path: string) => unknown, totalChange?: (alias: string) => number | undefined): DirectionViolation[] {
  const out: DirectionViolation[] = [];
  for (const sentence of splitSentences(text)) {
    const refs = [...sentence.matchAll(PLACEHOLDER)].map((m) => ({ alias: m[1] ?? "", path: m[2] ?? "", index: m.index ?? 0 }));
    const signed = refs.filter((r) => SIGNED.test(r.path));
    const plain = sentence.replace(PLACEHOLDER, " ");
    const up = UP.test(plain);
    const down = DOWN.test(plain);
    if (signed.length === 1 && up !== down) {
      const v = resolve(signed[0]!.alias, signed[0]!.path);
      if (typeof v === "number" && v !== 0 && ((up && v < 0) || (down && v > 0))) {
        out.push({ sentence, reason: `says ${up ? "up" : "down"} but the referenced value is ${v > 0 ? "positive" : "negative"}` });
      }
    }
    if (/\bmost of the (change|difference|increase|decrease|drop|rise)\b/i.test(plain) && signed.length >= 1) {
      const r = signed[0]!;
      const v = resolve(r.alias, r.path);
      const total = totalChange?.(r.alias);
      if (typeof v === "number" && typeof total === "number" && total !== 0 && Math.abs(v) / Math.abs(total) <= 0.5) {
        out.push({ sentence, reason: "says most of the change but the referenced share is one half or less" });
      }
    }
    for (const r of refs) {
      if (!BOUND.test(r.path)) continue;
      const before = sentence.slice(Math.max(0, r.index - 30), r.index).toLowerCase();
      if (/\bexpect(?:ed|s)?\s*(?:about|around|roughly)?\s*$/.test(before)) out.push({ sentence, reason: "calls an interval bound the expected value" });
    }
  }
  return out;
}
