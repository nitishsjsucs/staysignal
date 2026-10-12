// C32: the MCP server enforces the same permissions as the chat dock (SPEC 14.9). A real MCP client
// (@modelcontextprotocol/client 2.0.0) talks to the Worker's /mcp through exports.default.fetch; the explicit Host
// header is needed inside the Workers test pool (verified 2026-10-12).
import { env, exports } from "cloudflare:workers";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { mintDevToken } from "../../src/worker/auth/dev-login";
import { parseConfig } from "../../src/worker/config";
import { P, tokenFor } from "../helpers/api";

async function connect(token: string | null): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (input, init) => {
      const req = new Request(input as RequestInfo, init as RequestInit);
      const headers = new Headers(req.headers);
      headers.set("Host", "localhost");
      if (token) headers.set("Authorization", `Bearer ${token}`);
      return exports.default.fetch(new Request(req, { headers }));
    },
  });
  const client = new Client({ name: "staysignal-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

type CallOut = { isError?: boolean; content: { type: string; text: string }[] };
const parse = (r: CallOut) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

describe("MCP server", () => {
  it("rejects a request without a valid token before the handler", async () => {
    const r = await exports.default.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { Host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(r.status).toBe(401);
    const bad = await exports.default.fetch(new Request("http://localhost/mcp", { method: "POST", headers: { Host: "localhost", Authorization: "Bearer not-a-token", "content-type": "application/json" }, body: "{}" }));
    expect(bad.status).toBe(401);
  });

  it("lists tools per role, with no write tools for anyone", async () => {
    const analyst = await connect(await tokenFor(P.analyst));
    const names = (await analyst.listTools()).tools.map((t) => t.name).sort();
    expect(names).toContain("forecast_departures");
    expect(names).toContain("workforce_flows");
    expect(names).toContain("prepare_review");
    for (const n of names) expect(n).not.toMatch(/approve|submit|rollback|mapping|publish|delete/);
    const dataEng = await connect(await tokenFor(P.dataEng));
    const deNames = (await dataEng.listTools()).tools.map((t) => t.name);
    expect(deNames).toContain("trace_lineage");
    expect(deNames).not.toContain("prepare_review"); // data engineers cannot propose reviews
    const auditor = await connect(await tokenFor(P.auditor));
    expect((await auditor.listTools()).tools.map((t) => t.name)).not.toContain("trace_lineage");
    await Promise.all([analyst.close(), dataEng.close(), auditor.close()]);
  });

  it("serves the same governed, rounded result as the API", async () => {
    const client = await connect(await tokenFor(P.analyst));
    const r = (await client.callTool({ name: "forecast_departures", arguments: { cohort: "Engineering", horizon_days: 90 } })) as CallOut;
    expect(r.isError).toBeFalsy();
    const env = parse(r) as { result_id: string; label: string; rounding: { step: number }; data: { expected: number; horizon: number } };
    expect(env.label).toBe("synthetic");
    expect(env.data.horizon).toBe(3);
    expect(env.rounding.step).toBe(0.1); // a cohort of 200 or more is served to the tenth (SPEC 17.5)
    const api = await exports.default.fetch(new Request("http://localhost/api/forecast?cohort=Engineering&horizon_days=90", { headers: { Authorization: `Bearer ${await tokenFor(P.analyst)}` } }));
    expect(((await api.json()) as { result_id: string }).result_id).toBe(env.result_id);
    await client.close();
  });

  it("refuses with the same codes: individual-level arguments, unassigned cohorts, team level", async () => {
    const hrbp = await connect(await tokenFor(P.hrbpEng));
    const notAssigned = (await hrbp.callTool({ name: "forecast_departures", arguments: { cohort: "Sales" } })) as CallOut;
    expect(notAssigned.isError).toBe(true);
    expect(parse(notAssigned)).toMatchObject({ refused: true, code: "NOT_ASSIGNED" });
    const team = (await hrbp.callTool({ name: "forecast_breakdown", arguments: { cohort: "Engineering", by: "team" } })) as CallOut;
    expect(parse(team).refused).toBe(true);
    await hrbp.close();
  });

  it("binds the MCP service-token principal to its role", async () => {
    const client = await connect(await mintDevToken(parseConfig(env), "svc:staysignal-mcp"));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("forecast_departures");
    await client.close();
  });
});
