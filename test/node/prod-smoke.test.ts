// prod:smoke (SPEC 23.2): each check against fake responses, and the whole run against a fake Worker, GraphQL API and
// bq, in both paths. Nothing here reaches the network.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { principalFor } from "../../src/shared/policy/roles";
import { toolsFor } from "../../src/shared/tools/registry";
import { accessEnforced, bigqueryBytes, mcpExpected, mcpTools, overall, plan, runnerProtocol, toolNames, workersUsage } from "../../scripts/lib/smoke";
import { readEnvFile, runSmoke } from "../../scripts/prod-smoke";

const usage = (requests: number, cpuUs: number, sub: number, account: number) => ({
  data: { viewer: { accounts: [{ script: [{ sum: { requests, subrequests: sub, errors: 0 }, quantiles: { cpuTimeP99: cpuUs } }], account: [{ sum: { requests: account } }] }] } },
});

describe("prod:smoke checks", () => {
  it("expects exactly the tools the MCP client's analyst role is offered", () => {
    expect(mcpExpected()).toEqual(toolsFor(principalFor("svc:x", "people_analyst")).map((t) => t.name).sort());
  });

  it("requires Access in front of the Worker", () => {
    expect(accessEnforced(302, "https://team.cloudflareaccess.com/cdn-cgi/access/login").status).toBe("PASS");
    expect(accessEnforced(403, null).status).toBe("PASS");
    expect(accessEnforced(200, null).status).toBe("FAIL");
    expect(accessEnforced(302, "https://elsewhere.example").status).toBe("FAIL");
  });

  it("reads tools/list as JSON or as a server-sent event and wants the governed set exactly", () => {
    const tools = mcpExpected().map((name) => ({ name }));
    const json = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } });
    expect(toolNames(`event: message\ndata: ${json}\n\n`)).toEqual(mcpExpected());
    expect(mcpTools(200, json).status).toBe("PASS");
    expect(mcpTools(200, JSON.stringify({ result: { tools: [...tools, { name: "approve_review" }] } })).status).toBe("FAIL");
    expect(mcpTools(200, JSON.stringify({ result: { tools: tools.slice(1) } })).status).toBe("FAIL");
    expect(mcpTools(401, "").status).toBe("FAIL");
  });

  it("checks the runner protocol answers a lease", () => {
    expect(runnerProtocol(200, JSON.stringify({ job: null, next_poll_ms: 30000 })).status).toBe("PASS");
    expect(runnerProtocol(401, "").status).toBe("FAIL");
  });

  it("holds Workers usage to the Free limits, with the account total shared with sibling repos", () => {
    expect(workersUsage(usage(1200, 4_000, 600, 20_000)).status).toBe("PASS");
    expect(workersUsage(usage(1200, 14_000, 600, 20_000)).status).toBe("WARN"); // CPU p99 over 10 ms
    expect(workersUsage(usage(1200, 4_000, 600, 85_000)).status).toBe("WARN"); // 80% of the daily requests
    expect(workersUsage(usage(1200, 4_000, 600, 100_000)).status).toBe("FAIL");
    expect(workersUsage(usage(10, 4_000, 600, 20_000)).status).toBe("FAIL"); // 60 subrequests a request
    expect(workersUsage({ errors: [{ message: "not authorized" }] }).status).toBe("FAIL");
  });

  it("holds the Worker's account to 100 MiB and the runner to 1 GiB", () => {
    expect(bigqueryBytes([{ user_email: "staysignal-worker@p.iam.gserviceaccount.com", max_billed: 10_485_760, jobs: 3 }]).status).toBe("PASS");
    expect(bigqueryBytes([{ user_email: "staysignal-worker@p.iam.gserviceaccount.com", max_billed: 209_715_200, jobs: 1 }]).status).toBe("FAIL");
    expect(bigqueryBytes([{ user_email: "staysignal-runner@p.iam.gserviceaccount.com", max_billed: 209_715_200, jobs: 1 }]).status).toBe("PASS");
    expect(bigqueryBytes([]).status).toBe("WARN");
  });

  it("plans the same checks in both paths and skips the runner and BigQuery in fixtures mode", () => {
    expect(plan({ fixtures: true }).map((p) => p.id)).toEqual(plan({ fixtures: false }).map((p) => p.id));
    expect(plan({ fixtures: true }).find((p) => p.id === "bigquery-bytes")?.sends).toMatch(/skipped/);
  });
});

