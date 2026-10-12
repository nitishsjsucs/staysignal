// Disclosure rounding (SPEC 17.5 rule 2). Pattern copied from PeopleLens worker/src/guard/disclosure.ts (MIT, rule 7),
// extended with steps by cohort size: expected departures to 0.1 for 200 or more people, 0.5 for 50 to 199 and whole
// numbers for 10 to 49; interval bounds are integers; variance shares are rounded to 5 points. Steps live in
// policy/disclosure.json, shared with the engine (privacy/suppression.py).
import policy from "../../../policy/disclosure.json";
import type { Rounding } from "../contracts";

export const DISCLOSURE = policy;

export function roundingFor(n: number): Rounding {
  for (const b of policy.expected_rounding) if (n >= b.min_n) return { step: b.step, band: b.band as Rounding["band"] };
  throw new Error(`cohort of ${n} is below the minimum cell size`);
}

/** Half-up rounding to a multiple of step, matching the engine (floor(x / step + 0.5)). */
export function roundToStep(x: number, step: number): number {
  const k = Math.floor(x / step + 0.5 + 1e-9);
  return Math.round(k * step * 1e6) / 1e6;
}

export function roundShare(x: number, points = policy.variance_share_points): number {
  return points * Math.floor((100 * x) / points + 0.5);
}

export function roundInterval(r: readonly [number, number]): [number, number] {
  return [Math.round(r[0]), Math.round(r[1])];
}
