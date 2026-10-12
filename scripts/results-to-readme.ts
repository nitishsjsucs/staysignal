// Renders results/*.json and evals/results/*.json into README.md between the results markers.
// Usage: node scripts/results-to-readme.ts [--check]   (pattern copied from PeopleLake, MIT)
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_KINDS, type Report, renderResults, replaceSection } from "./lib/results.ts";

export function loadReports(root: string): { file: string; report: Report }[] {
  const out: { file: string; report: Report }[] = [];
  for (const dir of ["results", join("evals", "results")]) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir)).filter((x) => x.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names) {
      const report = JSON.parse(readFileSync(join(root, dir, name), "utf8")) as Report;
      if (REPORT_KINDS.includes(report.kind)) out.push({ file: `${dir}/${name}`, report });
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const path = join(root, "README.md");
  const current = readFileSync(path, "utf8");
  const next = replaceSection(current, renderResults(loadReports(root)));
  if (process.argv.includes("--check")) {
    if (next !== current) {
      console.error("README Results section is stale; run `npm run results:readme`");
      process.exit(1);
    }
    console.log("README Results section is current");
  } else {
    writeFileSync(path, next);
    console.log("README Results section rendered");
  }
}
