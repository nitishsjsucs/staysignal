// npm run dev:wrangler: builds the app and serves it with wrangler dev on 127.0.0.1:8795 (inspector 9245), in fixtures
// mode with the stub model by default, plus the fixture runner that completes engine jobs from committed outputs.
// `--engine` (npm run dev:engine) instead starts the local engine on 127.0.0.1:8196 (the warehouse shim and the runner
// thread, after `staysignal engine prepare`) and runs the Worker in engine mode: every job is computed live.
// Every process is recorded in var/pids; `npm run stop` stops them all.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { readDevVars } from "./dev-keys.ts";
import { PORTS, startGroup, waitForHttp, waitPortFree } from "./lib/pids.ts";

/** The local TLS endpoint wrangler dev serves with --local-protocol https uses a self-signed certificate. */
function httpsUp(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForHttps(url: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await httpsUp(url)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** The public demo locally (ADR 0018): the built Worker's .dev.vars holds empty values for the local secrets, so no
 * runner token or dev key reaches demo mode, and a fresh throwaway session key is returned for --var (wrangler dev
 * loads only the secret names the config declares). Written after the build, never committed. */
function publicDemoKey(): string {
  writeFileSync("dist/staysignal/.dev.vars", `SS_RUNNER_TOKEN=""\nSS_DEV_JWKS=""\nSS_DEV_SIGNING_JWK=""\nSS_HMAC_MASTER_KEY=""\n`, { mode: 0o600 });
  return randomBytes(48).toString("base64");
}

// `demo` (npm run demo only) sets SS_DEMO=1: the Worker then replays recorded model output only (src/worker/config.ts).
// `publicDemo` (npm run dev:public-demo, the public demo's e2e) runs SS_AUTH_MODE=demo with no fixture runner; `https`
// serves https://127.0.0.1:8795 with wrangler's self-signed certificate, so the Secure session cookie works under any
// host name a browser maps to it.
export async function serve(opts: { build?: boolean; llm?: string; dataMode?: string; runner?: boolean; demo?: boolean; publicDemo?: boolean; https?: boolean } = {}): Promise<void> {
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
  const vars = [`SS_LLM:${opts.llm ?? process.env.SS_LLM ?? "stub"}`, `SS_DATA_MODE:${dataMode}`, `SS_DEMO:${opts.demo ? "1" : "0"}`];
  if (opts.publicDemo) {
    vars.push("SS_AUTH_MODE:demo", "SS_PUBLIC_DEMO:1", "SS_RUNNER:inline", `SS_DEMO_SIGNING_KEY:${publicDemoKey()}`);
  }
  const scheme = opts.https ? "https" : "http";
  startGroup("wrangler", "npx", ["wrangler", "dev", "-c", "dist/staysignal/wrangler.json", "--port", String(PORTS.worker), "--inspector-port", String(PORTS.inspector), "--ip", "127.0.0.1", ...(opts.https ? ["--local-protocol", "https"] : []), ...vars.flatMap((v) => ["--var", v])], { port: PORTS.worker, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const health = `${scheme}://127.0.0.1:${PORTS.worker}/api/health`;
  if (!(await (opts.https ? waitForHttps(health, 120_000) : waitForHttp(health, 120_000)))) throw new Error("wrangler dev did not become healthy; see var/logs/wrangler.log");
  if (opts.runner !== false && dataMode !== "engine" && !opts.publicDemo) startGroup("fixture-runner", process.execPath, ["scripts/fixture-runner.ts", "--base", `http://127.0.0.1:${PORTS.worker}`], { port: null });
  console.log(`[serve] ${scheme}://127.0.0.1:${PORTS.worker} (${opts.publicDemo ? "public demo, " : ""}${dataMode} mode, ${opts.llm ?? process.env.SS_LLM ?? "stub"} model); stop with npm run stop`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const publicDemo = process.argv.includes("--public-demo");
  await serve({ build: !process.argv.includes("--no-build"), ...(process.argv.includes("--engine") ? { dataMode: "engine" } : {}), ...(publicDemo ? { publicDemo, llm: "stub", https: process.argv.includes("--https") } : {}) });
}
