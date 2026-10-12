// npm run test:e2e [-- --update]: Playwright in mcr.microsoft.com/playwright:v1.63.0-noble under linux/amd64 (SPEC
// 16.4), container staysignal-playwright, run with --ipc=host --init --rm. Baselines are made only here because
// Chromium and Skia rasterize differently on arm64; CI uses the same image natively. Inside the container the
// repository is copied (without node_modules, dist, var, local state and .dev.vars), Linux dependencies are installed
// into a named volume that persists between runs, fresh dev keys are generated, and the global setup starts the built
// app under wrangler dev with the stub model and the fixture runner. --update rewrites the screenshot baselines.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE = "mcr.microsoft.com/playwright:v1.63.0-noble";
export const CONTAINER = "staysignal-playwright";

export function containerScript(update: boolean): string {
  return [
    "set -euo pipefail",
    "mkdir -p /work",
    "tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./var --exclude=./.wrangler --exclude=./.dev.vars --exclude=./.secrets --exclude=./engine/.venv --exclude=./test-results --exclude=./playwright-report --exclude=./test/e2e/__screenshots__ -cf - . | tar -C /work -xf -",
    "cd /work",
    "if ! cmp -s package-lock.json node_modules/.staysignal-lock 2>/dev/null; then npm ci --no-audit --no-fund && cp package-lock.json node_modules/.staysignal-lock; fi",
    "rm -rf test/e2e/__screenshots__ && ln -s /out/screenshots test/e2e/__screenshots__",
    "npm run -s dev:keys",
    `SS_E2E_SCREENSHOTS=1 npx playwright test --output /out/test-results${update ? " --update-snapshots" : ""}`,
  ].join("\n");
}

function main(): void {
  const root = resolve(".");
  const update = process.argv.includes("--update");
  mkdirSync(join(root, "test", "e2e", "__screenshots__"), { recursive: true });
  mkdirSync(join(root, "test-results"), { recursive: true });
  try {
    execFileSync(
      "docker",
      [
        "run", "--rm", "--platform", "linux/amd64", "--ipc=host", "--init", "--name", CONTAINER,
        "-v", `${root}:/src:ro`,
        "-v", "staysignal-e2e-node-modules:/work/node_modules",
        "-v", `${join(root, "test", "e2e", "__screenshots__")}:/out/screenshots`,
        "-v", `${join(root, "test-results")}:/out/test-results`,
        "-e", "CI=1", "-e", "WRANGLER_SEND_METRICS=false", "-e", "DO_NOT_TRACK=1",
        IMAGE, "bash", "-c", containerScript(update),
      ],
      { stdio: "inherit" },
    );
  } catch (e) {
    const status = (e as { status?: number | null }).status ?? 1;
    console.error(`the Playwright container exited with status ${status}${update ? "" : " (a first run needs --update to write the baselines)"}`);
    process.exit(status);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
