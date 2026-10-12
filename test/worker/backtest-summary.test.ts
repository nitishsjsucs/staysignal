// The backtest_summary tool: recorded accuracy from the evaluation, governed like a comparison over time.
import { describe, expect, it } from "vitest";
import { json, P } from "../helpers/api";

type Res = { refused?: boolean; code?: string; result_id?: string; data?: Record<string, unknown> };

describe("backtest_summary", () => {
  it("serves the model's recorded company accuracy with its effective windows", async () => {
    const r = await json<Res>("/api/backtest/summary?level=company&horizon=3", { as: P.analyst });
    expect(r.result_id).toMatch(/^res_/);
    const d = r.data as { model: string; coverage80: number; effective_windows: number; label: string; basis: string };
    expect(d.model).toBe("dtcr-mnl");
    expect(d.label).toBe("synthetic");
    expect(d.basis).toBe("monthly origins");
    expect(d.effective_windows).toBe(6);
    expect(d.coverage80).toBeGreaterThan(0);
    expect(d.coverage80).toBeLessThanOrEqual(1);
  });

  it("serves the baselines from the comparison and refuses groups", async () => {
    const r = await json<Res>("/api/backtest/summary?level=organization&horizon=3&model=oracle", { as: P.lead });
    expect((r.data as { basis: string; effective_windows: unknown }).basis).toBe("the six quarterly comparison origins");
    expect((r.data as { effective_windows: unknown }).effective_windows).toBeNull();
    expect((await json<Res>("/api/backtest/summary?level=group&horizon=3", { as: P.analyst })).code).toBe("OUT_OF_SCOPE");
  });

  it("follows the cohort rules: no company view for People Partners, no pooled organizations for aggregate roles", async () => {
    expect((await json<Res>("/api/backtest/summary?level=company&horizon=3", { as: P.hrbpEng })).code).toBe("NOT_ASSIGNED");
    expect((await json<Res>("/api/backtest/summary?level=company&horizon=3", { as: P.dataEng })).result_id).toBeTruthy();
    expect((await json<Res>("/api/backtest/summary?level=organization&horizon=3", { as: P.dataEng })).code).toBe("NOT_PERMITTED");
  });
});
