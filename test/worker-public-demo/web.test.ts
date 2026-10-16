// ADR 0018: the public demo cannot be turned against its visitors from another web page. A request another site
// starts (an Origin that is not this exact origin, or Sec-Fetch-Site cross-site or same-site) is refused before any
// Durable Object request, WebSocket upgrades included: other Workers on the account's workers.dev subdomain are
// same-site, so a SameSite cookie alone does not keep their pages out. Every response the Worker makes carries
// nosniff, no referrer, frame denial and no caching, and malformed typed inputs answer 400, never 500.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/worker/app";
import worker from "../../src/worker/index";
import { countingEnv, DEMO_BASE, demoCall, demoJson, P, resetGate, visit, WS_UPGRADE } from "../helpers/demo";

const ctx = {} as ExecutionContext;
const SIBLING = "https://other.nitish-ratakonda.workers.dev";

beforeEach(resetGate);

describe("requests another site starts", () => {
  it("refuses a WebSocket upgrade from another origin or site, before any Durable Object request", async () => {
    const v = await visit(P.lead);
    const counted = countingEnv();
    const foreign: Record<string, string>[] = [
      { Origin: "https://evil.example" },
      { Origin: SIBLING },
      { Origin: DEMO_BASE.replace("https:", "http:") },
      { Origin: `${DEMO_BASE}:8443` },
      { Origin: "null" },
      { Origin: DEMO_BASE, "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const kind of ["analyst", "workspace"]) {
      for (const headers of foreign) {
        const r = await worker.fetch(new Request(`${DEMO_BASE}/agents-ws/${kind}`, { headers: { ...WS_UPGRADE, Cookie: v.cookie, ...headers } }), counted.env, ctx);
        expect(r.status, `${kind} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    expect(counted.calls()).toBe(0);
    // the app's own socket opens
    const own = await exports.default.fetch(new Request(`${DEMO_BASE}/agents-ws/analyst`, { headers: { ...WS_UPGRADE, Cookie: v.cookie, Origin: DEMO_BASE, "Sec-Fetch-Site": "same-origin" } }));
    expect(own.status).toBe(101);
    own.webSocket!.accept();
    own.webSocket!.close();
  });

  it("refuses API and session requests another site starts, before any Durable Object request", async () => {
    const v = await visit(P.lead);
    const counted = countingEnv();
    const call = (path: string, headers: Record<string, string>, method = "GET") =>
      worker.fetch(new Request(`${DEMO_BASE}${path}`, { method, headers: { Cookie: v.cookie, "content-type": "application/json", ...headers }, ...(method === "POST" ? { body: JSON.stringify({ principal: P.director }) } : {}) }), counted.env, ctx);
    const foreign: Record<string, string>[] = [
      // a top-level navigation from another site carries a SameSite=Lax cookie; an <img> on a sibling Worker's page
      // carries any SameSite cookie
      { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
      { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors" },
      { Origin: SIBLING },
      { Origin: DEMO_BASE.replace("https:", "http:") },
    ];
    for (const path of ["/api/forecast?cohort=Engineering", "/api/me", "/demo/session"]) {
      for (const headers of foreign) expect((await call(path, headers)).status, `${path} ${JSON.stringify(headers)}`).toBe(403);
    }
    for (const headers of foreign) expect((await call("/demo/role", headers, "POST")).status, `POST /demo/role ${JSON.stringify(headers)}`).toBe(403);
    expect(counted.calls()).toBe(0);
    // the app's own requests, an address typed into the browser and a client that is not a browser go through
    expect((await call("/api/me", { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" })).status).toBe(200);
    expect((await call("/api/me", { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" })).status).toBe(200);
    expect((await call("/api/me", {})).status).toBe(200);
    expect((await call("/demo/role", { Origin: DEMO_BASE, "Sec-Fetch-Site": "same-origin" }, "POST")).status).toBe(200);
  });
});

describe("responses the Worker makes", () => {
  it("carry nosniff, no referrer, frame denial and no caching, early refusals included", async () => {
    const v = await visit();
    const cases: [string, Response][] = [
      ["/dev/login", await demoCall("/dev/login?principal=pa-lead@larkspur.example")],
      ["/mcp", await demoCall("/mcp")],
      ["/agents/x", await demoCall("/agents/x")],
      ["/agents-ws/analyst without an upgrade", await demoCall("/agents-ws/analyst", { cookie: v.cookie })],
      ["/agents-ws/analyst without a cookie", await demoCall("/agents-ws/analyst", { headers: WS_UPGRADE })],
      ["a long query value", await demoCall(`/api/forecast?cohort=${"x".repeat(300)}`, { cookie: v.cookie })],
      ["a cross-origin write", await demoCall("/demo/role", { cookie: v.cookie, body: { principal: P.director }, headers: { Origin: "https://evil.example" } })],
      ["a body over 8 KiB", await demoCall("/api/reviews/draft", { cookie: v.cookie, raw: JSON.stringify({ cohort: "x".repeat(9000) }) })],
      ["/api/me without a cookie", await demoCall("/api/me")],
      ["/api/me", await demoCall("/api/me", { cookie: v.cookie })],
      ["/api/health", await demoCall("/api/health")],
      ["GET /demo/session", await demoCall("/demo/session")],
    ];
    for (const [label, r] of cases) {
      expect(r.headers.get("X-Content-Type-Options"), label).toBe("nosniff");
      expect(r.headers.get("Referrer-Policy"), label).toBe("no-referrer");
      expect(r.headers.get("X-Frame-Options"), label).toBe("DENY");
      expect(r.headers.get("Content-Security-Policy"), label).toContain("frame-ancestors 'none'");
      expect(r.headers.get("Cache-Control"), label).toBe("no-store");
    }
  });

  it("answers an unexpected error with a bare JSON refusal", async () => {
    const v = await visit();
    const app = buildApp();
    app.get("/api/boom", () => {
      throw new Error("an internal detail");
    });
    const r = await app.fetch(new Request(`${DEMO_BASE}/api/boom`, { headers: { Cookie: v.cookie } }), env, ctx);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: "internal" });
    expect(text).not.toContain("detail");
  });
});

describe("typed inputs", () => {
  it("answer 400, never 500", async () => {
    const v = await visit(P.lead);
    const bad: [string, Parameters<typeof demoCall>[1]][] = [
      ["/api/traces?limit=abc", {}],
      ["/api/traces?limit=-5", {}],
      ["/api/audit?since=abc", {}],
      ["/api/actions/abc/rollback", { body: { reason: "a reason" } }],
      ["/api/actions/1.5/rollback", { body: { reason: "a reason" } }],
      ["/api/actions/0/rollback", { body: { reason: "a reason" } }],
      ["/api/actions/1/rollback", { body: { reason: { a: 1 } } }],
      ["/api/actions/1/rollback", { body: { reason: 5 } }],
      ["/api/approvals/REV-0001/approve", { body: { reason: ["r".repeat(2000)] } }],
      ["/api/approvals/REV-0001/reject", { body: { reason: { r: "x" } } }],
      ["/api/reviews/draft", { body: { cohort: ["Platform Engineering"] } }],
      ["/api/reviews/draft", { body: { cohort: "Platform Engineering", horizon: "3" } }],
      ["/demo/role", { raw: "null" }],
      ["/api/reviews/draft", { raw: "null" }],
      ["/api/approvals/REV-0001/approve", { raw: "null" }],
    ];
    for (const [path, opts] of bad) {
      const r = await demoCall(path, { cookie: v.cookie, ...opts });
      expect(r.status, `${path} ${JSON.stringify(opts)}`).toBe(400);
    }
    // the same routes still answer well-formed requests
    expect((await demoCall("/api/traces?limit=5", { cookie: v.cookie })).status).toBe(200);
    expect((await demoCall("/api/audit?since=0", { cookie: v.cookie })).status).toBe(200);
    expect(await demoJson("/api/actions/1/rollback", { cookie: v.cookie, body: { reason: "a reason" } })).toMatchObject({ ok: false, code: "NOT_REVERSIBLE" });
  });

  it("forward only a well-formed WebSocket upgrade, refusing the rest before any Durable Object request", async () => {
    const v = await visit(P.lead);
    const counted = countingEnv();
    const up = (method: string, headers: Record<string, string>) => worker.fetch(new Request(`${DEMO_BASE}/agents-ws/analyst/get-messages`, { method, headers: { Cookie: v.cookie, ...headers } }), counted.env, ctx);
    expect((await up("POST", WS_UPGRADE)).status).toBe(404);
    expect((await up("GET", { Upgrade: "websocket" })).status).toBe(400);
    expect((await up("GET", { ...WS_UPGRADE, "Sec-WebSocket-Version": "8" })).status).toBe(400);
    expect(counted.calls()).toBe(0);
  });
});
