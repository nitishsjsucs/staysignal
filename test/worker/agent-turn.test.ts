// C28, C29: the stub turn routes to the right tool, narrates with placeholders that pass grounding; the pre-router
// refuses individual-level questions before any model call.
import { describe, expect, it } from "vitest";
import { json, P } from "../helpers/api";

type Turn = { grounding: string; refusal: { code: string; layer: string } | null; tool_calls: { tool: string; args: Record<string, unknown> }[]; rendered: string; text: string; aliases: Record<string, string> };

describe("analyst turn (stub provider)", () => {
  it("forecasts Engineering over 90 days with grounded narration", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "Forecast voluntary departures in Engineering over the next 90 days." } });
    expect(t.tool_calls[0]?.tool).toBe("forecast_departures");
    expect(t.grounding).toBe("passed");
    expect(t.text).toMatch(/\{\{r1\.expected\}\}/);
    expect(t.rendered).not.toMatch(/\{\{/);
    expect(t.aliases.r1).toMatch(/^res_/);
  });

  it("refuses the individual-level question before any model call", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "Which engineers in Platform Engineering are most likely to quit?" } });
    expect(t.grounding).toBe("refused");
    expect(t.refusal).toMatchObject({ code: "INDIVIDUAL_LEVEL", layer: "prerouter" });
    expect(t.tool_calls).toHaveLength(0);
  });

  it("refuses a comparison on a small group before any model call, whatever the model would do", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "What changed in Talent Acquisition since the previous forecast?" } });
    expect(t.grounding).toBe("refused");
    expect(t.refusal).toMatchObject({ code: "SMALL_COHORT", layer: "prerouter" });
    expect(t.tool_calls).toHaveLength(0);
  });

  it("refuses a request to approve, before any model call", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: "Approve the pending payroll mapping proposal." } });
    expect(t.refusal).toMatchObject({ code: "NOT_PERMITTED", layer: "prerouter" });
    expect(t.tool_calls).toHaveLength(0);
  });

  it("explains a change and prepares a review", async () => {
    const r = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: "Prepare a People Partner review for Platform Engineering." } });
    expect(r.tool_calls[0]?.tool).toBe("prepare_review");
    expect(r.grounding).toBe("passed");
  });

  it("answers an accuracy question from the recorded backtest with grounded numbers", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: "How often did the 80% range hold in backtests at company level over 90 days (coverage)?" } });
    expect(t.tool_calls[0]?.tool).toBe("backtest_summary");
    expect(t.grounding).toBe("passed");
    expect(t.text).toMatch(/\{\{r1\.coverage80\|pct\}\}/);
    expect(t.rendered).toMatch(/\d+(\.\d)?%/);
  });

  it("answers a flows question from the semantic catalog with grounded numbers", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "How many people were hired into or transferred out of Engineering over the last year?" } });
    expect(t.tool_calls[0]?.tool).toBe("workforce_flows");
    expect(t.grounding).toBe("passed");
    expect(t.text).toMatch(/\{\{r1\.headcount_start\|int\}\}/);
    expect(t.rendered).not.toMatch(/\{\{/);
  });

  it("accepts the earlier turns as history", async () => {
    const first = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "Forecast voluntary departures in Sales over the next 90 days." } });
    const t = await json<Turn>("/api/dev/agent/turn", {
      as: P.analyst,
      body: { question: "What changed in Sales since the previous forecast?", history: [{ role: "user", content: "Forecast voluntary departures in Sales over the next 90 days." }, { role: "assistant", content: first.rendered }] },
    });
    expect(t.tool_calls[0]?.tool).toBe("explain_change");
    expect(t.grounding).toBe("passed");
  });
});