describe("prod:smoke run", () => {
  const env = { SS_WORKER_URL: "https://staysignal.example.workers.dev", SS_MCP_CLIENT_ID: "m.access", SS_MCP_CLIENT_SECRET: "ms", SS_RUNNER_CLIENT_ID: "r.access", SS_RUNNER_CLIENT_SECRET: "rs", CF_ACCOUNT_ID: "acct", CF_SETUP_TOKEN: "cf", SS_GCP_PROJECT: "my-project-123" };
  const sent: { url: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, headers });
    if (url.endsWith("/api/runs")) return new Response(null, { status: 302, headers: { location: "https://team.cloudflareaccess.com/login" } });
    if (url.endsWith("/mcp")) return new Response(JSON.stringify({ result: { tools: mcpExpected().map((name) => ({ name })) } }), { status: 200 });
    if (url.endsWith("/internal/runner/lease")) return new Response(JSON.stringify({ job: null, next_poll_ms: 30000 }), { status: 200 });
    return new Response(JSON.stringify(usage(900, 3_000, 300, 15_000)), { status: 200 });
  }) as unknown as typeof fetch;
  const fakeExec = (argv: string[]) => ({ ok: argv[0] === "bq", out: JSON.stringify([{ user_email: "staysignal-runner@p.iam.gserviceaccount.com", max_billed: "5000000", jobs: "4" }]) });

  it("passes path B against healthy fakes, sending service-token headers and never a secret in a URL", async () => {
    sent.length = 0;
    const results = await runSmoke(env, false, { fetch: fakeFetch, exec: fakeExec, now: () => new Date("2026-10-20T12:00:00Z") });
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["access-enforced", "PASS"],
      ["mcp-tools", "PASS"],
      ["runner-protocol", "PASS"],
      ["workers-usage", "PASS"],
      ["bigquery-bytes", "PASS"],
      ["manual", "MANUAL"],
    ]);
    expect(overall(results)).toBe(true);
    expect(sent.find((s) => s.url.endsWith("/mcp"))?.headers["CF-Access-Client-Id"]).toBe("m.access");
    expect(sent.find((s) => s.url.endsWith("/lease"))?.headers["CF-Access-Client-Id"]).toBe("r.access");
    expect(sent.every((s) => !/ms|rs|cf/.test(new URL(s.url).search))).toBe(true);
    expect(sent.find((s) => s.url.endsWith("/api/runs"))?.headers).toEqual({});
  });

  it("skips the runner and BigQuery in fixtures mode and fails without an https Worker URL", async () => {
    const results = await runSmoke(env, true, { fetch: fakeFetch, exec: fakeExec, now: () => new Date() });
    expect(results.filter((r) => r.status === "SKIP").map((r) => r.id)).toEqual(["runner-protocol", "bigquery-bytes"]);
    const bad = await runSmoke({ ...env, SS_WORKER_URL: "http://staysignal.example" }, true, { fetch: fakeFetch, exec: fakeExec, now: () => new Date() });
    expect(overall(bad)).toBe(false);
  });

  it("turns a network error into a FAIL for that check only", async () => {
    const flaky = (async (url: string, init?: RequestInit) => (url.endsWith("/mcp") ? Promise.reject(new Error("connect ECONNREFUSED")) : fakeFetch(url, init))) as unknown as typeof fetch;
    const results = await runSmoke(env, true, { fetch: flaky, exec: fakeExec, now: () => new Date() });
    expect(results.find((r) => r.id === "mcp-tools")).toMatchObject({ status: "FAIL", detail: "connect ECONNREFUSED" });
    expect(results.find((r) => r.id === "access-enforced")?.status).toBe("PASS");
  });

  it("reads the secrets file without quotes or comments, and a missing file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "smoke-"));
    const f = join(dir, "staysignal.env");
    writeFileSync(f, "# operator secrets\nSS_MCP_CLIENT_ID='m.access'\n\nCF_ACCOUNT_ID=\"acct\"\n");
    expect(readEnvFile(f)).toEqual({ SS_MCP_CLIENT_ID: "m.access", CF_ACCOUNT_ID: "acct" });
    expect(readEnvFile(join(dir, "missing.env"))).toEqual({});
  });
});
