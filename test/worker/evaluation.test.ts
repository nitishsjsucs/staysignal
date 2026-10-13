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
    expect(ev.comparison.models).toEqual(["dtcr-mnl", "hist", "aj", "oracle", "survivalboost", "survivalboost-shock", "dtcr-mnl-12k"]);
    // the challenger (C15) is scored on the same origins and merged into the same summary rows
    expect(ev.comparison.summary["company|3"]?.survivalboost).toMatchObject({ coverage80: expect.any(Number) });
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

describe("GET /api/research", () => {
  it("serves the recorded research benchmark to every signed-in role, with its pre-registration hash", async () => {
    for (const who of [P.analyst, P.hrbpEng, P.auditor]) {
      const doc = await json<{ kind: string; label: string; prereg_sha256: string; cells: unknown[]; hypotheses: Record<string, { verdict: string }> }>("/api/research", { as: who });
      expect(doc.kind).toBe("research");
      expect(doc.label).toBe("synthetic");
      expect(doc.prereg_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(doc.cells).toHaveLength(22);
      expect(Object.keys(doc.hypotheses).sort()).toEqual(["H1", "H2", "H3a", "H3b", "H4", "H5"]);
    }
  });
});
