// npm run dev:wrangler: builds the app and serves it with wrangler dev on 127.0.0.1:8795 (inspector 9245), in fixtures
// mode with the stub model by default, plus the fixture runner that completes engine jobs from committed outputs.
// Every process is recorded in var/pids; `npm run stop` stops them all.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PORTS, portOpen, startGroup, waitForHttp } from "./lib/pids.ts";

export async function serve(opts: { build?: boolean; llm?: string; dataMode?: string; runner?: boolean } = {}): Promise<void> {
  if (!existsSync(".dev.vars")) execFileSync(process.execPath, ["scripts/dev-keys.ts"], { stdio: "inherit" });
  if (await portOpen(PORTS.worker)) throw new Error(`port ${PORTS.worker} is busy; run npm run stop`);
  if (opts.build !== false) execFileSync("npx", ["vite", "build"], { stdio: "inherit" });
  const vars = [`SS_LLM:${opts.llm ?? process.env.SS_LLM ?? "stub"}`, `SS_DATA_MODE:${opts.dataMode ?? process.env.SS_DATA_MODE ?? "fixtures"}`, "SS_DEMO:1"];
  startGroup("wrangler", "npx", ["wrangler", "dev", "-c", "dist/staysignal/wrangler.json", "--port", String(PORTS.worker), "--inspector-port", String(PORTS.inspector), "--ip", "127.0.0.1", ...vars.flatMap((v) => ["--var", v])], { port: PORTS.worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (!(await waitForHttp(`http://127.0.0.1:${PORTS.worker}/api/health`, 120_000))) throw new Error("wrangler dev did not become healthy; see var/logs/wrangler.log");
  if (opts.runner !== false) startGroup("fixture-runner", process.execPath, ["scripts/fixture-runner.ts", "--base", `http://127.0.0.1:${PORTS.worker}`], { port: null });
  console.log(`[serve] http://127.0.0.1:${PORTS.worker} (fixtures mode, ${opts.llm ?? process.env.SS_LLM ?? "stub"} model); stop with npm run stop`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await serve({ build: !process.argv.includes("--no-build") });
}
