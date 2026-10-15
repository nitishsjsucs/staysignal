// ADR 0018: every visitor's mutable state lives in that visitor's sandbox. Two visitors act in the same roles; neither
// can see or change the other's reviews, approvals, audit entries, memory writes, traces, results, routine or held
// run, and the shared "larkspur" workspace is never touched.
import { env } from "cloudflare:workers";
import { listDurableObjectIds } from "cloudflare:test";
import { getAgentByName } from "agents";
import { beforeAll, describe, expect, it } from "vitest";
import { actAs, demoJson, P, resetGate, type Visitor, visit } from "../helpers/demo";
import type { AnalystAgent } from "../../src/worker/agents/analyst-agent";
import { analystName } from "../../src/worker/auth/principal";
import { parseConfig } from "../../src/worker/config";
import type { TurnOutput } from "../../src/worker/agents/turn";

/** The RPC stub types a TurnOutput as never; the value is a plain object. */
const turnOf = async (agent: { turn: (...a: never[]) => unknown }, ...args: unknown[]): Promise<TurnOutput> => (await (agent.turn as (...a: unknown[]) => Promise<unknown>)(...args)) as TurnOutput;
import { localPrincipal } from "../../src/shared/policy/roles";

type Outcome = { ok: boolean; code?: string; value?: Record<string, unknown> };
type Audit = { actions: { seq: number; kind: string; reason: string | null }[]; approvals: { decision: string; refusal_code: string | null }[] };
type Me = { principal: { sandbox: { id: string; exp: number } } };

