// npm run deploy -- --fixtures [--dry-run] [--yes] (SPEC 23.2 path A): the fixtures-mode deployment. It renders
// infra/cloudflare/wrangler.fixtures.template.jsonc with the operator's values from .prod/state.json (placeholders
// with --dry-run), refuses anything the Workers Free rules forbid, builds the app against the rendered config, and
// either runs `wrangler deploy --dry-run` with the 8 MiB upload check (CI and builders) or deploys (the operator only,
// with --yes). Builders never deploy. `--production` renders the BigQuery deployment; `--demo` renders the public
// demo (ADR 0018), which needs no operator state: only the SS_DEMO_SIGNING_KEY secret, set beforehand.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { freePlanProblems } from "./lib/free-plan.ts";
import { placeholderValues, type ProdState, renderTemplate } from "./lib/prod-state.ts";

const ROOT = process.cwd();
export const TEMPLATE = join("infra", "cloudflare", "wrangler.fixtures.template.jsonc");
export const PRODUCTION_TEMPLATE = join("infra", "cloudflare", "wrangler.production.template.jsonc");
export const RENDERED = join("var", "deploy", "wrangler.fixtures.jsonc");
export const PRODUCTION_RENDERED = join("var", "deploy", "wrangler.production.jsonc");
export const DEMO_TEMPLATE = join("infra", "cloudflare", "wrangler.demo.template.jsonc");
export const DEMO_RENDERED = join("var", "deploy", "wrangler.demo.jsonc");
export const OUTDIR = join("var", "deploy", "out");
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export function render(dryRun: boolean, statePath = join(ROOT, ".prod", "state.json"), template = TEMPLATE): string {
  const header = `// Rendered by scripts/deploy.ts from ${template}; gitignored, never committed.\n`;
  // the public demo has no account-specific value: nothing to read from the operator's state
  if (template === DEMO_TEMPLATE) return header + renderTemplate(readFileSync(join(ROOT, template), "utf8"), {});
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as ProdState) : null;
  return header + renderTemplate(readFileSync(join(ROOT, template), "utf8"), placeholderValues(state, dryRun));
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
  const production = process.argv.includes("--production");
  const demo = process.argv.includes("--demo");
  if ([production, demo, process.argv.includes("--fixtures")].filter(Boolean).length !== 1) {
    console.error("deploy: name one target: --fixtures (path A), --production (path B, BigQuery) or --demo (the public demo)");
    process.exit(2);
  }
  if (!dryRun && !process.argv.includes("--yes")) {
    console.error("deploy: this deploys to the operator's Cloudflare account; rerun with --yes, or use --dry-run");
    process.exit(2);
  }
  const text = render(dryRun, join(ROOT, ".prod", "state.json"), production ? PRODUCTION_TEMPLATE : demo ? DEMO_TEMPLATE : TEMPLATE);
  const target = production ? PRODUCTION_RENDERED : demo ? DEMO_RENDERED : RENDERED;
  const problems = freePlanProblems(text);
  if (problems.length) {
    console.error(`deploy: the config breaks the Workers Free rules:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  mkdirSync(join(ROOT, "var", "deploy"), { recursive: true });
  writeFileSync(join(ROOT, target), text);
  console.log(`[deploy] rendered ${target}${dryRun && !demo ? " with placeholder values" : ""}`);
  run("npx", ["vite", "build"], { ...process.env, SS_WRANGLER_CONFIG: join(ROOT, target) });
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
  if (demo) console.log("[deploy] deployed the public demo Worker staysignal-demo; open https://staysignal-demo.<your workers.dev subdomain>.workers.dev");
  else console.log(`[deploy] deployed the ${production ? "production" : "fixtures-mode"} Worker; open it through Cloudflare Access`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
