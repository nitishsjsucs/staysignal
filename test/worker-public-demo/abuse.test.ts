// ADR 0018: what a visitor's own script cannot do to the account. WebSocket frames reach the agents only through the
// public demo's frame guard: a whole message list, a clear, a tool result, RPC or state frames store nothing and
// spend nothing; a chat request spends its units before anything is stored and carries only the server's history
// plus one new question; a spent sandbox's chat request is answered on its stream and stores nothing. The sandbox's
// read-only workspace connection cannot run the callable actions, reasons are capped inside the agent, plain requests
// to agent paths create no object, a known refusal costs no Durable Object request, an IPv6 client counts by its /64,
// and the gate counts sandboxes for the current signing key only.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CAPS, MEASURED, UNITS } from "../../src/shared/demo/budget";
import { localPrincipal } from "../../src/shared/policy/roles";
import { DEMO_TURN_MESSAGES } from "../../src/worker/agents/analyst-agent";
import type { WorkspaceAgent } from "../../src/worker/agents/workspace-agent";
import { clientPrefix } from "../../src/worker/auth/demo-session";
import { analystName } from "../../src/worker/auth/principal";
import { parseConfig } from "../../src/worker/config";
import { demoGate } from "../../src/worker/demo/gate";
import worker from "../../src/worker/index";
import { countingEnv, DEMO_BASE, demoCall, demoJson, nextClient, P, resetGate, sqlMeter, type Visitor, visit } from "../helpers/demo";

type Me = { principal: { sandbox: { id: string; exp: number } } };
type Sandbox = { id: string; exp: number };
type Frame = { type?: string; id?: string; body?: string; done?: boolean };

const RECORDED = "Forecast voluntary departures in Engineering over the next 90 days.";
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

beforeEach(resetGate);

async function sandboxOf(v: Visitor): Promise<Sandbox> {
  return (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
}

function workspaceStub(sb: Sandbox): DurableObjectStub<WorkspaceAgent> {
  return env.WORKSPACE_AGENT.get(env.WORKSPACE_AGENT.idFromName(`sbx-${sb.id}`)) as unknown as DurableObjectStub<WorkspaceAgent>;
}

async function analystStub(principal: string, sb: Sandbox): Promise<DurableObjectStub> {
  return env.ANALYST_AGENT.get(env.ANALYST_AGENT.idFromName(await analystName(parseConfig(env), { id: principal, sandbox: sb })));
}

/** Units the sandbox has spent so far. */
function spent(sb: Sandbox): Promise<number> {
  return runInDurableObject(workspaceStub(sb), (a: WorkspaceAgent) => (a as unknown as { meter: { spent: number } | null }).meter?.spent ?? 0);
}

/** Spends every unit the sandbox has left, directly in its object and past the minute window. */
async function spendAll(sb: Sandbox): Promise<void> {
  for (const step of [25, 1]) {
    for (;;) {
      const out = await runInDurableObject(workspaceStub(sb), (a: WorkspaceAgent) => {
        const m = (a as unknown as { meter: { window: unknown[] } | null }).meter;
        if (m) m.window = [];
        return a.admit(step);
      });
      if (!out.ok) break;
    }
  }
}

async function socket(kind: "analyst" | "workspace", cookie: string) {
  const r = await exports.default.fetch(new Request(`${DEMO_BASE}/agents-ws/${kind}`, { headers: { Upgrade: "websocket", Cookie: cookie } }));
  expect(r.status).toBe(101);
  const ws = r.webSocket!;
  ws.accept();
  const frames: Frame[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.addEventListener("message", (e) => {
    try {
      frames.push(JSON.parse(String(e.data)) as Frame);
    } catch {
      // not JSON
    }
  });
  ws.addEventListener("close", (e) => {
    closed = { code: e.code, reason: e.reason };
  });
  return { ws, frames, closed: () => closed };
}

function chatRequest(id: string, messages: unknown[]): string {
  return JSON.stringify({ type: "cf_agent_use_chat_request", id, init: { method: "POST", body: JSON.stringify({ messages, trigger: "submit-message" }) } });
}

async function responseDone(frames: Frame[], id: string, timeoutMs = 30_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (frames.some((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.done)) {
      return frames
        .filter((f) => f.type === "cf_agent_use_chat_response" && f.id === id && f.body)
        .map((f) => JSON.parse(f.body!) as { type: string; delta?: string })
        .map((c) => (c.type === "text-delta" ? (c.delta ?? "") : ""))
        .join("");
    }
    await settle(50);
  }
  throw new Error(`no response for ${id}`);
}

const userMessages = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, role: "user", parts: [{ type: "text", text: "x" }] }));

