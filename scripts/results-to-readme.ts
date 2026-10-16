// Renders results/*.json and evals/results/*.json into three places: the README's generated sections (the proof strip,
// the results headline and the limits, each between its markers), docs/RESULTS.md (every table) and the charts and
// diagrams under docs/images (scripts/render-figures.ts).
// Usage: node scripts/results-to-readme.ts [--check]   (pattern copied from PeopleLake, MIT)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadModelContext, loadReports, renderReadme, renderResultsPage } from "./lib/results.ts";
import { renderFigureFiles, staleFigures, writeFigures } from "./render-figures.ts";

export { loadReports };

export const RESULTS_PAGE = join("docs", "RESULTS.md");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const reports = loadReports(root);
  const readmePath = join(root, "README.md");
  const pagePath = join(root, RESULTS_PAGE);
  const readme = readFileSync(readmePath, "utf8");
  const nextReadme = renderReadme(readme, reports, loadModelContext(root));
  const nextPage = renderResultsPage(reports);
  const figures = renderFigureFiles(root);
  if (process.argv.includes("--check")) {
    let page = "";
    try {
      page = readFileSync(pagePath, "utf8");
    } catch {
      page = "";
    }
    const stale = [...(nextReadme !== readme ? ["README generated sections"] : []), ...(nextPage !== page ? ["docs/RESULTS.md"] : []), ...staleFigures(root, figures)];
    if (stale.length) {
      console.error(`README generated sections, docs/RESULTS.md or docs/images are stale (${stale.join(", ")}); run \`npm run results:readme\``);
      process.exit(1);
    }
    console.log("README generated sections, docs/RESULTS.md and the figures are current");
  } else {
    writeFileSync(readmePath, nextReadme);
    writeFileSync(pagePath, nextPage);
    writeFigures(root, figures);
    console.log(`README generated sections, docs/RESULTS.md and ${figures.size} figure files rendered`);
  }
}
