// npm run docs:figures [-- --check]: the charts of the README and docs/RESULTS.md (docs/images/figures/*.svg, light and
// dark, and the brand mark), drawn from the committed result files by scripts/lib/figures.ts. npm run results:readme
// writes them too, and npm test compares the committed files with a fresh render.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderFigures } from "./lib/figures.ts";
import { FIGURE_DIR, loadReports } from "./lib/results.ts";

/** The figure files a fresh render would write, keyed by path from the repository root. */
export function renderFigureFiles(root: string): Map<string, string> {
  return renderFigures(loadReports(root));
}

/** Paths whose committed content differs from a fresh render, are missing, or are left over from an earlier render. */
export function staleFigures(root: string, files: Map<string, string> = renderFigureFiles(root)): string[] {
  const stale = [...files].filter(([p, content]) => !existsSync(join(root, p)) || readFileSync(join(root, p), "utf8") !== content).map(([p]) => p);
  const dir = join(root, FIGURE_DIR);
  const extra = existsSync(dir) ? readdirSync(dir).map((n) => `${FIGURE_DIR}/${n}`).filter((p) => p.endsWith(".svg") && !files.has(p)) : [];
  return [...stale, ...extra].sort();
}

export function writeFigures(root: string, files: Map<string, string> = renderFigureFiles(root)): void {
  for (const [p, content] of files) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  const dir = join(root, FIGURE_DIR);
  for (const n of readdirSync(dir)) if (n.endsWith(".svg") && !files.has(`${FIGURE_DIR}/${n}`)) rmSync(join(dir, n));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const files = renderFigureFiles(root);
  if (process.argv.includes("--check")) {
    const stale = staleFigures(root, files);
    if (stale.length) {
      console.error(`figures are stale: ${stale.join(", ")}; run \`npm run docs:figures\``);
      process.exit(1);
    }
    console.log(`figures current (${files.size} files)`);
  } else {
    writeFigures(root, files);
    console.log(`figures written (${files.size} files)`);
  }
}
