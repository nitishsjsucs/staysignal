// Server-side cohort guard (SPEC 14.3): after the pre-router and before any model call, the cohorts a question names
// are checked against the published run with the same authorizeCohort rules the tools apply. A question about a
// cohort below the size floors (10 for any value, 50 for a comparison over time or a People Partner view) is refused
// with SMALL_COHORT here, so the refusal no longer depends on the model choosing to call a tool. Only size refusals
// are taken early; every other rule still runs in the tools.
import type { CohortForecast } from "../contracts";
import { authorizeCohort } from "../policy/authorize";
import type { Refusal } from "../policy/refusals";
import type { Principal } from "../policy/roles";
import { cohortMeta, normalizeName } from "../tools/registry";

/** Questions about change between runs or over time are served by the comparison tools (50 or more people). */
const COMPARISON = /\b(?:what\s+changed|changed?\s+since|change\s+(?:from|between)|since\s+the\s+(?:previous|last|prior)|(?:previous|last|prior)\s+(?:forecast|run)|over\s+time|history|trend)\b/i;

const NAMED_KINDS = new Set(["organization", "group", "team"]);

function words(s: string): string {
  return normalizeName(s)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Cohorts named in the question, by whole words; a name inside a longer matched name ("Sales" in "Enterprise Sales")
 * is dropped in favour of the longer one. Team ids (T001) match as written. */
export function namedCohorts(question: string, cohorts: readonly CohortForecast[]): CohortForecast[] {
  const q = ` ${words(question)} `;
  const hits = cohorts.filter((c) => {
    if (!NAMED_KINDS.has(c.kind)) return false;
    const n = words(c.name);
    return n.length >= 3 && q.includes(` ${n} `);
  });
  return hits.filter((c) => !hits.some((o) => o !== c && words(o.name).length > words(c.name).length && ` ${words(o.name)} `.includes(` ${words(c.name)} `)));
}

export function cohortGuard(p: Principal, question: string, cohorts: readonly CohortForecast[]): { refusal: Refusal; cohort: string } | null {
  const tool = COMPARISON.test(question) ? "explain_change" : "forecast_departures";
  for (const c of namedCohorts(question, cohorts)) {
    const r = authorizeCohort(p, tool, cohortMeta(c, cohorts));
    if (r?.code === "SMALL_COHORT") return { refusal: r, cohort: c.cohort_id };
  }
  return null;
}