describe("the chat socket in a sandbox", () => {
  it("stores nothing and spends nothing for whole message lists, clears, tool results, RPC and state frames", async () => {
    const v = await visit(P.lead);
    const sb = await sandboxOf(v);
    const s = await socket("analyst", v.cookie);
    await settle();
    const analyst = await analystStub(P.lead, sb);
    const rows = await sqlMeter(analyst);
    const units = await spent(sb);
    const big = JSON.stringify({ type: "cf_agent_chat_messages", messages: userMessages(700) });
    expect(big.length).toBeLessThan(CAPS.maxWsFrameBytes);
    for (const f of [big, big, big, JSON.stringify({ type: "cf_agent_chat_clear" }), JSON.stringify({ type: "cf_agent_tool_result", toolCallId: "t1", toolName: "x", output: "y".repeat(50_000) }), JSON.stringify({ type: "cf_agent_tool_approval", toolCallId: "t1", approved: true }), JSON.stringify({ type: "rpc", id: "r1", method: "turn", args: [] }), JSON.stringify({ type: "cf_agent_state", state: { role: "auditor" } })]) s.ws.send(f);
    await settle(600);
    expect(rows.written()).toBe(0);
    expect(await spent(sb)).toBe(units);
    expect(await runInDurableObject(analyst, (a) => (a as unknown as { messages: unknown[] }).messages.length)).toBe(0);
    s.ws.close();
  });

  it("spends a chat turn's units before storing anything, and stores only the server's history plus the new question", async () => {
    const v = await visit(P.lead);
    const sb = await sandboxOf(v);
    const s = await socket("analyst", v.cookie);
    await settle();
    const analyst = await analystStub(P.lead, sb);
    const rows = await sqlMeter(analyst);
    const wsRows = await sqlMeter(workspaceStub(sb));
    const units = await spent(sb);
    // a forged history of 750 messages ahead of the question, in one frame under 64 KiB
    const frame = chatRequest("req1", [...userMessages(750, "h"), { id: "q1", role: "user", parts: [{ type: "text", text: RECORDED }] }]);
    expect(frame.length).toBeLessThan(CAPS.maxWsFrameBytes);
    s.ws.send(frame);
    await responseDone(s.frames, "req1");
    await settle();
    expect(await spent(sb)).toBe(units + UNITS.chatTurn);
    const stored = await runInDurableObject(analyst, (a) => (a as unknown as { messages: { id: string; role: string }[] }).messages.map((m) => m.role));
    expect(stored).toEqual(["user", "assistant"]);
    const written = rows.written() + wsRows.written();
    console.log(`[abuse] a chat turn with a forged 750-message history wrote ${written} rows`);
    expect(written).toBeLessThanOrEqual(UNITS.chatTurn * MEASURED.rowsWrittenPerUnit);
    // the same question again, with an ID the server already holds, is not a new question: nothing happens
    s.ws.send(chatRequest("req2", [{ id: "q1", role: "user", parts: [{ type: "text", text: RECORDED }] }]));
    await settle(500);
    expect(await spent(sb)).toBe(units + UNITS.chatTurn);
    s.ws.close();
  });

  it("answers a spent sandbox's chat request on its stream and stores nothing, asking the sandbox only once", async () => {
    const v = await visit(P.lead);
    const sb = await sandboxOf(v);
    const s = await socket("analyst", v.cookie);
    await settle();
    await spendAll(sb);
    const analyst = await analystStub(P.lead, sb);
    const rows = await sqlMeter(analyst);
    s.ws.send(chatRequest("req1", [{ id: "q1", role: "user", parts: [{ type: "text", text: RECORDED }] }]));
    expect(await responseDone(s.frames, "req1")).toBe(DEMO_TURN_MESSAGES.spent);
    s.ws.send(chatRequest("req2", [{ id: "q2", role: "user", parts: [{ type: "text", text: RECORDED }] }]));
    expect(await responseDone(s.frames, "req2")).toBe(DEMO_TURN_MESSAGES.spent);
    expect(rows.written()).toBe(0);
    expect(await runInDurableObject(analyst, (a) => (a as unknown as { refused: { verdict: { code: string } } | null }).refused?.verdict.code)).toBe("SANDBOX_SPENT");
    s.ws.close();
  });

  it("closes a connection that sends more than 20 frames a minute", async () => {
    const v = await visit(P.lead);
    const s = await socket("analyst", v.cookie);
    await settle();
    for (let i = 0; i <= CAPS.wsFramesPerMinute; i++) s.ws.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: `c${i}` }));
    await settle(500);
    expect(s.closed()?.code).toBe(4429);
  });
});

