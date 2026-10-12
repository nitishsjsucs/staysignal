// C28: aliases resolve, literal numerals are flagged, identifiers and array-length counts are allowed, directions are
// checked, and templates are grounded by construction.
import { describe, expect, it } from "vitest";
import type { AliasMap } from "../../src/shared/grounding/aliases";
import { renderPlaceholders } from "../../src/shared/grounding/aliases";
import { checkGrounding } from "../../src/shared/grounding/check";
import { templateAnswer } from "../../src/shared/grounding/template";

const forecast = { cohort: { name: "Engineering", n: 619 }, horizon: 3, expected: 13.1, i80: [8, 18], i95: [6, 21], hist: { expected: 15.4 }, annual_rate: 0.085, cutoff: "2026-10-01", run_id: "R-2026-10-01#1", run_status: "published" };
const change = { cohort: { name: "Engineering" }, horizon: 3, from: "R-2026-09-01#1", to: "R-2026-10-01#1", from_value: 13.3, to_value: 13.1, delta: -0.2, interval80_width: 10, factors: [{ factor: "calendar", label: "Calendar", phi: -0.7 }, { factor: "model", label: "Model", phi: 0.3 }] };

function aliases(): AliasMap {
  return new Map([
    ["r1", { alias: "r1", result_id: "res_a", tool: "forecast_departures", values: forecast, step: 0.1 }],
    ["r2", { alias: "r2", result_id: "res_b", tool: "explain_change", values: change, step: 0.1 }],
  ]);
}

const check = (text: string, question = "") => checkGrounding({ text, aliases: aliases(), question, toolArgs: [{ cohort: "Engineering", horizon_months: 3 }] });

describe("grounding", () => {
  it("renders placeholders by format and step", () => {
    const r = renderPlaceholders("{{r1.expected}} ({{r1.i80|range}}, {{r1.annual_rate|pct}})", aliases());
    expect(r.text).toBe("13.1 (8 to 18, 8.5%)");
    expect(r.unresolved).toEqual([]);
  });

  it("passes placeholder-only narration with identifiers, dates and horizons", () => {
    expect(check("For Engineering at cutoff 2026-10-01 (run R-2026-10-01#1), StaySignal expects {{r1.expected}} over 3 months; the 80% range is {{r1.i80|range}}.").ok).toBe(true);
  });

  it("flags a literal numeral that is not in the results, and an unknown placeholder", () => {
    const r = check("StaySignal expects 42 departures and {{r1.nope}} more.");
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/42/);
    expect(r.violations.join(" ")).toMatch(/unknown placeholder/);
  });

  it("allows a literal equal to a result value at its displayed precision", () => {
    expect(check("StaySignal expects 13.1 departures.").ok).toBe(true);
    expect(check("StaySignal expects 13 departures.").ok).toBe(true);
  });

  it("checks direction words against signs and 'most of the change'", () => {
    expect(check("The forecast fell by {{r2.delta|1dp}}.").ok).toBe(true);
    expect(check("The forecast rose by {{r2.delta|1dp}}.").ok).toBe(false);
    expect(check("Most of the change is the calendar, {{r2.factors.0.phi|1dp}}.").ok).toBe(true);
    expect(check("Most of the change is the model, {{r2.factors.1.phi|1dp}}.").ok).toBe(false);
  });

  it("refuses calling an interval bound the expected value", () => {
    expect(check("StaySignal expects {{r1.i80|range}} departures.").ok).toBe(false);
  });

  it("templates are grounded by construction", () => {
    const text = templateAnswer([{ alias: "r1", tool: "forecast_departures", values: forecast }, { alias: "r2", tool: "explain_change", values: change }]);
    expect(check(text).ok).toBe(true);
  });
});
