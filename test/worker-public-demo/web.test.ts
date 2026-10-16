// ADR 0018: the public demo cannot be turned against its visitors from another web page. A request another site
// starts (an Origin that is not this exact origin, or Sec-Fetch-Site cross-site or same-site) is refused before any
// Durable Object request, WebSocket upgrades included: other Workers on the account's workers.dev subdomain are
// same-site, so a SameSite cookie alone does not keep their pages out. A malformed upgrade spends nothing.
import { exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { countingEnv, DEMO_BASE, P, resetGate, visit, WS_UPGRADE } from "../helpers/demo";

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

describe("typed inputs", () => {
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
