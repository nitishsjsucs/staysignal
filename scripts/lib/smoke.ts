// The production smoke test's checks (SPEC 23.2 step 7 and 11): pure functions over responses, so the script can run
// them against the live Worker and the tests against fakes. Each check is PASS, FAIL, WARN, SKIP or MANUAL with its
// detail; a MANUAL item is something only a person can do (the one-time PIN sign-in, the demo questions).
import { READ_TOOLS } from "../gen-agent-evals.ts";

/** The MCP client is bound to the analyst role, which is offered every registry tool; READ_TOOLS is that list (a test
 * keeps it equal to the registry). */
export function mcpExpected(): string[] {
  return [...READ_TOOLS].sort();
}

export type SmokeStatus = "PASS" | "FAIL" | "WARN" | "SKIP" | "MANUAL";
export interface SmokeResult {
  id: string;
  status: SmokeStatus;
  detail: string;
}

export const FREE_DAILY_REQUESTS = 100_000; // Workers Free, per account, shared with the four sibling repos
export const FREE_CPU_MS = 10; // per invocation on Workers Free (and per Durable Object invocation, SPEC 14.11)
export const FREE_SUBREQUESTS = 50;
export const WORKER_MAX_BYTES = 104_857_600; // 100 MiB per Worker query (SPEC 17.2)
export const RUNNER_MAX_BYTES = 1_073_741_824; // 1 GiB per runner job

export interface SmokeOptions {
  fixtures: boolean; // path A: no BigQuery, no runner
}

/** The checks in order, with what each one sends; `--dry-run` prints this and sends nothing. */
export function plan(opts: SmokeOptions): { id: string; sends: string }[] {
  return [
    { id: "access-enforced", sends: "GET /api/runs with no credentials (expects a redirect to Access, or 401/403)" },
    { id: "mcp-tools", sends: "POST /mcp tools/list with the staysignal-mcp service token" },
    { id: "runner-protocol", sends: opts.fixtures ? "skipped in fixtures mode" : "POST /internal/runner/lease with the staysignal-runner service token" },
    { id: "workers-usage", sends: "GraphQL Analytics: today's requests, subrequests and CPU p99 for the script, and the account's requests" },
    { id: "bigquery-bytes", sends: opts.fixtures ? "skipped in fixtures mode" : "bq: the largest bytes billed per identity in the last day, label app=staysignal" },
    { id: "manual", sends: "nothing: a checklist for the operator" },
  ];
}

export function accessEnforced(status: number, location: string | null): SmokeResult {
  const redirected = status >= 300 && status < 400 && /cloudflareaccess\.com/.test(location ?? "");
  const ok = redirected || status === 401 || status === 403;
  return { id: "access-enforced", status: ok ? "PASS" : "FAIL", detail: ok ? `unauthenticated request answered ${status}` : `unauthenticated request answered ${status}; Access is not in front of the Worker` };
}

/** tools/list may come back as JSON or as one server-sent event; either way the tool names are read. */
export function toolNames(body: string): string[] {
  const text = body.trim().startsWith("{") ? body : body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  const doc = JSON.parse(text) as { result?: { tools?: { name: string }[] } };
  return (doc.result?.tools ?? []).map((t) => t.name).sort();
}

export function mcpTools(status: number, body: string, expected: string[] = mcpExpected()): SmokeResult {
  if (status !== 200) return { id: "mcp-tools", status: "FAIL", detail: `tools/list answered ${status}` };
  const names = toolNames(body);
  const missing = expected.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !expected.includes(n));
  return missing.length || extra.length
    ? { id: "mcp-tools", status: "FAIL", detail: `unexpected: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}` }
    : { id: "mcp-tools", status: "PASS", detail: `the ${names.length} governed tools of the analyst role` };
}

export function runnerProtocol(status: number, body: string): SmokeResult {
  if (status !== 200) return { id: "runner-protocol", status: "FAIL", detail: `lease answered ${status}; check SS_RUNNER_TOKEN_ID` };
  const doc = JSON.parse(body) as { next_poll_ms?: unknown };
  return typeof doc.next_poll_ms === "number"
    ? { id: "runner-protocol", status: "PASS", detail: `lease answered with next_poll_ms ${doc.next_poll_ms}` }
    : { id: "runner-protocol", status: "FAIL", detail: "lease answered without next_poll_ms" };
}

