// Governed tools through the API: authorization by role and level, rounding by cohort size, no individual fields (C27).
import { describe, expect, it } from "vitest";
import { json, P } from "../helpers/api";

type Res = { refused?: boolean; code?: string; result_id?: string; rounding?: { step: number }; data?: Record<string, unknown> };

describe("forecast tools by role", () => {
  it("serves analysts every level, rounded by cohort size", async () => {
    const company = await json<Res>("/api/forecast?cohort=Larkspur&horizon=3", { as: P.analyst });
    expect(company.rounding?.step).toBe(0.1);
    const eng = await json<Res>("/api/forecast?cohort=Engineering&horizon_days=90", { as: P.analyst });
    expect((eng.data as { horizon: number }).horizon).toBe(3);
    const expected = (eng.data as { expected: number }).expected;
    expect(Math.abs(expected * 10 - Math.round(expected * 10))).toBeLessThan(1e-9);
  });

  it("limits People Partners to assigned organizations and groups", async () => {
    expect((await json<Res>("/api/forecast?cohort=Engineering&horizon=3", { as: P.hrbpEng })).result_id).toBeTruthy();
    expect((await json<Res>("/api/forecast?cohort=Sales&horizon=3", { as: P.hrbpEng })).code).toBe("NOT_ASSIGNED");
    expect((await json<Res>("/api/forecast?cohort=Larkspur&horizon=3", { as: P.hrbpEng })).code).toBe("NOT_ASSIGNED");
    expect((await json<Res>("/api/forecast/breakdown?cohort=Engineering&by=team&horizon=3", { as: P.hrbpEng })).code).toBe("NOT_PERMITTED");
  });

  it("gives data engineers and auditors company aggregates only", async () => {
    expect((await json<Res>("/api/forecast?cohort=Larkspur&horizon=3", { as: P.dataEng })).result_id).toBeTruthy();
    expect((await json<Res>("/api/forecast?cohort=Engineering&horizon=3", { as: P.auditor })).code).toBe("NOT_PERMITTED");
  });

  it("returns the same content-addressed result ID for the same question", async () => {
    const a = await json<Res>("/api/forecast?cohort=Engineering&horizon=3", { as: P.analyst });
    const b = await json<Res>("/api/forecast?cohort=eng&horizon=3", { as: P.lead });
    expect(a.result_id).toBe(b.result_id);
    const stored = await json<Res>(`/api/results/${a.result_id}`, { as: P.analyst });
    expect(stored.result_id).toBe(a.result_id);
  });

  it("never returns a person-level field", async () => {
    const out = JSON.stringify([
      await json("/api/forecast?cohort=Engineering&horizon=6", { as: P.analyst }),
      await json("/api/forecast/breakdown?cohort=Engineering&by=team&horizon=3", { as: P.analyst }),
      await json("/api/forecast/breakdown?cohort=Engineering&by=level_band&horizon=3", { as: P.analyst }),
    ]);
    expect(out).not.toMatch(/\bE\d{6}\b/);
    expect(out).not.toMatch(/\ber_[a-z2-7]{26}\b/);
    expect(out).not.toMatch(/employee_number|probability_individual/);
  });

  it("labels team rows as not an evaluation of a manager and sorts by name", async () => {
    const r = await json<Res>("/api/forecast/breakdown?cohort=Platform Engineering&by=team&horizon=3", { as: P.analyst });
    const d = r.data as { note: string; rows: { cohort: string }[] };
    expect(d.note).toMatch(/not an evaluation of the team's manager/);
    const names = d.rows.map((x) => x.cohort);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });
});
