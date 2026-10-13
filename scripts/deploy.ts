// npm run deploy -- --fixtures [--dry-run] [--yes] (SPEC 23.2 path A): the fixtures-mode deployment. It renders
// infra/cloudflare/wrangler.fixtures.template.jsonc with the operator's values from .prod/state.json (placeholders
// with --dry-run), refuses anything the Workers Free rules forbid, builds the app against the rendered config, and
// either runs `wrangler deploy --dry-run` with the 8 MiB upload check (CI and builders) or deploys (the operator only,
// with --yes). Builders never deploy. The production (BigQuery) deployment arrives with the BigQuery client (M8).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { freePlanProblems } from "./lib/free-plan.ts";
import { placeholderValues, type ProdState, renderTemplate } from "./lib/prod-state.ts";

const ROOT = process.cwd();
export const TEMPLATE = join("infra", "cloudflare", "wrangler.fixtures.template.jsonc");
export const RENDERED = join("var", "deploy", "wrangler.fixtures.jsonc");
export const OUTDIR = join("var", "deploy", "out");
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function render(dryRun: boolean, statePath = join(ROOT, ".prod", "state.json")): string {
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as ProdState) : null;
  const header = "// Rendered by scripts/deploy.ts from infra/cloudflare/wrangler.fixtures.template.jsonc; gitignored, never committed.\n";
  return header + renderTemplate(readFileSync(join(ROOT, TEMPLATE), "utf8"), placeholderValues(state, dryRun));
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    total += s.isDirectory() ? dirBytes(p) : s.size;
  }
  return total;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  execFileSync(cmd, args, { stdio: "inherit", env });
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  if (!process.argv.includes("--fixtures")) {
    console.error("deploy: only --fixtures exists yet; the production (BigQuery) deployment arrives with the BigQuery client");
    process.exit(2);
  }
  if (!dryRun && !process.argv.includes("--yes")) {
    console.error("deploy: this deploys to the operator's Cloudflare account; rerun with --yes, or use --dry-run");
    process.exit(2);
  }
  const text = render(dryRun);
  const problems = freePlanProblems(text);
  if (problems.length) {
    console.error(`deploy: the config breaks the Workers Free rules:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  mkdirSync(join(ROOT, "var", "deploy"), { recursive: true });
  writeFileSync(join(ROOT, RENDERED), text);
  console.log(`[deploy] rendered ${RENDERED}${dryRun ? " with placeholder values" : ""}`);
  run("npx", ["vite", "build"], { ...process.env, SS_WRANGLER_CONFIG: join(ROOT, RENDERED) });
  const built = join("dist", "staysignal", "wrangler.json");
  if (dryRun) {
    run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", OUTDIR, "-c", built]);
    const bytes = dirBytes(join(ROOT, OUTDIR));
    console.log(`[deploy] dry run: upload ${(bytes / 1024 / 1024).toFixed(2)} MiB uncompressed (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MiB)`);
    if (bytes > MAX_UPLOAD_BYTES) {
      console.error(`deploy: the upload in ${relative(ROOT, OUTDIR)} exceeds 8 MiB uncompressed`);
      process.exit(1);
    }
    return;
  }
  run("npx", ["wrangler", "deploy", "-c", built]);
  console.log("[deploy] deployed the fixtures-mode Worker; open it through Cloudflare Access and run npm run prod:smoke -- --fixtures");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
