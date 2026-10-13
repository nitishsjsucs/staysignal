// Every value a model may cite says what it means and in which unit. A live 27B recording put the forecast where
// the trailing-rate status quo belonged, and called a change in departures "percentage points", because the digests
// listed bare placeholders.
import { describe, expect, it } from "vitest";
import { getTool } from "../../src/shared/tools/registry";

const factors = [
  { factor: "calendar", label: "Calendar", phi: -0.7, merged_from: ["calendar"] },
  { factor: "composition", label: "Composition", phi: 0.2, merged_from: ["composition"] },
  { factor: "input_data", label: "Input data", phi: 0.3, merged_from: ["input_data"] },
  { factor: "model", label: "Model", phi: 0.1, merged_from: ["model"] },
  { factor: "definition", label: "Definition", phi: -0.3, merged_from: ["definition"] },
];

describe("tool digests carry meanings and units", () => {
  it("labels every forecast citation, including the trailing-rate status quo", () => {
    const r = {
      tool: "forecast_departures",
      rounding: { band: "500 to 999" },
      values: {
        cohort: { name: "Engineering" }, horizon: 3, run_id: "R-2026-10-01#1", run_status: "published", cutoff: "2026-10-01",
        expected: 13.1, i80: [8, 18], i95: [6, 22], annual_rate: 0.088, hist: { expected: 15.4 },
      },
    };
    const d = getTool("forecast_departures")!.digest(r as never, "r1") as { cite: string[]; units: string };
    expect(d.cite.every((c) => /\}\} \(.+\)$/.test(c))).toBe(true);
    expect(d.cite.find((c) => c.startsWith("{{r1.hist.expected"))).toMatch(/trailing-rate status quo/);
    expect(d.cite.find((c) => c.startsWith("{{r1.expected"))).toMatch(/people/);
    expect(d.units).toMatch(/never percentages/);
  });

  it("states that a change is in people and how large the largest factor is", () => {
    const r = {
      tool: "explain_change",
      values: {
        cohort: { name: "Engineering" }, horizon: 3, from: "R-2026-09-01#1", to: "R-2026-10-01#1",
        from_value: 13.5, to_value: 13.1, delta: -0.4, interval80_width: 10, factors, largest: "Calendar",
      },
    };
    const d = getTool("explain_change")!.digest(r as never, "r1") as { cite: string[]; units: string; largest_factor_share: number };
    expect(d.units).toMatch(/counts of people/);
    expect(d.units).toMatch(/never percentages or percentage points/);
    for (const field of ["delta", "from_value", "to_value", "interval80_width"]) {
      expect(d.cite.find((c) => c.startsWith(`{{r1.${field}`))).toMatch(/people/);
    }
    // 0.7 of a total factor size of 1.6: the largest single factor, not most of the change
    expect(d.largest_factor_share).toBe(0.44);
    expect(d.largest_factor_share).toBeLessThan(0.5);
  });
});
