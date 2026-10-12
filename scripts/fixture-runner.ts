// The fixture runner (SPEC 14.7): speaks the runner protocol without Python. It leases engine jobs from the Worker and
// completes each from test/fixtures/jobs/<job_key>.json (outputs the engine exported with `staysignal demo build`).
// Used by CI e2e, Playwright and the fixtures deployment's demo. Usage:
//   node scripts/fixture-runner.ts [--base http://127.0.0.1:8795] [--once] [--idle-exit-ms 600000]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDevVars } from "./dev-keys.ts";

const ROOT = process.cwd();

export interface Lease {
  job: { job_key: string; kind: string; params: unknown; attempt: number } | null;
  next_poll_ms: number;
}

export function fixtureFor(jobKey: string, dir = join(ROOT, "test", "fixtures", "jobs")): unknown | null {
  const p = join(dir, `${jobKey}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

async function post(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  const arg = (name: string, d: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? (process.argv[i + 1] ?? d) : d;
  };
  const base = arg("--base", "http://127.0.0.1:8795");
  const idleExit = Number(arg("--idle-exit-ms", "0"));
  const token = process.env.SS_RUNNER_TOKEN ?? readDevVars().SS_RUNNER_TOKEN;
  if (!token) throw new Error("SS_RUNNER_TOKEN missing (npm run dev:keys)");
  let idleSince = Date.now();
  for (;;) {
    let lease: Lease;
    try {
      lease = (await (await post(base, "/internal/runner/lease", token, { owner: "fixture-runner" })).json()) as Lease;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (lease.job) {
      idleSince = Date.now();
      const out = fixtureFor(lease.job.job_key);
      await post(base, "/internal/runner/complete", token, { job_key: lease.job.job_key, result: out ?? { error: "no fixture for this job" }, ok: out !== null });
      console.log(`[fixture-runner] ${lease.job.kind} ${lease.job.job_key.slice(0, 12)} ${out ? "completed" : "failed: no fixture"}`);
      continue;
    }
    if (process.argv.includes("--once")) return;
    if (idleExit && Date.now() - idleSince > idleExit) return;
    await new Promise((r) => setTimeout(r, Math.min(lease.next_poll_ms, 2000)));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
