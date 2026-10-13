// Funnel plot limits (SPEC 16.2; Spiegelhalter 2005, Statistics in Medicine 24:1185): for a cohort with expected
// count E, observed O ~ Poisson(E) under the model, so O/E limits narrow as E grows. The square-root (Anscombe)
// approximation gives O = (sqrt(E) +/- z/2)^2, which is smooth and close to the exact Poisson quantiles at these sizes.
export const Z95 = 1.959964;
export const Z998 = 3.090232;

export function funnelLimits(expected: number, z: number): [number, number] {
  if (!(expected > 0)) return [0, Number.POSITIVE_INFINITY];
  const r = Math.sqrt(expected);
  return [Math.max(0, r - z / 2) ** 2 / expected, (r + z / 2) ** 2 / expected];
}

export type FunnelVerdict = "inside" | "outside95" | "outside998";

export function funnelVerdict(observed: number, expected: number): FunnelVerdict {
  const oe = observed / expected;
  const [lo998, hi998] = funnelLimits(expected, Z998);
  if (oe < lo998 || oe > hi998) return "outside998";
  const [lo95, hi95] = funnelLimits(expected, Z95);
  return oe < lo95 || oe > hi95 ? "outside95" : "inside";
}
