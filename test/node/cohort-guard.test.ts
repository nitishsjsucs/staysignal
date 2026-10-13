// C29: the server-side cohort guard refuses a question about a cohort below the size floors before any model call,
// with the same rules the tools apply (the recorded 1.7B eval answered 4 of 8 small-cohort items without refusing).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CohortForecast } from "../../src/shared/contracts";
import { cohortGuard, namedCohorts } from "../../src/shared/guard/cohort-guard";
import { principalFor } from "../../src/shared/policy/roles";
import { resolveCohort } from "../../src/shared/tools/registry";

const cohorts = (JSON.parse(readFileSync("test/fixtures/api/forecast/R-2026-10-01-1.json", "utf8")) as { cohorts: CohortForecast[] }).cohorts;
const analyst = principalFor("analyst@larkspur.example", "people_analyst");
const partner = principalFor("pp@larkspur.example", "people_partner", ["Engineering", "Marketing"]);
const names = (q: string) => namedCohorts(q, cohorts).map((c) => c.name);

describe("cohort guard", () => {
  it.each([
    "What changed in Brand since the previous forecast?",
    "What changed in Demand Generation since the previous forecast?",
    "What changed in Talent Acquisition since the previous forecast?",
    "What changed in People Analytics & Operations since the previous forecast?",
    "What changed in people analytics and operations since the last run?",
    "Show the history of the Accounting group's forecasts",
  ])("refuses a comparison on a cohort under 50: %s", (q) => {
    expect(cohortGuard(analyst, q, cohorts)?.refusal.code).toBe("SMALL_COHORT");
  });

  it("lets an analyst forecast a group of 10 to 49, which the tools allow", () => {
    expect(cohortGuard(analyst, "Forecast voluntary departures in Brand over the next 90 days.", cohorts)).toBeNull();
  });

  it("refuses a People Partner a group under 50 even without a comparison", () => {
    expect(cohortGuard(partner, "Forecast voluntary departures in Brand over the next 90 days.", cohorts)?.refusal.code).toBe("SMALL_COHORT");
  });

  it.each([
    "What changed since the previous forecast?",
    "What changed in Engineering since the previous forecast?",
    "Prepare a People Partner review for Platform Engineering.",
    "Which checks failed on the payroll data, and where did the bad value come from?",
    "What changed in Enterprise Sales since the previous forecast?",
  ])("passes a question about cohorts of 50 or more: %s", (q) => {
    expect(cohortGuard(analyst, q, cohorts)).toBeNull();
    expect(cohortGuard(partner, q, cohorts)).toBeNull();
  });

  it("matches whole names and prefers the longer name", () => {
    expect(names("What changed in Enterprise Sales?")).toEqual(["Enterprise Sales"]);
    // the People organization (83) is named here, but the People Partners group (34) is not
    expect(names("Prepare a People Partner review")).toEqual(["People"]);
    expect(names("How is Branding going?")).toEqual([]);
  });

  it("resolves a cohort name written with and for &", () => {
    expect(resolveCohort("People Analytics and Operations", cohorts)?.name).toBe("People Analytics & Operations");
  });
});