describe("the workspace socket in a sandbox", () => {
  it("cannot run the callable actions: RPC frames are dropped, write nothing and spend nothing", async () => {
    const v = await visit(P.lead);
    const sb = await sandboxOf(v);
    const d = await demoJson<{ data: { draft_id: string } }>("/api/reviews/draft", { cookie: v.cookie, body: { cohort: "Platform Engineering", horizon: 3 } });
    const rev = String((await demoJson<{ value: { review_id: string } }>(`/api/reviews/${d.data.draft_id}/submit`, { cookie: v.cookie, body: {} })).value.review_id);
    const s = await socket("workspace", v.cookie);
    await settle();
    const ws = workspaceStub(sb);
    const rows = await sqlMeter(ws);
    const units = await spent(sb);
    for (let i = 0; i < 10; i++) s.ws.send(JSON.stringify({ type: "rpc", id: `r${i}`, method: i % 2 ? "rollbackCallable" : "approveCallable", args: [i % 2 ? 1 : rev, "y".repeat(60_000)] }));
    await settle(600);
    expect(rows.written()).toBe(0);
    expect(await spent(sb)).toBe(units);
    expect(s.frames.filter((f) => f.type === "rpc")).toEqual([]);
    // and the callables refuse in a sandbox even when reached
    await expect(runInDurableObject(ws, (a: WorkspaceAgent) => a.approveCallable(rev, "y"))).rejects.toThrow(/public demo/);
    s.ws.close();
  });

  it("refuses a reason over the cap inside the agent, before anything is written", async () => {
    const v = await visit(P.lead);
    const sb = await sandboxOf(v);
    const d = await demoJson<{ data: { draft_id: string } }>("/api/reviews/draft", { cookie: v.cookie, body: { cohort: "Platform Engineering", horizon: 3 } });
    const rev = String((await demoJson<{ value: { review_id: string } }>(`/api/reviews/${d.data.draft_id}/submit`, { cookie: v.cookie, body: {} })).value.review_id);
    const ws = workspaceStub(sb);
    const rows = await sqlMeter(ws);
    const lead = { ...localPrincipal(P.lead)!, sandbox: sb };
    const director = { ...localPrincipal(P.director)!, sandbox: sb };
    const long = "z".repeat(CAPS.maxReasonChars + 1);
    const out = await runInDurableObject(ws, (a: WorkspaceAgent) => [a.approve(lead, rev, long), a.approve(director, rev, long), a.reject(director, rev, long), a.rollback(director, 2, long)].map((o) => o.ok || o.code));
    expect(out).toEqual(["REASON_TOO_LONG", "REASON_TOO_LONG", "REASON_TOO_LONG", "REASON_TOO_LONG"]);
    expect(rows.written()).toBe(0);
  });
});

