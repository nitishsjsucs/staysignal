// The Trust page's evaluation endpoint: recorded cohort aggregates only, filtered by the forecast cohort rules.
import { describe, expect, it } from "vitest";
import type { EvaluationFixture } from "../../src/shared/contracts";
import { json, P } from "../helpers/api";

describe("GET /api/evaluation", () => {
  it("gives analysts every level, the calibration and the model comparison", async () => {
    const ev = await json<EvaluationFixture>("/api/evaluation", { as: P.analyst });
    expect(ev.label).toMatch(/synthetic/);
    expect(Object.keys(ev.backtest.levels)).toContain("company|3");
    expect(Object.keys(ev.backtest.levels)).toContain("organization|3");
    expect(ev.calibration?.reliability.every((b) => b.n >= 10)).toBe(true);
    expect(ev.comparison.models).toEqual(["dtcr-mnl", "hist", "aj", "oracle"]);
    expect(new Set(ev.backtest.entries.map((e) => e.cohort)).has("company")).toBe(true);
  });

  it("limits People Partners to their assigned organizations, without pooled summaries", async () => {
    const ev = await json<EvaluationFixture>("/api/evaluation", { as: P.hrbpEng });
    const cohorts = new Set(ev.backtest.entries.map((e) => e.cohort));
    expect([...cohorts].every((c) => c === "org:Engineering" || c === "org:Product & Design")).toBe(true);
    expect(cohorts.size).toBeGreaterThan(0);
    expect(ev.backtest.levels).toEqual({});
    expect(ev.calibration).toBeNull();
    expect(ev.comparison).toBeNull();
    expect(ev.effects ?? null).toBeNull();
  });

  it("gives aggregate roles the company only", async () => {
    const ev = await json<EvaluationFixture>("/api/evaluation", { as: P.dataEng });
    expect(new Set(ev.backtest.entries.map((e) => e.cohort))).toEqual(new Set(["company"]));
    expect(Object.values(ev.backtest.levels).every((l) => l.level === "company")).toBe(true);
    expect(Object.values(ev.comparison.summary).every((s) => s.level === "company")).toBe(true);
  });

  it("never returns a person-level field", async () => {
    const text = JSON.stringify(await json("/api/evaluation", { as: P.analyst }));
    expect(text).not.toMatch(/\bE\d{6}\b|er_[a-z2-7]{26}|employee/);
  });
});