async function until(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

let a: Visitor;
let b: Visitor;
let reviewA = "";
let rollbackReason = "";

beforeAll(async () => {
  await resetGate();
  a = await visit(P.lead);
  b = await visit(P.lead);
  // A: a review, a refused self-approval, a second lead's approval (a memory write), a rollback with a reason
  const d = await demoJson<{ data: { draft_id: string } }>("/api/reviews/draft", { cookie: a.cookie, body: { cohort: "Platform Engineering", horizon: 3 } });
  const s = await demoJson<Outcome>(`/api/reviews/${d.data.draft_id}/submit`, { cookie: a.cookie, body: {} });
  reviewA = String(s.value?.review_id);
  expect((await demoJson<Outcome>(`/api/approvals/${reviewA}/approve`, { cookie: a.cookie, body: { reason: "mine" } })).code).toBe("SELF_APPROVAL");
  const director = await actAs(a, P.director);
  const ok = await demoJson<Outcome>(`/api/approvals/${reviewA}/approve`, { cookie: director.cookie, body: { reason: "approved in A" } });
  expect(ok.ok).toBe(true);
  rollbackReason = "rolled back in sandbox A";
  expect((await demoJson<Outcome>(`/api/actions/${Number(ok.value?.action_seq)}/rollback`, { cookie: director.cookie, body: { reason: rollbackReason } })).ok).toBe(true);
});

describe("two sandboxes", () => {
  it("are different sandboxes for the same role", async () => {
    const ma = await demoJson<Me>("/api/me", { cookie: a.cookie });
    const mb = await demoJson<Me>("/api/me", { cookie: b.cookie });
    expect(ma.principal.sandbox.id).not.toBe(mb.principal.sandbox.id);
  });

  it("do not share reviews or approvals", async () => {
    const ra = await demoJson<{ reviews: { review_id: string; state: string }[] }>("/api/reviews", { cookie: a.cookie });
    expect(ra.reviews.map((r) => [r.review_id, r.state])).toEqual([[reviewA, "rolled_back"]]);
    expect((await demoJson<{ reviews: unknown[] }>("/api/reviews", { cookie: b.cookie })).reviews).toEqual([]);
    expect((await demoJson<{ approvals: unknown[] }>("/api/approvals", { cookie: b.cookie })).approvals).toEqual([]);
    // B cannot approve or roll back A's subjects: they do not exist in B's sandbox
    const bd = await actAs(b, P.director);
    expect((await demoJson<Outcome>(`/api/approvals/${reviewA}/approve`, { cookie: bd.cookie, body: {} })).code).toBe("NOT_FOUND");
    const aAudit = await demoJson<Audit>("/api/audit", { cookie: a.cookie });
    const approveSeq = aAudit.actions.find((x) => x.kind === "review.approve")!.seq;
    expect((await demoJson<Outcome>(`/api/actions/${approveSeq}/rollback`, { cookie: bd.cookie, body: { reason: "from B" } })).ok).toBe(false);
  });

  it("do not share audit entries, and both chains verify", async () => {
    const aa = await demoJson<Audit>("/api/audit", { cookie: a.cookie });
    const ab = await demoJson<Audit>("/api/audit", { cookie: b.cookie });
    expect(aa.actions.map((x) => x.kind)).toEqual(expect.arrayContaining(["review.submit", "approval.refused", "review.approve", "rollback"]));
    expect(aa.actions.some((x) => x.reason === rollbackReason)).toBe(true);
    expect(aa.approvals.map((x) => x.refusal_code)).toContain("SELF_APPROVAL");
    // B's chain is only its seed (genesis and the first publication) plus B's refused rollback attempt above
    expect(ab.actions.map((x) => x.kind).filter((k) => k !== "genesis" && k !== "run.publish")).toEqual([]);
    expect(ab.actions.some((x) => x.reason === rollbackReason)).toBe(false);
    expect(ab.approvals).toEqual([]);
    expect((await demoJson<{ ok: boolean }>("/api/audit/verify", { cookie: a.cookie })).ok).toBe(true);
    expect((await demoJson<{ ok: boolean }>("/api/audit/verify", { cookie: b.cookie })).ok).toBe(true);
  });

  it("do not share memory writes", async () => {
    const aa = await actAs(a, P.analyst);
    const ba = await actAs(b, P.analyst);
    const la = await demoJson<{ commits: { message: string }[] }>("/api/memory/log", { cookie: aa.cookie });
    const lb = await demoJson<{ commits: { message: string }[] }>("/api/memory/log", { cookie: ba.cookie });
    expect(la.commits.map((c) => c.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^memory: decision DEC-/)]));
    expect(lb.commits.some((c) => /^memory: (decision|timeline)/.test(c.message))).toBe(false);
    const files = await demoJson<{ files: { path: string }[] }>("/api/memory/files", { cookie: aa.cookie });
    const fb = await demoJson<{ files: { path: string }[] }>("/api/memory/files", { cookie: ba.cookie });
    expect(files.files.length).toBeGreaterThan(fb.files.length);
  });

  it("do not share results or traces", async () => {
    // a result A computed is not stored in B until B computes it
    const ra = await demoJson<{ result_id: string }>("/api/profile?cohort=Platform%20Engineering", { cookie: a.cookie });
    expect((await (await import("../helpers/demo")).demoCall(`/api/results/${ra.result_id}`, { cookie: b.cookie })).status).toBe(404);
    // a chat turn in A leaves a trace in A only
    const cfg = parseConfig(env);
    const pa = { ...localPrincipal(P.lead)!, sandbox: (await demoJson<Me>("/api/me", { cookie: a.cookie })).principal.sandbox };
    const agent = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(cfg, pa));
    const turn = await turnOf(agent, pa, "Forecast voluntary departures in Engineering over the next 90 days.");
    expect(turn.recorded).toBe(true);
    const ta = await demoJson<{ traces: unknown[] }>("/api/traces", { cookie: a.cookie });
    const tb = await demoJson<{ traces: unknown[] }>("/api/traces", { cookie: b.cookie });
    expect(ta.traces.length).toBe(1);
    expect(tb.traces).toEqual([]);
    // the same role in another sandbox is another conversation
    const pb = { ...pa, sandbox: (await demoJson<Me>("/api/me", { cookie: b.cookie })).principal.sandbox };
    expect(await analystName(cfg, pb)).not.toBe(await analystName(cfg, pa));
  });

  it("do not share the payroll simulation, its held run or its routine", async () => {
    const an = await actAs(a, P.analyst);
    const started = await demoJson<{ routine_id: string; workflow_instance_id: string }>("/api/demo/arrival", { cookie: an.cookie, body: {} });
    expect(started.workflow_instance_id).toMatch(/^routine-sbx-[a-z2-7]{20}-RTN-0001-e1$/);
    await until(async () => (await demoJson<{ runs: { run_id: string; status: string }[] }>("/api/runs", { cookie: an.cookie })).runs.some((r) => r.run_id === "R-2026-10-01#2" && r.status === "held"));
    const runsB = await demoJson<{ runs: { run_id: string }[] }>("/api/runs", { cookie: b.cookie });
    expect(runsB.runs.map((r) => r.run_id)).not.toContain("R-2026-10-01#2");
    expect((await demoJson<{ routines: unknown[] }>("/api/routines", { cookie: b.cookie })).routines).toEqual([]);
    expect((await demoJson<{ incidents: unknown[] }>("/api/quality/checks", { cookie: b.cookie })).incidents).toEqual([]);
    // one routine per sandbox
    const again = await demoJson<{ refused?: boolean; code?: string }>("/api/demo/arrival", { cookie: an.cookie, body: {} });
    expect(again).toMatchObject({ refused: true, code: "ROUTINE_LIMIT" });
  });

  it("never touch the shared workspace", async () => {
    const ids = await listDurableObjectIds(env.WORKSPACE_AGENT);
    const shared = env.WORKSPACE_AGENT.idFromName("larkspur");
    expect(ids.some((id) => id.equals(shared))).toBe(false);
  });
});