describe("agent paths and known refusals", () => {
  it("answers 404 to a plain request on an agent path, with no Durable Object request", async () => {
    const v = await visit(P.lead);
    const counted = countingEnv();
    for (const path of ["/agents-ws/analyst", "/agents-ws/analyst/get-messages", "/agents-ws/workspace", "/agents-ws/workspace/x"]) {
      const r = await worker.fetch(new Request(`${DEMO_BASE}${path}`, { headers: { Cookie: v.cookie } }), counted.env, {} as ExecutionContext);
      expect(r.status, path).toBe(404);
    }
    expect(counted.calls()).toBe(0);
  });

  it("refuses a retired or spent sandbox's requests without a Durable Object request once it knows", async () => {
    const v = await visit(P.lead);
    expect((await demoCall("/demo/reset", { cookie: v.cookie, body: {} })).status).toBe(200);
    const counted = countingEnv();
    const call = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`${DEMO_BASE}${path}`, { headers: { Cookie: v.cookie, ...headers } }), counted.env, {} as ExecutionContext);
    for (let i = 0; i < 3; i++) expect((await call("/api/me")).status).toBe(401);
    expect((await call("/agents-ws/analyst", { Upgrade: "websocket" })).status).toBe(401);
    expect(counted.calls()).toBe(0);

    const w = await visit(P.lead);
    const sb = await sandboxOf(w);
    await spendAll(sb);
    const spentCall = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`${DEMO_BASE}${path}`, { headers: { Cookie: w.cookie, ...headers } }), counted.env, {} as ExecutionContext);
    const first = await spentCall("/api/me");
    expect(first.status).toBe(429);
    expect(await first.json()).toMatchObject({ code: "SANDBOX_SPENT" });
    const after = counted.calls();
    expect(after).toBeGreaterThan(0);
    for (let i = 0; i < 3; i++) expect((await spentCall("/api/forecast")).status).toBe(429);
    expect((await spentCall("/agents-ws/workspace", { Upgrade: "websocket" })).status).toBe(429);
    expect(counted.calls()).toBe(after);
  });
});

describe("the gate", () => {
  it("counts an IPv6 client by its /64", async () => {
    const net = "2001:db8:51:7";
    for (const a of [`${net}::1`, `${net}::2`, `${net}:aaaa::3`]) expect((await demoCall("/demo/session", { body: {}, client: a })).status).toBe(200);
    const fourth = await demoCall("/demo/session", { body: {}, client: `${net}:ffff:ffff:ffff:ffff` });
    expect(fourth.status).toBe(429);
    expect(await fourth.json()).toMatchObject({ code: "CLIENT_HOURLY" });
    expect((await demoCall("/demo/session", { body: {}, client: "2001:db8:51:8::1" })).status).toBe(200);
    expect((await demoCall("/demo/session", { body: {}, client: nextClient() })).status).toBe(200);
  });

  it("reduces addresses to what it counts", () => {
    expect(clientPrefix("2001:DB8:0:0:1::1")).toBe("2001:db8:0:0::/64");
    expect(clientPrefix("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(clientPrefix("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(clientPrefix("::1")).toBe("0:0:0:0::/64");
    expect(clientPrefix("64:ff9b::192.0.2.33")).toBe("64:ff9b:0:0::/64");
    expect(clientPrefix("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(clientPrefix("192.0.2.1")).toBe("192.0.2.1");
    expect(clientPrefix("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(clientPrefix("not an address")).toBe("not an address");
  });

  it("counts live and daily sandboxes for the current signing key only, so a rotation frees it", async () => {
    const gate = demoGate(env);
    const t = Date.UTC(2032, 0, 1, 12);
    for (let i = 0; i < CAPS.liveSandboxes; i++) expect((await gate.admit(`c${i}`, t + i, undefined, "old-key")).ok).toBe(true);
    expect(await gate.admit("c-x", t + 100, undefined, "old-key")).toMatchObject({ ok: false, code: "FULL" });
    expect((await gate.admit("c-x", t + 100, undefined, "new-key")).ok).toBe(true);
  });
});
