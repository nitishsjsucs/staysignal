// ADR 0018: in the public demo the MCP server, every dev route, the runner protocol and the internal fixture routes
// answer 404 whoever asks; mutating requests must come from this origin with bounded bodies; a misconfigured Worker
// answers 503 to everything; no path reaches a model server, the engine or Workers AI.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { demoCall, demoJson, P, resetGate, visit } from "../helpers/demo";

const reached: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    reached.push(url);
    throw new Error(`the public demo made an outbound request: ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(resetGate);

describe("routes that are off in the public demo", () => {
  it("answers 404 for /mcp, /dev/*, /api/dev/*, /internal/* and /agents/*, signed in or not", async () => {
    const v = await visit(P.analyst);
    const paths: [string, string][] = [
      ["POST", "/mcp"],
      ["GET", "/mcp"],
      ["GET", "/dev/login?principal=pa-lead@larkspur.example"],
      ["GET", "/dev/principals"],
      ["POST", "/api/dev/agent/turn"],
      ["POST", "/internal/runner/lease"],
      ["POST", "/internal/runner/heartbeat"],
      ["POST", "/internal/runner/complete"],
      ["GET", "/internal/fixtures/job/abc"],
      ["POST", "/internal/sources/arrived"],
      ["GET", "/agents/workspace-agent/larkspur"],
    ];
    for (const [method, path] of paths) {
      for (const cookie of [null, v.cookie]) {
        const r = await demoCall(path, { method, cookie, ...(method === "POST" ? { body: { question: "Forecast Engineering", source: "payroll", period: "2026-09" } } : {}), headers: { Authorization: "Bearer anything" } });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    }
    expect(reached).toEqual([]);
  });

  it("refuses cross-origin writes, bodies over 8 KiB, long reasons and long query values", async () => {
    const v = await visit();
    expect((await demoCall("/demo/role", { cookie: v.cookie, body: { principal: P.director }, headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await demoCall("/api/reviews/draft", { cookie: v.cookie, raw: JSON.stringify({ cohort: "x".repeat(9000) }) })).status).toBe(413);
    expect((await demoCall("/api/approvals/REV-0001/approve", { cookie: v.cookie, body: { reason: "r".repeat(301) } })).status).toBe(400);
    expect((await demoCall("/api/actions/1/rollback", { cookie: v.cookie, body: { reason: "r".repeat(301) } })).status).toBe(400);
    expect((await demoCall(`/api/forecast?cohort=${"x".repeat(201)}`, { cookie: v.cookie })).status).toBe(400);
    expect((await demoCall("/api/lab/interview", { cookie: v.cookie, body: { proposal: "infra-data-merge", persona_id: "P01", question: "q".repeat(301) } })).status).toBe(400);
    // a same-origin write goes through
    expect((await demoCall("/demo/role", { cookie: v.cookie, body: { principal: P.director }, headers: { Origin: "https://staysignal-demo.example.test" } })).status).toBe(200);
  });

  it("sends JSON with nosniff and no caching", async () => {
    const v = await visit();
    const r = await demoCall("/api/me", { cookie: v.cookie });
    expect(r.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(r.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("a misconfigured Worker", () => {
  it("answers 503 to every request when a demo rule fails", async () => {
    const bad = Object.create(env, { SS_DEMO_SIGNING_KEY: { value: "c2hvcnQ=" } }) as Env;
    for (const path of ["/api/health", "/demo/session", "/api/me", "/mcp", "/agents-ws/analyst"]) {
      const r = await worker.fetch(new Request(`https://staysignal-demo.example.test${path}`), bad, {} as ExecutionContext);
      expect(r.status, path).toBe(503);
      expect(await r.json()).toMatchObject({ error: "misconfigured" });
    }
    const withRunner = Object.create(env, { SS_RUNNER_TOKEN: { value: "a-real-token" } }) as Env;
    expect((await worker.fetch(new Request("https://staysignal-demo.example.test/api/health"), withRunner, {} as ExecutionContext)).status).toBe(503);
  });
});

describe("the persona interview in the public demo", () => {
  it("answers recorded questions only, never the engine or a model, and names the author's laptop", async () => {
    const v = await visit();
    const rec = await demoJson<{ recorded: { persona_id: string; question: string; provenance: string }[] }>("/api/lab/interviews/promotion-criteria-third-window", { cookie: v.cookie });
    expect(rec.recorded.length).toBeGreaterThan(0);
    expect(rec.recorded[0]!.provenance).toMatch(/^Recorded from Qwen3\.6-27B on the author's laptop/);
    const first = rec.recorded[0]!;
    const r = await demoCall("/api/lab/interview", { cookie: v.cookie, body: { proposal: "promotion-criteria-third-window", persona_id: first.persona_id, question: first.question } });
    expect(r.headers.get("x-staysignal-source")).toBe("recorded");
    const other = await demoCall("/api/lab/interview", { cookie: v.cookie, body: { proposal: "promotion-criteria-third-window", persona_id: first.persona_id, question: "What do you think of the cafeteria?" } });
    expect(other.headers.get("x-staysignal-source")).toBe("unrecorded");
    expect(await other.text()).toContain("the author's laptop");
    expect(reached).toEqual([]);
  });
});
