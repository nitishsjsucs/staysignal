// ADR 0018: the caps of the public demo. The gate admits at most 3 new sandboxes per client an hour, 15 a UTC day and
// 10 live ones; a sandbox spends units per request (240 a minute, 600 in all, the lifetime count surviving eviction);
// one routine per sandbox; over a cap the answer says "The demo is busy, try again later" with Retry-After.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeEach, describe, expect, it } from "vitest";
import { CAPS, UNITS } from "../../src/shared/demo/budget";
import { demoGate } from "../../src/worker/demo/gate";
import type { WorkspaceAgent } from "../../src/worker/agents/workspace-agent";
import { cookieFrom, demoCall, demoJson, nextClient, P, resetGate, visit } from "../helpers/demo";

type Me = { principal: { sandbox: { id: string; exp: number } } };
const BUSY = "The demo is busy, try again later.";

beforeEach(resetGate);

describe("the gate", () => {
  it("admits at most 3 new sandboxes per client an hour", async () => {
    const client = nextClient();
    for (let i = 0; i < CAPS.newSandboxesPerClientPerHour; i++) await visit(undefined, client);
    const r = await demoCall("/demo/session", { body: {}, client });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "busy", code: "CLIENT_HOURLY", message: BUSY });
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(3500);
    // another client still gets in
    expect((await demoCall("/demo/session", { body: {}, client: nextClient() })).status).toBe(200);
  });

  it("admits at most 10 live sandboxes and 15 a day", async () => {
    for (let i = 0; i < CAPS.liveSandboxes; i++) await visit();
    const full = await demoCall("/demo/session", { body: {}, client: nextClient() });
    expect(full.status).toBe(503);
    expect(await full.json()).toMatchObject({ code: "FULL", message: BUSY });
    // the gate counts by time: an hour later the same records are still today's, and live ones may have ended
    const gate = demoGate(env);
    const t = Date.UTC(2031, 0, 1, 12);
    for (let i = 0; i < CAPS.newSandboxesPerDay; i++) expect((await gate.admit(`client-${i}`, t + i * 600_000, { ...CAPS, liveSandboxes: 1000 })).ok).toBe(true);
    const daily = await gate.admit("client-x", t + 11 * 3600_000, { ...CAPS, liveSandboxes: 1000 });
    expect(daily).toMatchObject({ ok: false, code: "DAILY" });
    // the next UTC day opens again
    expect((await gate.admit("client-x", Date.UTC(2031, 0, 2, 0, 1), { ...CAPS, liveSandboxes: 1000 })).ok).toBe(true);
  });

  it("stores an HMAC of the client address, never the address, and prunes old records", async () => {
    await visit(undefined, "192.0.2.77");
    const rows = await runInDurableObject(demoGate(env), (_i, state) => state.storage.sql.exec<{ client: string }>("SELECT client FROM sandboxes").toArray());
    expect(rows.length).toBe(1);
    expect(rows[0]!.client).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(rows)).not.toContain("192.0.2.77");
    const gate = demoGate(env);
    await gate.admit("old", Date.now() - 3 * 24 * 3600_000);
    await gate.admit("new", Date.now());
    const left = await runInDurableObject(demoGate(env), (_i, state) => state.storage.sql.exec<{ client: string }>("SELECT client FROM sandboxes").toArray().map((r) => r.client));
    expect(left).not.toContain("old");
  });

  it("frees a live slot when a visitor resets: the old sandbox is released", async () => {
    const v = await visit();
    const before = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const r = await demoCall("/demo/reset", { cookie: v.cookie, body: {} });
    expect(r.status).toBe(200);
    const after = (await demoJson<Me>("/api/me", { cookie: cookieFrom(r) })).principal.sandbox;
    expect(after.id).not.toBe(before.id);
    expect(after.exp).toBeGreaterThanOrEqual(before.exp);
    expect((await demoGate(env).stats()).live).toBe(1);
    // the old cookie now meets a retired sandbox
    const old = await demoCall("/api/me", { cookie: v.cookie });
    expect(old.status).toBe(401);
    expect(await old.json()).toMatchObject({ reason: "sandbox_expired" });
  });
});

describe("a sandbox's units", () => {
  it("are spent per request: 240 units a minute, then 429 with Retry-After", async () => {
    const v = await visit();
    let status = 200;
    let n = 0;
    while (status === 200 && n < 400) {
      status = (await demoCall("/api/me", { cookie: v.cookie })).status;
      n++;
    }
    expect(n - 1).toBe(CAPS.unitsPerSandboxPerMinute);
    const r = await demoCall("/api/me", { cookie: v.cookie });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: "RATE_LIMITED", message: BUSY });
    expect(Number(r.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("are capped at 600 for a sandbox's life, and the cap survives eviction", async () => {
    const v = await visit();
    const sandbox = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const ws = await getAgentByName(env.WORKSPACE_AGENT, `sbx-${sandbox.id}`);
    // spend units directly, past the minute window, evicting the object between blocks
    let used: number = UNITS.read;
    let k = 0;
    for (;;) {
      const out = await runInDurableObject(ws as unknown as DurableObjectStub<WorkspaceAgent>, (agent: WorkspaceAgent) => {
        (agent as unknown as { meter: { window: unknown[] } | null }).meter && ((agent as unknown as { meter: { window: unknown[] } }).meter.window = []);
        return agent.admit(7);
      });
      if (!out.ok) {
        expect(out.code).toBe("SANDBOX_SPENT");
        break;
      }
      used = out.used;
      if (++k % 9 === 0) await evictDurableObject(ws as unknown as DurableObjectStub);
    }
    expect(used).toBeLessThanOrEqual(CAPS.unitsPerSandbox);
    const r = await demoCall("/api/me", { cookie: v.cookie });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ code: "SANDBOX_SPENT" });
  });
});
