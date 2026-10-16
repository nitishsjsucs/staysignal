// ADR 0018: the public demo's session cookie. A visitor signs in at /demo/session and gets an HttpOnly, Secure,
// SameSite=Strict cookie named with the __Host- prefix (no Domain, Path=/) for one sandbox, at most 4 hours; every
// request verifies it in constant time. Tampering, a wrong key, an expired or over-long session, an unknown principal,
// two session cookies at once and attempts to raise a role are refused; dev tokens, Access assertions and spoofed
// principal headers mean nothing in demo mode.
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config";
import { DEMO_COOKIE, issueSession, signPayload, verifySession } from "../../src/worker/auth/demo-session";
import { actAs, cookieFrom, demoCall, demoJson, P, resetGate, visit } from "../helpers/demo";

const key = () => parseConfig(env).publicDemo!.signingKey;
const now = () => Math.floor(Date.now() / 1000);
type Me = { principal: { id: string; role: string; scopes: string[]; sandbox: { id: string; exp: number } }; public_demo: { expires_at: number } | null };

beforeEach(resetGate);

describe("signing in", () => {
  it("explains itself before sign-in and lists the seven roles, People Analytics Lead first by default", async () => {
    const s = await demoJson<{ public_demo: boolean; default_principal: string; principals: { id: string }[]; lifetime_seconds: number; session: null }>("/demo/session");
    expect(s.public_demo).toBe(true);
    expect(s.default_principal).toBe(P.lead);
    expect(s.principals).toHaveLength(7);
    expect(s.lifetime_seconds).toBe(4 * 3600);
    expect(s.session).toBeNull();
    expect((await demoCall("/api/me")).status).toBe(401);
  });

  it("sets an HttpOnly, Secure, SameSite=Strict __Host- cookie that lives at most 4 hours", async () => {
    const r = await demoCall("/demo/session", { body: {} });
    expect(r.status).toBe(200);
    const set = r.headers.get("Set-Cookie")!;
    // the __Host- prefix: a browser accepts it only from this host, Secure, with Path=/ and no Domain, so another
    // Worker on the account's workers.dev subdomain cannot set (toss) a session cookie for the demo
    expect(set).toMatch(/^__Host-ss_demo=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("Secure");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/;");
    expect(set).not.toMatch(/Domain=/i);
    const age = Number(/Max-Age=(\d+)/.exec(set)![1]);
    expect(age).toBeGreaterThan(4 * 3600 - 5);
    expect(age).toBeLessThanOrEqual(4 * 3600);
    const me = await demoJson<Me>("/api/me", { cookie: cookieFrom(r) });
    expect(me.principal.id).toBe(P.lead);
    expect(me.principal.role).toBe("pa_lead");
    expect(me.principal.sandbox.id).toMatch(/^[a-z2-7]{20}$/);
    expect(me.public_demo?.expires_at).toBe(me.principal.sandbox.exp);
  });

  it("refuses a principal that is not one of the seven", async () => {
    expect((await demoCall("/demo/session", { body: { principal: "ceo@larkspur.example" } })).status).toBe(400);
    expect((await demoCall("/demo/session", { body: { principal: "agent:staysignal" } })).status).toBe(400);
  });

  it("switches roles inside the same sandbox without extending it", async () => {
    const v = await visit();
    const before = await demoJson<Me>("/api/me", { cookie: v.cookie });
    const d = await actAs(v, P.director);
    const after = await demoJson<Me>("/api/me", { cookie: d.cookie });
    expect(after.principal.id).toBe(P.director);
    expect(after.principal.sandbox).toEqual(before.principal.sandbox);
    // signing in again while signed in is a role switch too: no second sandbox
    const again = await demoCall("/demo/session", { cookie: d.cookie, body: { principal: P.auditor } });
    const third = await demoJson<Me>("/api/me", { cookie: cookieFrom(again) });
    expect(third.principal.sandbox).toEqual(before.principal.sandbox);
    expect(third.principal.role).toBe("auditor");
  });
});

describe("verifying the cookie on every request", () => {
  it("refuses a tampered payload, a tampered MAC and garbage", async () => {
    const v = await visit();
    const value = v.cookie.slice(`${DEMO_COOKIE}=`.length);
    const [, payload, mac] = value.split(".") as [string, string, string];
    const body = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const forged = btoa(JSON.stringify({ ...body, p: P.director })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const bad of [`v1.${forged}.${mac}`, `v1.${payload}.${mac.slice(0, -2)}AA`, `v2.${payload}.${mac}`, "v1..", "not-a-cookie", `v1.${payload}`]) {
      const r = await demoCall("/api/me", { cookie: `${DEMO_COOKIE}=${bad}` });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ reason: "invalid" });
    }
  });

  it("refuses two session cookies at once, whichever comes first, and the old cookie name", async () => {
    const a = await visit();
    const b = await visit();
    for (const cookie of [`${a.cookie}; ${b.cookie}`, `${b.cookie}; ${a.cookie}`, `${a.cookie}; ${a.cookie}`]) {
      const r = await demoCall("/api/me", { cookie });
      expect(r.status).toBe(401);
      expect(await r.json()).toMatchObject({ reason: "invalid" });
    }
    expect((await demoCall("/api/me", { cookie: a.cookie.replace(`${DEMO_COOKIE}=`, "ss_demo=") })).status).toBe(401);
    expect((await demoCall("/api/me", { cookie: `other=1; ${a.cookie}` })).status).toBe(200);
  });

  it("refuses a cookie signed with another key", async () => {
    const other = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const t = now();
    const cookie = await issueSession(other, { principal: P.lead, sandbox: "abcdefghijklmnopqrst", iat: t, exp: t + 600 });
    expect((await demoCall("/api/me", { cookie: `${DEMO_COOKIE}=${cookie}` })).status).toBe(401);
    expect((await verifySession(key(), cookie, t)).ok).toBe(false);
  });

  it("refuses an expired session, one issued in the future and one longer than 4 hours", async () => {
    const t = now();
    const expired = await signPayload(key(), { p: P.lead, s: "abcdefghijklmnopqrst", iat: t - 3600, exp: t - 1 });
    const r = await demoCall("/api/me", { cookie: `${DEMO_COOKIE}=${expired}` });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ reason: "expired" });
    const future = await signPayload(key(), { p: P.lead, s: "abcdefghijklmnopqrst", iat: t + 3600, exp: t + 7200 });
    expect(await verifySession(key(), future, t)).toEqual({ ok: false, reason: "invalid" });
    const long = await signPayload(key(), { p: P.lead, s: "abcdefghijklmnopqrst", iat: t, exp: t + 4 * 3600 + 1 });
    expect(await verifySession(key(), long, t)).toEqual({ ok: false, reason: "invalid" });
    await expect(issueSession(key(), { principal: P.lead, sandbox: "abcdefghijklmnopqrst", iat: t, exp: t + 5 * 3600 })).rejects.toThrow();
  });

  it("never takes a role or scopes from the cookie", async () => {
    const t = now();
    // a validly signed cookie that names a principal outside the seven, or carries a role and scopes, gains nothing
    const unknown = await signPayload(key(), { p: "root@larkspur.example", s: "abcdefghijklmnopqrst", iat: t, exp: t + 600 });
    expect((await demoCall("/api/me", { cookie: `${DEMO_COOKIE}=${unknown}` })).status).toBe(401);
    const agent = await signPayload(key(), { p: "agent:staysignal", s: "abcdefghijklmnopqrst", iat: t, exp: t + 600 });
    expect((await demoCall("/api/me", { cookie: `${DEMO_COOKIE}=${agent}` })).status).toBe(401);
    const v = await visit(P.auditor);
    const sandbox = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const escalated = await signPayload(key(), { p: P.auditor, s: sandbox.id, iat: t, exp: sandbox.exp, role: "pa_lead", scopes: ["review:approve", "rollback"] });
    const me = await demoJson<Me>("/api/me", { cookie: `${DEMO_COOKIE}=${escalated}` });
    expect(me.principal.role).toBe("auditor");
    expect(me.principal.scopes).not.toContain("rollback");
    // the auditor cannot roll back or approve whatever the cookie claims
    const out = await demoJson<{ ok: boolean; code: string }>("/api/actions/1/rollback", { cookie: `${DEMO_COOKIE}=${escalated}`, body: { reason: "test" } });
    expect(out).toMatchObject({ ok: false, code: "WRONG_ROLE" });
  });

  it("ignores dev tokens, Access assertions and a spoofed principal header", async () => {
    const spoof = JSON.stringify({ id: P.lead, role: "pa_lead", scopes: ["rollback"], assignedOrgs: [], kind: "human", display: "x", sandbox: { id: "abcdefghijklmnopqrst", exp: now() + 600 } });
    expect((await demoCall("/api/me", { headers: { "x-ss-principal": spoof } })).status).toBe(401);
    expect((await demoCall("/api/me", { headers: { Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.x" } })).status).toBe(401);
    expect((await demoCall("/api/me", { headers: { "Cf-Access-Jwt-Assertion": "eyJhbGciOiJSUzI1NiJ9.e30.x" } })).status).toBe(401);
    const v = await visit(P.auditor);
    const me = await demoJson<Me>("/api/me", { cookie: v.cookie, headers: { "x-ss-principal": spoof } });
    expect(me.principal.id).toBe(P.auditor);
  });

  it("refuses role switching and reset without a valid session", async () => {
    expect((await demoCall("/demo/role", { body: { principal: P.director } })).status).toBe(401);
    expect((await demoCall("/demo/reset", { body: {} })).status).toBe(401);
    const v = await visit();
    expect((await demoCall("/demo/role", { cookie: v.cookie, body: { principal: "x@larkspur.example" } })).status).toBe(400);
  });
});
