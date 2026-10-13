// npm run prod:smoke [-- --fixtures] [-- --dry-run] (SPEC 23.2 steps 7 and 11): checks the deployed Worker from the
// operator's machine. Automated: Access in front of the Worker, MCP tools/list with the staysignal-mcp service token,
// the runner protocol with the staysignal-runner token (path B), today's Workers usage against the Free limits from the
// GraphQL Analytics API, and BigQuery bytes billed against the caps (path B). Manual: the one-time PIN sign-in, the demo
// question, the Workers AI smoke eval and the audit head, printed as a checklist. Reads only: it sends lease, list and
// analytics requests, never a write. `--dry-run` prints what each check would send and sends nothing.
//
// Settings come from the environment and the gitignored .secrets/staysignal.env: SS_WORKER_URL, SS_MCP_CLIENT_ID and
// SS_MCP_CLIENT_SECRET, SS_RUNNER_CLIENT_ID and SS_RUNNER_CLIENT_SECRET, CF_ACCOUNT_ID, CF_SETUP_TOKEN (Account
// Analytics Read) and SS_GCP_PROJECT. Secret values are sent only as headers and never printed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Exec, realExec } from "./doctor.ts";
import { accessEnforced, bigqueryBytes, BYTES_SQL, MANUAL, mcpTools, overall, plan, runnerProtocol, type SmokeResult, USAGE_QUERY, workersUsage } from "./lib/smoke.ts";

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return out;
}

export interface SmokeDeps {
  fetch: typeof fetch;
  exec: Exec;
  now: () => Date;
}

const svc = (id?: string, secret?: string) => ({ "CF-Access-Client-Id": id ?? "", "CF-Access-Client-Secret": secret ?? "" });

export async function runSmoke(env: Record<string, string | undefined>, fixtures: boolean, deps: SmokeDeps): Promise<SmokeResult[]> {
  const base = (env.SS_WORKER_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return [{ id: "config", status: "FAIL", detail: "SS_WORKER_URL must be the Worker's https URL" }];
  const out: SmokeResult[] = [];
  const guard = async (id: string, f: () => Promise<SmokeResult>) => {
    try {
      out.push(await f());
    } catch (e) {
      out.push({ id, status: "FAIL", detail: (e as Error).message.split("\n")[0]! });
    }
  };

  await guard("access-enforced", async () => {
    const r = await deps.fetch(`${base}/api/runs`, { redirect: "manual" });
    return accessEnforced(r.status, r.headers.get("location"));
  });
  await guard("mcp-tools", async () => {
    if (!env.SS_MCP_CLIENT_ID || !env.SS_MCP_CLIENT_SECRET) return { id: "mcp-tools", status: "FAIL", detail: "SS_MCP_CLIENT_ID and SS_MCP_CLIENT_SECRET are missing" };
    const r = await deps.fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...svc(env.SS_MCP_CLIENT_ID, env.SS_MCP_CLIENT_SECRET), "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    return mcpTools(r.status, await r.text());
  });
  await guard("runner-protocol", async () => {
    if (fixtures) return { id: "runner-protocol", status: "SKIP", detail: "fixtures mode has no external runner" };
    const r = await deps.fetch(`${base}/internal/runner/lease`, {
      method: "POST",
      headers: { ...svc(env.SS_RUNNER_CLIENT_ID, env.SS_RUNNER_CLIENT_SECRET), "content-type": "application/json" },
      body: JSON.stringify({ owner: "prod-smoke" }),
    });
    return runnerProtocol(r.status, await r.text());
  });
  await guard("workers-usage", async () => {
    if (!env.CF_ACCOUNT_ID || !env.CF_SETUP_TOKEN) return { id: "workers-usage", status: "FAIL", detail: "CF_ACCOUNT_ID and CF_SETUP_TOKEN (Account Analytics Read) are missing" };
    const end = deps.now();
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    const r = await deps.fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_SETUP_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ query: USAGE_QUERY, variables: { account: env.CF_ACCOUNT_ID, script: "staysignal", start: start.toISOString(), end: end.toISOString() } }),
    });
    return workersUsage((await r.json()) as Parameters<typeof workersUsage>[0]);
  });
  await guard("bigquery-bytes", async () => {
    if (fixtures) return { id: "bigquery-bytes", status: "SKIP", detail: "fixtures mode reads no BigQuery" };
    if (!env.SS_GCP_PROJECT) return { id: "bigquery-bytes", status: "FAIL", detail: "SS_GCP_PROJECT is missing" };
    const r = deps.exec(["bq", "query", `--project_id=${env.SS_GCP_PROJECT}`, "--use_legacy_sql=false", "--format=json", "--maximum_bytes_billed=104857600", BYTES_SQL]);
    if (!r.ok) return { id: "bigquery-bytes", status: "FAIL", detail: r.out.split("\n")[0] ?? "bq failed" };
    return bigqueryBytes(JSON.parse(r.out || "[]"));
  });
  out.push({ id: "manual", status: "MANUAL", detail: MANUAL.join("; ") });
  return out;
}

/** The smoke test's one query outside the doctor's allowlist: the INFORMATION_SCHEMA read of bytes billed. */
const smokeExec: Exec = (argv) => (argv[0] === "bq" && argv[1] === "query" && argv.at(-1) === BYTES_SQL ? realExecUnchecked(argv) : realExec(argv));

function realExecUnchecked(argv: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const fixtures = process.argv.includes("--fixtures");
  if (process.argv.includes("--dry-run")) {
    for (const p of plan({ fixtures })) console.log(`${p.id.padEnd(16)} ${p.sends}`);
    console.log("dry run: nothing was sent");
    return;
  }
  const env = { ...readEnvFile(join(process.cwd(), ".secrets", "staysignal.env")), ...process.env };
  const results = await runSmoke(env, fixtures, { fetch, exec: smokeExec, now: () => new Date() });
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(16)} ${r.detail}`);
  process.exit(overall(results) ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
