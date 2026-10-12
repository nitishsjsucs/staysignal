// npm run dev:wrangler: builds the app and serves it with wrangler dev on 127.0.0.1:8795 (inspector 9245), in fixtures
// mode with the stub model by default, plus the fixture runner that completes engine jobs from committed outputs.
// `--engine` (npm run dev:engine) instead starts the local engine on 127.0.0.1:8196 (the warehouse shim and the runner
// thread, after `staysignal engine prepare`) and runs the Worker in engine mode: every job is computed live.
// Every process is recorded in var/pids; `npm run stop` stops them all.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readDevVars } from "./dev-keys.ts";
import { PORTS, startGroup, waitForHttp, waitPortFree } from "./lib/pids.ts";

export async function serve(opts: { build?: boolean; llm?: string; dataMode?: string; runner?: boolean } = {}): Promise<void> {
  if (!existsSync(".dev.vars")) execFileSync(process.execPath, ["scripts/dev-keys.ts"], { stdio: "inherit" });
  if (!(await waitPortFree(PORTS.worker))) throw new Error(`port ${PORTS.worker} is busy; run npm run stop`);
  if (opts.build !== false) execFileSync("npx", ["vite", "build"], { stdio: "inherit" });
  const dataMode = opts.dataMode ?? process.env.SS_DATA_MODE ?? "fixtures";
  if (dataMode === "engine") {
    if (!(await waitPortFree(PORTS.engine))) throw new Error(`port ${PORTS.engine} is busy; run npm run stop`);
    if (!existsSync("var/engine/published/runs.json")) throw new Error("no engine state: run `uv run --project engine staysignal engine prepare` first");
    const token = readDevVars().SS_RUNNER_TOKEN;
    startGroup("engine", "uv", ["run", "--project", "engine", "staysignal", "serve", "--port", String(PORTS.engine), "--worker", `http://127.0.0.1:${PORTS.worker}`], {
      port: PORTS.engine,
      env: { ...process.env, SS_RUNNER_TOKEN: token ?? "", DBT_SEND_ANONYMOUS_USAGE_STATS: "false", DO_NOT_TRACK: "1", PYTHONUNBUFFERED: "1" },
    });
    if (!(await waitForHttp(`http://127.0.0.1:${PORTS.engine}/health`, 120_000))) throw new Error("the engine did not become healthy; see var/logs/engine.log");
  }
  const vars = [`SS_LLM:${opts.llm ?? process.env.SS_LLM ?? "stub"}`, `SS_DATA_MODE:${dataMode}`, "SS_DEMO:1"];
  startGroup("wrangler", "npx", ["wrangler", "dev", "-c", "dist/staysignal/wrangler.json", "--port", String(PORTS.worker), "--inspector-port", String(PORTS.inspector), "--ip", "127.0.0.1", ...vars.flatMap((v) => ["--var", v])], { port: PORTS.worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (!(await waitForHttp(`http://127.0.0.1:${PORTS.worker}/api/health`, 120_000))) throw new Error("wrangler dev did not become healthy; see var/logs/wrangler.log");
  if (opts.runner !== false && dataMode !== "engine") startGroup("fixture-runner", process.execPath, ["scripts/fixture-runner.ts", "--base", `http://127.0.0.1:${PORTS.worker}`], { port: null });
  console.log(`[serve] http://127.0.0.1:${PORTS.worker} (${dataMode} mode, ${opts.llm ?? process.env.SS_LLM ?? "stub"} model); stop with npm run stop`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await serve({ build: !process.argv.includes("--no-build"), ...(process.argv.includes("--engine") ? { dataMode: "engine" } : {}) });
}
