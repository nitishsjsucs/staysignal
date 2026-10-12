// C22 to C25: separation of duties, tasks with owners and evidence, rollback with a reason, the hash chain and anchors.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { agentPrincipal } from "../../src/shared/policy/roles";
import type { WorkspaceAgent } from "../../src/worker/agents/workspace-agent";
import { json, P } from "../helpers/api";

type Outcome = { ok: boolean; code?: string; value?: Record<string, unknown> };

async function draftAndSubmit(as: string): Promise<string> {
  const d = await json<{ data: { draft_id: string; checks: unknown[]; blocking_items: string[] } }>("/api/reviews/draft", { as, body: { cohort: "Platform Engineering", horizon: 3 } });
  expect(d.data.checks).toHaveLength(3);
  const s = await json<Outcome>(`/api/reviews/${d.data.draft_id}/submit`, { as, body: {} });
  expect(s.ok).toBe(true);
  return String(s.value?.review_id);
}

describe("approvals", () => {
  it("refuses self-approval, wrong role and agents; a second lead approves and tasks are created", async () => {
    const reviewId = await draftAndSubmit(P.lead);
    expect((await json<Outcome>(`/api/approvals/${reviewId}/approve`, { as: P.lead, body: { reason: "looks right" } })).code).toBe("SELF_APPROVAL");
    expect((await json<Outcome>(`/api/approvals/${reviewId}/approve`, { as: P.dataEng, body: {} })).code).toBe("WRONG_ROLE");
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "larkspur");
    expect((await ws.approve(agentPrincipal(), reviewId, null)).ok).toBe(false);
    const ok = await json<Outcome>(`/api/approvals/${reviewId}/approve`, { as: P.director, body: { reason: "approved" } });
    expect(ok.ok).toBe(true);
    expect((ok.value?.task_ids as string[]).length).toBe(3);
    const reviews = await json<{ reviews: { review_id: string; state: string; tasks: { category: string; blocking_items_json: string; owner_role: string }[] }[] }>("/api/reviews", { as: P.lead });
    const r = reviews.reviews.find((x) => x.review_id === reviewId)!;
    expect(r.state).toBe("approved");
    const comp = r.tasks.find((t) => t.category === "compensation")!;
    expect(JSON.parse(comp.blocking_items_json)[0]).toMatch(/pay-equity/i);
    expect(comp.owner_role).toMatch(/hrbp-engineering/);
    const audit = await json<{ approvals: { decision: string; refusal_code: string | null }[] }>("/api/audit", { as: P.lead });
    const codes = audit.approvals.map((a) => a.refusal_code).filter(Boolean);
    expect(codes).toEqual(expect.arrayContaining(["SELF_APPROVAL", "WRONG_ROLE", "AGENT_PRINCIPAL"]));
  });

  it("rolls back with a reason, cancels tasks, and the chain still verifies", async () => {
    const reviewId = await draftAndSubmit(P.lead);
    const ok = await json<Outcome>(`/api/approvals/${reviewId}/approve`, { as: P.director, body: {} });
    const seq = Number(ok.value?.action_seq);
    expect((await json<Outcome>(`/api/actions/${seq}/rollback`, { as: P.lead, body: {} })).code).toBe("REASON_REQUIRED");
    expect((await json<Outcome>(`/api/actions/${seq}/rollback`, { as: P.analyst, body: { reason: "x" } })).code).toBe("WRONG_ROLE");
    const rb = await json<Outcome>(`/api/actions/${seq}/rollback`, { as: P.lead, body: { reason: "approved against the wrong cohort" } });
    expect(rb.ok).toBe(true);
    const reviews = await json<{ reviews: { review_id: string; state: string; tasks: { status: string }[] }[] }>("/api/reviews", { as: P.lead });
    const r = reviews.reviews.find((x) => x.review_id === reviewId)!;
    expect(r.state).toBe("rolled_back");
    expect(r.tasks.every((t) => t.status === "cancelled")).toBe(true);
    const detail = await json<{ transitions: { to: string }[] }>(`/api/reviews/${reviewId}`, { as: P.lead });
    expect(detail.transitions.map((t) => t.to)).toEqual(["submitted", "approved", "task", "rolled_back"]);
    expect((await json<{ ok: boolean }>("/api/audit/verify", { as: P.auditor })).ok).toBe(true);
  });

  it("rolls back a publish by moving the pointer, never deleting", async () => {
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "larkspur");
    const before = await ws.publishedRunId();
    const seq = await ws.publishRun("R-2026-09-01#1", P.lead, "human", "publish:approve", null);
    expect(await ws.publishedRunId()).toBe("R-2026-09-01#1");
    const rb = await json<Outcome>(`/api/actions/${seq}/rollback`, { as: P.lead, body: { reason: "restore the current run" } });
    expect(rb.ok).toBe(true);
    expect(await ws.publishedRunId()).toBe(before);
    const runs = await json<{ runs: { run_id: string }[] }>("/api/runs", { as: P.lead });
    expect(runs.runs.map((r) => r.run_id)).toEqual(expect.arrayContaining(["R-2026-09-01#1", "R-2026-10-01#1"]));
  });
});

describe("audit chain (C25)", () => {
  it("detects an edited row, and an anchor detects a rewritten chain", async () => {
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "larkspur");
    expect((await ws.verifyAudit()).ok).toBe(true);
    await ws.anchor("2026-10-05", "test");
    await runInDurableObject(ws as unknown as DurableObjectStub<WorkspaceAgent>, async (agent: WorkspaceAgent) => {
      agent.sql`UPDATE action_log SET reason = 'tampered' WHERE seq = 2`;
    });
    const edited = await ws.verifyAudit();
    expect(edited.ok).toBe(false);
    expect(edited.action_log.firstBad).toBe(2);
    // rewrite the whole chain consistently: per-row verification passes, the anchor does not
    await runInDurableObject(ws as unknown as DurableObjectStub<WorkspaceAgent>, async (agent: WorkspaceAgent) => {
      const { chainHash } = await import("../../src/worker/store/chain");
      const rows = agent.sql<Record<string, string | number | null>>`SELECT * FROM action_log ORDER BY seq`;
      let prev = "0".repeat(64);
      for (const row of rows) {
        const next = { ...row, prev_hash: prev };
        const hash = chainHash(prev, next);
        agent.sql`UPDATE action_log SET prev_hash = ${prev}, hash = ${hash} WHERE seq = ${Number(row.seq)}`;
        prev = hash;
      }
    });
    const rewritten = await ws.verifyAudit();
    expect(rewritten.action_log.ok).toBe(true);
    expect(rewritten.anchor?.matches).toBe(false);
    expect(rewritten.ok).toBe(false);
  });
});
