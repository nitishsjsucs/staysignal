// The population-change rule (SPEC 17.5 rule 4): a comparison of two populations is served only if the joiners
// plus leavers are 0 or at least 10; otherwise a series point is omitted, a Shapley factor merged, or a direct
// request refused with DIFFERENCING_RISK.
import policy from "../../../policy/disclosure.json";

export const MIN_CHANGED = policy.population_change.min_changed;

export function comparisonServable(joiners: number, leavers: number): boolean {
  const changed = joiners + leavers;
  return changed === 0 || changed >= MIN_CHANGED;
}
