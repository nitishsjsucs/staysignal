import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadReports } from "../../scripts/results-to-readme.ts";
import { END, type OracleCoverageReport, renderOracleCoverage, renderResults, replaceSection, START } from "../../scripts/lib/results.ts";

describe("README Results generation", () => {
  it("replaces only the marked section", () => {
    const md = `# T\n${START}\nold\n${END}\ntail`;
    expect(replaceSection(md, "new")).toBe(`# T\n${START}\nnew\n${END}\ntail`);
    expect(() => replaceSection("no markers", "x")).toThrow();
  });

  it("says so when nothing is recorded", () => {
    expect(renderResults([])).toBe("No recorded results yet.");
  });

  it("keeps the committed README in sync with the committed results", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(replaceSection(readme, renderResults(loadReports(process.cwd())))).toBe(readme);
  });

  it("renders oracle coverage with its command, date, target and per-cause table", () => {
    const r: OracleCoverageReport = {
      kind: "oracle-coverage",
      command: "uv run --project engine staysignal eval oracle-coverage --futures 2000",
      date: "2026-10-12",
      profile: "canonical",
      seed: 20261011,
      level: 0.9,
      band: [0.8, 0.97],
      n_futures: 2000,
      origins: ["2023-10-01", "2026-04-01"],
      cells: 18,
      coverage: 0.9123,
      within_band: true,
      by_cause_horizon: { "voluntary|3": { cells: 2, coverage: 1 } },
      seconds: 1,
    };
    const md = renderOracleCoverage("results/x.json", r);
    expect(md).toContain("91.2% of 18 cells (target 80.0% to 97.0%; met)");
    expect(md).toContain("2026-10-12");
    expect(md).toContain("| voluntary | n/a | 100.0% of 2 | n/a |");
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });
});