export const USAGE_QUERY = `query($account: String!, $script: String!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    script: workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $start, datetime_leq: $end }) {
      sum { requests subrequests errors } quantiles { cpuTimeP99 }
    }
    account: workersInvocationsAdaptive(limit: 1000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
  } }
}`;

interface UsageRow {
  sum: { requests: number; subrequests?: number; errors?: number };
  quantiles?: { cpuTimeP99: number };
}

/** cpuTimeP99 is in microseconds; the account total includes the sibling repos, which share the Free allowance. */
export function workersUsage(doc: { data?: { viewer?: { accounts?: { script: UsageRow[]; account: UsageRow[] }[] } }; errors?: { message: string }[] }): SmokeResult {
  if (doc.errors?.length) return { id: "workers-usage", status: "FAIL", detail: `GraphQL: ${doc.errors[0]!.message}` };
  const acc = doc.data?.viewer?.accounts?.[0];
  if (!acc) return { id: "workers-usage", status: "FAIL", detail: "no account in the GraphQL answer" };
  const req = acc.script.reduce((s, r) => s + r.sum.requests, 0);
  const sub = acc.script.reduce((s, r) => s + (r.sum.subrequests ?? 0), 0);
  const cpuMs = Math.max(0, ...acc.script.map((r) => (r.quantiles?.cpuTimeP99 ?? 0) / 1000));
  const total = acc.account.reduce((s, r) => s + r.sum.requests, 0);
  const subPer = req ? sub / req : 0;
  const detail = `today: ${req} requests, CPU p99 ${cpuMs.toFixed(1)} ms, ${subPer.toFixed(1)} subrequests a request; account ${total} of ${FREE_DAILY_REQUESTS}`;
  if (total >= FREE_DAILY_REQUESTS || subPer > FREE_SUBREQUESTS) return { id: "workers-usage", status: "FAIL", detail };
  if (cpuMs > FREE_CPU_MS || total >= 0.8 * FREE_DAILY_REQUESTS) return { id: "workers-usage", status: "WARN", detail };
  return { id: "workers-usage", status: "PASS", detail };
}

export const BYTES_SQL =
  "SELECT user_email, MAX(total_bytes_billed) AS max_billed, COUNT(*) AS jobs " +
  "FROM `region-us`.INFORMATION_SCHEMA.JOBS_BY_PROJECT " +
  "WHERE creation_time > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY) " +
  "AND EXISTS (SELECT 1 FROM UNNEST(labels) AS l WHERE l.key = 'app' AND l.value = 'staysignal') " +
  "GROUP BY user_email";

/** One row per identity; the Worker's service account is held to 100 MiB, everything else to the runner's 1 GiB. */
export function bigqueryBytes(rows: { user_email: string; max_billed: string | number | null; jobs: string | number }[]): SmokeResult {
  if (!rows.length) return { id: "bigquery-bytes", status: "WARN", detail: "no labeled job in the last day" };
  const over = rows.filter((r) => Number(r.max_billed ?? 0) > (r.user_email.startsWith("staysignal-worker@") ? WORKER_MAX_BYTES : RUNNER_MAX_BYTES));
  const detail = rows.map((r) => `${r.user_email.split("@")[0]}: ${r.jobs} jobs, max ${Number(r.max_billed ?? 0)} bytes`).join("; ");
  return { id: "bigquery-bytes", status: over.length ? "FAIL" : "PASS", detail };
}

export const MANUAL = [
  "Sign in at the Worker's URL with the one-time PIN as the People Analytics Lead",
  "Ask 'Forecast voluntary departures in Engineering over the next 90 days' and check the answer cites its result",
  "Run the 20-question Workers AI smoke eval under the 1,500-neuron cap and check no <think> text appears",
  "Verify the audit log head on the Reviews page reads 'Chain verified'",
];

export function overall(results: SmokeResult[]): boolean {
  return !results.some((r) => r.status === "FAIL");
}
