import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadReports } from "../../scripts/results-to-readme.ts";
import { END, renderResults, replaceSection, START } from "../../scripts/lib/results.ts";

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
});
