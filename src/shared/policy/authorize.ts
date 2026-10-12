// authorize(principal, tool, args) (SPEC 14.3): scopes, assigned organizations, minimum cohort sizes and level
// rules, checked before any warehouse call. Suppression, rounding and the population-change rule run afterwards.
import type { CohortKind } from "../contracts";
import { type Refusal, refuse } from "./refusals";
import { hasScope, type Principal } from "./roles";

export const MIN_CELL = 10;
export const MIN_COMPARISON = 50;

export interface CohortMeta {
  id: string;
  kind: CohortKind;
  name: string;
  n: number;
  org: string | null; // the organization the cohort belongs to (null for the company)
}

const FORECAST_SCOPES = ["forecast:read:all", "forecast:read:assigned", "forecast:read:aggregate"];
const COMPARISON_TOOLS = new Set(["explain_change", "forecast_history"]);

export interface ToolScopes {
  name: string;
  scopes: string[]; // any-of
}

export function canUseTool(p: Principal, tool: ToolScopes): boolean {
  return tool.scopes.some((s) => (s === "forecast:read:*" ? FORECAST_SCOPES.some((f) => hasScope(p, f)) : s === "review:propose*" ? hasScope(p, "review:propose") || hasScope(p, "review:propose:assigned") : s === "memory:read*" ? hasScope(p, "memory:read") || hasScope(p, "memory:read:assigned") : hasScope(p, s)));
}

/** Level and size rules for a cohort-scoped tool call. Returns a refusal or null. */
export function authorizeCohort(p: Principal, tool: string, cohort: CohortMeta, opts: { cause?: string } = {}): Refusal | null {
  if (cohort.n < MIN_CELL) return refuse("SMALL_COHORT");
  const analyst = hasScope(p, "forecast:read:all");
  if (cohort.kind === "team" && !hasScope(p, "forecast:read:team")) {
    return refuse("NOT_PERMITTED", "Team-level values are available to People Analysts only.");
  }
  if (!analyst) {
    if (hasScope(p, "forecast:read:aggregate")) {
      if (cohort.kind !== "company") return refuse("NOT_PERMITTED", "Your role sees company-level aggregates only.");
    } else if (hasScope(p, "forecast:read:assigned")) {
      if (cohort.kind === "company" || cohort.org === null || !p.assignedOrgs.includes(cohort.org)) return refuse("NOT_ASSIGNED");
      if (cohort.kind === "team" || cohort.kind === "org_level" || cohort.kind === "org_tenure") return refuse("NOT_PERMITTED", "People Partners see organizations and groups.");
      if (cohort.n < MIN_COMPARISON) return refuse("SMALL_COHORT", "People Partner views need cohorts of 50 or more.");
    } else {
      return refuse("NOT_PERMITTED");
    }
  }
  if (opts.cause === "other") {
    if (!(analyst || hasScope(p, "publish:approve")) || (cohort.kind !== "company" && cohort.kind !== "organization")) {
      return refuse("NOT_PERMITTED", "Other exits are shown at company and organization level to analysts and leads only.");
    }
  }
  if (COMPARISON_TOOLS.has(tool) && cohort.n < MIN_COMPARISON) return refuse("SMALL_COHORT", "Comparisons over time need a cohort of 50 or more.");
  return null;
}
