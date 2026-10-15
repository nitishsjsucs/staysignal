// ADR 0018: measures what one sandbox costs and checks the upper bounds src/shared/demo/budget.ts claims (MEASURED):
// Durable Object requests per unit (every RPC the Worker makes for a request, counted through a wrapped namespace),
// SQLite rows written per unit and to seed a sandbox (every statement's rowsWritten inside the sandbox's objects),
// and the bytes a sandbox stores after the whole guided tour, including the payroll simulation and chat turns.
import { env, exports } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { CAPS, MEASURED, UNITS } from "../../src/shared/demo/budget";
import { localPrincipal } from "../../src/shared/policy/roles";
import { buildApp } from "../../src/worker/app";
import { issueSession } from "../../src/worker/auth/demo-session";
import { analystName } from "../../src/worker/auth/principal";
import { parseConfig } from "../../src/worker/config";
import { demoGate } from "../../src/worker/demo/gate";
import { unitsFor } from "../../src/worker/demo/routes";
import { DEMO_BASE, P, resetGate, sqlMeter } from "../helpers/demo";

let calls = 0;
function countingStub<T extends object>(stub: T): T {
  return new Proxy(stub, {
    get(t, prop) {
      const v = Reflect.get(t, prop) as unknown;
      if (typeof v === "function" && typeof prop === "string" && prop !== "then") {
        return (...args: unknown[]) => {
          calls++;
          return Reflect.apply(v as (...a: unknown[]) => unknown, t, args);
        };
      }
      return v;
    },
  });
}
function countingNamespace<T extends DurableObjectNamespace>(ns: T): T {
  return new Proxy(ns, {
    get(t, prop) {
      const v = Reflect.get(t, prop) as unknown;
      if (prop === "get") return (id: DurableObjectId, o?: unknown) => countingStub(t.get(id, o as never));
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}
const counted = Object.create(env, {
  WORKSPACE_AGENT: { value: countingNamespace(env.WORKSPACE_AGENT) },
  ANALYST_AGENT: { value: countingNamespace(env.ANALYST_AGENT) },
  DEMO_GATE: { value: countingNamespace(env.DEMO_GATE) },
}) as Env;

const app = buildApp();
const key = () => parseConfig(env).publicDemo!.signingKey;
let cookieFor: (principal: string) => Promise<string>;
let sandbox = { id: "", exp: 0 };
let rows: () => number = () => 0;
let rowsRead: () => number = () => 0;
let seedRows = 0;
let seedRead = 0;
const perUnit: { path: string; units: number; doCalls: number; rows: number; read: number; ms: number }[] = [];
/** While the routine runs in the background its writes land between any two requests, so requests made then count
 * their units toward the routine's window instead of their own rows. */
let routineWindow: { units: number } | null = null;

async function call(path: string, as: string, body?: unknown): Promise<Response> {
  const method = body === undefined ? "GET" : "POST";
  const headers: Record<string, string> = { Cookie: await cookieFor(as), "CF-Connecting-IP": "198.51.100.200" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const ctx = createExecutionContext();
  const c0 = calls;
  const r0 = rows();
  const q0 = rowsRead();
  const t0 = Date.now();
  const res = await app.fetch(new Request(`${DEMO_BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), counted, ctx);
  await waitOnExecutionContext(ctx);
  await res.clone().text();
  const ms = Date.now() - t0;
  const units = unitsFor(method, new URL(`${DEMO_BASE}${path}`).pathname);
  if (routineWindow) routineWindow.units += units;
  perUnit.push({ path, units, doCalls: calls - c0, rows: routineWindow ? 0 : rows() - r0, read: routineWindow ? 0 : rowsRead() - q0, ms });
  return res;
}
const get = async <T>(path: string, as: string = P.lead): Promise<T> => (await (await call(path, as)).json()) as T;
const post = async <T>(path: string, body: unknown, as: string = P.lead): Promise<T> => (await (await call(path, as, body)).json()) as T;

async function until(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

beforeAll(async () => {
  await resetGate();
  const v = await demoGate(env).admit("budget-test");
  if (!v.ok) throw new Error("gate refused");
  sandbox = { id: v.sandbox, exp: v.exp };
  const id = env.WORKSPACE_AGENT.idFromName(`sbx-${sandbox.id}`);
  const m = await sqlMeter(env.WORKSPACE_AGENT.get(id));
  rows = m.written;
  rowsRead = m.read;
  const ws = await getAgentByName(env.WORKSPACE_AGENT, `sbx-${sandbox.id}`);
  await ws.initSandbox(sandbox.exp);
  seedRows = rows();
  seedRead = rowsRead();
  cookieFor = async (principal) => `ss_demo=${await issueSession(key(), { principal, sandbox: sandbox.id, iat: Math.floor(Date.now() / 1000), exp: sandbox.exp })}`;
});

describe("what one sandbox costs", () => {
  it("seeds within the rows the budget assumes", () => {
    console.log(`[budget] seed: ${seedRows} rows written, ${seedRead} rows read`);
    expect(seedRows).toBeGreaterThan(0);
    expect(seedRows).toBeLessThanOrEqual(MEASURED.rowsWrittenSeed);
    expect(seedRead).toBeLessThanOrEqual(MEASURED.rowsReadSeed);
  });

  it("stays within the per-unit bounds over the whole guided tour", async () => {
    const cohort = "org%3AEngineering";
    // Forecast, What changed, Trust, Research, Workforce, Governance as the lead
    for (const path of ["/api/me", "/api/cohorts", "/api/runs", `/api/forecast?cohort=${cohort}&horizon=3`, `/api/forecast/history?cohort=${cohort}&horizon=3`, `/api/forecast/breakdown?cohort=${cohort}&by=group&horizon=3`, `/api/forecast/breakdown?cohort=${cohort}&by=level_band&horizon=3`, `/api/trust?cohort=${cohort}&horizon=3`, `/api/changes?cohort=${cohort}&horizon=3&from=R-2026-09-01%231&to=R-2026-10-01%231`, "/api/evaluation", "/api/research", `/api/workforce/flows?cohort=${cohort}`, "/api/workforce/funnel?horizon=3", "/api/audit/actions", "/api/lab", "/api/lab/promotion-criteria-third-window", "/api/lab/interviews/promotion-criteria-third-window", "/api/traces?limit=50", "/api/audit", "/api/audit/verify"]) {
      expect((await call(path, P.lead)).status, path).toBe(200);
    }
    // Memory as the analyst
    for (const path of ["/api/memory/files", "/api/memory/log", "/api/memory/search?q=fixed-term", "/api/memory/file?path=decisions%2FDEC-2026-09-20-01.md"]) expect((await call(path, P.analyst)).status, path).toBe(200);
    // Data health: the payroll simulation, held, investigated, then the data engineer approves the mapping fix
    expect((await call("/api/quality/checks", P.analyst)).status).toBe(200);
    const r0 = rows();
    const q0 = rowsRead();
    const t0 = Date.now();
    routineWindow = { units: 0 };
    const started = await post<{ routine_id: string }>("/api/demo/arrival", {}, P.analyst);
    expect(started.routine_id).toBe("RTN-0001");
    // the arrival paid for a write; starting the routine spent the rest of its units inside the sandbox
    routineWindow.units += UNITS.routine - UNITS.write;
    perUnit.push({ path: "routine (its workflow steps)", units: UNITS.routine - UNITS.write, doCalls: 0, rows: 0, read: 0, ms: 0 });
    await until(async () => ((await get<{ proposals: { status: string }[] }>("/api/mappings/payroll", P.dataEng)).proposals ?? []).some((p) => p.status === "pending"));
    const mapping = await get<{ proposals: { subject_id: string }[] }>("/api/mappings/payroll", P.dataEng);
    expect((await post<{ ok: boolean }>(`/api/approvals/${mapping.proposals[0]!.subject_id}/approve`, { reason: "ANN means annual" }, P.dataEng)).ok).toBe(true);
    await until(async () => ((await get<{ routines: { status: string }[] }>("/api/routines", P.analyst)).routines[0]?.status ?? "") === "done");
    const routineRows = rows() - r0;
    const routineRead = rowsRead() - q0;
    const routineMs = Date.now() - t0;
    const routineUnits = routineWindow.units;
    routineWindow = null;
    for (const path of ["/api/quality/checks", "/api/runs", "/api/routines/RTN-0001", "/api/investigations"]) await call(path, P.analyst);
    // Reviews: draft, submit, the refused self-approval, the second lead's approval, the rollback
    const d = await post<{ data: { draft_id: string } }>("/api/reviews/draft", { cohort: "Platform Engineering", horizon: 3 });
    const s = await post<{ value: { review_id: string } }>(`/api/reviews/${d.data.draft_id}/submit`, {});
    const rev = s.value.review_id;
    expect((await post<{ code: string }>(`/api/approvals/${rev}/approve`, { reason: "mine" })).code).toBe("SELF_APPROVAL");
    const ok = await post<{ ok: boolean; value: { action_seq: number } }>(`/api/approvals/${rev}/approve`, { reason: "approved" }, P.director);
    expect(ok.ok).toBe(true);
    expect((await post<{ ok: boolean }>(`/api/actions/${ok.value.action_seq}/rollback`, { reason: "approved against the wrong cohort" }, P.director)).ok).toBe(true);
    for (const path of ["/api/reviews", `/api/reviews/${rev}`, "/api/approvals", "/api/audit", "/api/audit/verify"]) await call(path, P.director);
    // the persona interview
    await call("/api/lab/interview", P.lead, { proposal: "promotion-criteria-third-window", persona_id: "P01", question: "What would change your mind?" });

    // chat turns over the dock's WebSocket, recorded and stub, metered in the visitor's conversation too (the persisted
    // messages, the stream buffer and the trace)
    const p = { ...localPrincipal(P.lead)!, sandbox };
    const analystId = env.ANALYST_AGENT.idFromName(await analystName(parseConfig(env), p));
    const upgradeAnalyst = async () => {
      const r = await exports.default.fetch(new Request(`${DEMO_BASE}/agents-ws/analyst`, { headers: { Upgrade: "websocket", Cookie: await cookieFor(P.lead) } }));
      const ws = r.webSocket!;
      ws.accept();
      return ws;
    };
    // a connection that spends its whole frame allowance, of the harmless kinds the guard lets through (20 frames to a
    // request), in two minutes' worth (the per-minute cap is 20). The upgrade goes through exports.default, so its
    // requests are added by hand: the workspace's initialization and admission, the conversation's initialization and
    // the forwarded upgrade.
    const u0 = calls;
    const ut0 = Date.now();
    const spare = await upgradeAnalyst();
    // the upgrade's own time; the frames below are processed in a few milliseconds each, and an object idle between
    // them may hibernate, which Workers Free does not bill
    const upgradeMs = Date.now() - ut0;
    const analystMeter = await sqlMeter(env.ANALYST_AGENT.get(analystId));
    const analystRows = analystMeter.written;
    const analystRead = analystMeter.read;
    const f0 = rows() + analystRows();
    const fr0 = rowsRead() + analystRead();
    const realNow = Date.now.bind(Date);
    for (let i = 0; i < CAPS.wsFramesPerConnection; i++) {
      if (i === CAPS.wsFramesPerMinute) vi.spyOn(Date, "now").mockImplementation(() => realNow() + 61_000);
      spare.send(JSON.stringify({ type: i % 2 ? "cf_agent_chat_request_cancel" : "cf_agent_stream_resume_ack", id: `x${i}` }));
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 300));
    vi.restoreAllMocks();
    spare.close();
    perUnit.push({ path: "socket: upgrade and its frames", units: UNITS.socket, doCalls: calls - u0 + 4 + Math.ceil(CAPS.wsFramesPerConnection / 20), rows: rows() + analystRows() - f0, read: rowsRead() + analystRead() - fr0, ms: upgradeMs });

    // the dock's connection for the chat turns
    const socket = await upgradeAnalyst();
    const done = new Map<string, () => void>();
    socket.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as { type?: string; id?: string; done?: boolean };
      if (m.type === "cf_agent_use_chat_response" && m.done && m.id) done.get(m.id)?.();
    });
    await runInDurableObject(env.ANALYST_AGENT.get(analystId), (instance) => {
      (instance as unknown as { env: Env }).env = counted;
    });
    const turns = ["Forecast voluntary departures in Engineering over the next 90 days.", "What changed in Engineering since the previous forecast?", "Forecast voluntary departures in Sales over the next 30 days.", "Which checks failed on the payroll data?"];
    const history: unknown[] = [];
    for (const [i, q] of turns.entries()) {
      const c0 = calls;
      const w0 = rows() + analystRows();
      const rd0 = rowsRead() + analystRead();
      const tt0 = Date.now();
      history.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: q }] });
      const finished = new Promise<void>((resolve) => done.set(`req${i}`, resolve));
      socket.send(JSON.stringify({ type: "cf_agent_use_chat_request", id: `req${i}`, init: { method: "POST", body: JSON.stringify({ messages: history }) } }));
      await finished;
      await new Promise((r) => setTimeout(r, 200));
      // the frame itself counts one twentieth of a request; count it as one
      perUnit.push({ path: `chat: ${q}`, units: UNITS.chatTurn, doCalls: calls - c0 + 1, rows: rows() + analystRows() - w0, read: rowsRead() + analystRead() - rd0, ms: Date.now() - tt0 });
    }
    socket.close();
    console.log(`[budget] chat turns: ${perUnit.filter((x) => x.path.startsWith("chat:")).map((x) => `${x.rows} rows, ${x.doCalls} DO calls`).join("; ")}`);

    const worst = (f: (x: (typeof perUnit)[number]) => number) => perUnit.reduce((m, x) => (f(x) > f(m) ? x : m), perUnit[0]!);
    const doWorst = worst((x) => x.doCalls / x.units);
    const rowWorst = worst((x) => x.rows / x.units);
    const readWorst = worst((x) => x.read / x.units);
    const msWorst = worst((x) => x.ms / x.units);
    console.log(`[budget] ${perUnit.length} requests; seed ${seedRows} rows; routine ${routineRows} rows; worst DO calls per unit ${(doWorst.doCalls / doWorst.units).toFixed(2)} (${doWorst.path}); worst rows per unit ${(rowWorst.rows / rowWorst.units).toFixed(2)} (${rowWorst.path})`);
    expect(doWorst.doCalls / doWorst.units, doWorst.path).toBeLessThanOrEqual(MEASURED.doRequestsPerUnit);
    expect(rowWorst.rows / rowWorst.units, rowWorst.path).toBeLessThanOrEqual(MEASURED.rowsWrittenPerUnit);
    console.log(`[budget] the routine window: ${routineRows} rows for ${routineUnits} units`);
    expect(routineRows / routineUnits).toBeLessThanOrEqual(MEASURED.rowsWrittenPerUnit);
    console.log(`[budget] rows read: worst ${(readWorst.read / readWorst.units).toFixed(1)} per unit (${readWorst.path}), the routine window ${(routineRead / routineUnits).toFixed(1)}; wall-clock: worst ${(msWorst.ms / msWorst.units).toFixed(1)} ms per unit (${msWorst.path}), the routine window ${(routineMs / routineUnits).toFixed(1)}`);
    expect(readWorst.read / readWorst.units, readWorst.path).toBeLessThanOrEqual(MEASURED.rowsReadPerUnit);
    expect(routineRead / routineUnits).toBeLessThanOrEqual(MEASURED.rowsReadPerUnit);
    expect(msWorst.ms / msWorst.units, msWorst.path).toBeLessThanOrEqual(MEASURED.activeMsPerUnit);
    expect(routineMs / routineUnits).toBeLessThanOrEqual(MEASURED.activeMsPerUnit);
    // the whole tour fits a sandbox's units with room to spare
    const spent = perUnit.reduce((s, x) => s + x.units, 0);
    console.log(`[budget] the tour spent ${spent} of ${CAPS.unitsPerSandbox} units`);
    expect(spent).toBeLessThan(CAPS.unitsPerSandbox * 0.75);

    // bytes stored by the sandbox's objects after the tour: the workspace and the conversations of every role used
    const ws = await getAgentByName(env.WORKSPACE_AGENT, `sbx-${sandbox.id}`);
    let bytes = await ws.storedBytes();
    const analystBytes = await runInDurableObject(env.ANALYST_AGENT.get(analystId), (_i, state) => state.storage.sql.databaseSize);
    // a visitor may chat as each of the seven principals
    bytes += 7 * analystBytes;
    console.log(`[budget] workspace ${(await ws.storedBytes()) / 1024} KiB, one conversation ${analystBytes / 1024} KiB, sandbox total ${(bytes / 1024).toFixed(0)} KiB`);
    expect(bytes).toBeLessThanOrEqual(MEASURED.bytesPerSandbox);
  });
});
