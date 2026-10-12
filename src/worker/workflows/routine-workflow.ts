// RoutineWorkflow `source_arrival_refresh` (SPEC 4.4, 14.7): ingest, checks, features and score, gate, investigate,
// draft, then wait for the mapping approval and repair: activate the mapping, rescore, re-check, compare with the
// published run, publish under publish.auto@1 when the change is within tolerance, and replay in a fresh warehouse.
// Every step does I/O only (10 ms of CPU per step on Workers Free): it calls the WorkspaceAgent and waits on gates
// (ADR 0016) while the runner does the numeric work. Steps from an older demo epoch become no-ops.
import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { RunBrief } from "../../shared/contracts";
import { DEMO, jobs, TOLERANCE } from "../../shared/routines/definitions";
import type { WorkspaceAgent } from "../agents/workspace-agent";
import { awaitApproval, awaitJob, type GateCtx, stepJson, type WorkspaceRpc } from "./gates";

export interface RoutineParams {
  routine_id: string;
  source: string;
  period: string;
  epoch: number;
}

interface ChecksResult {
  failing: string[];
  warnings: string[];
  results: unknown[];
}

interface ProbeResult {
  path: string[];
  probes: unknown[];
  ranking?: unknown[];
}

interface ProposalResult {
  proposal_id: string;
  from: string;
  to: string;
  diff: unknown;
  evidence: unknown;
}

interface ChangeSummary {
  company: { from: number; to: number };
  organizations: { cohort_id: string; from: number; to: number }[];
}

interface ReplayResult {
  replay_hash: string;
  equal: boolean;
  duration_ms: number;
  detail: unknown;
}

export function withinTolerance(c: ChangeSummary): { ok: boolean; company: number; worstOrg: number } {
  const rel = (from: number, to: number) => (from > 0 ? Math.abs(to - from) / from : 0);
  const company = rel(c.company.from, c.company.to);
  const worstOrg = Math.max(0, ...c.organizations.map((o) => rel(o.from, o.to)));
  return { ok: company <= TOLERANCE.company && worstOrg <= TOLERANCE.organization, company, worstOrg };
}

export class RoutineWorkflow extends AgentWorkflow<WorkspaceAgent, RoutineParams> {
  override async run(event: AgentWorkflowEvent<RoutineParams>, step: AgentWorkflowStep) {
    const p = event.payload;
    const ws = this.agent as unknown as WorkspaceRpc;
    const ctx: GateCtx = { step, ws, instanceId: event.instanceId, routineId: p.routine_id, epoch: p.epoch };
    const live = async (name: string) => {
      const ok = await stepJson(step, `${name}.epoch`, async () => (await ws.epoch()) === p.epoch);
      if (!ok) throw new NonRetryableError(`demo epoch changed; routine ${p.routine_id} stops`);
    };
    const note = (name: string, outcome: string, detail: Record<string, unknown> = {}, status?: string) => stepJson(step, `${name}.log`, async () => ws.routineStep(p.routine_id, name, outcome, detail, status));

    await live("ingest");
    const landed = await awaitJob(ctx, "ingest", jobs.ingest(p.source, p.period));
    await note("ingest", "landed", { result: landed });

    const mapping = await stepJson(step, "mapping.read", async () => ws.activeMapping());
    await live("checks");
    const checks = (await awaitJob(ctx, "checks", jobs.checks(DEMO.candidateVintage, mapping))) as ChecksResult;
    await note("checks", checks.failing.length ? "failed" : "passed", { failing: checks.failing, warnings: checks.warnings });

    await live("features_and_score");
    const runId = await stepJson(step, "run.id", async () => ws.routineRunId(DEMO.cutoff));
    const scored = (await awaitJob(ctx, "score", jobs.score(runId, DEMO.cutoff, DEMO.candidateVintage, mapping))) as { run: RunBrief };
    await stepJson(step, "run.register", async () => ws.registerRun(scored.run, p.routine_id));
    await note("features_and_score", "scored", { run_id: runId });

    if (checks.failing.length === 0) {
      await note("gate", "passed", { run_id: runId });
      await this.compareAndPublish(ctx, runId, note);
      return { routine_id: p.routine_id, held: false };
    }

    const incidentId = await stepJson(step, "gate.hold", async () => ws.holdRun(runId, checks.failing, p.routine_id));
    await note("gate", "held", { run_id: runId, incident_id: incidentId, failing: checks.failing });

    await live("investigate");
    const probe = (await awaitJob(ctx, "investigate", jobs.probe(runId, checks.failing))) as ProbeResult;
    await stepJson(step, "incident.probe", async () => ws.updateIncident(incidentId, { probe, lineage_path: probe.path }));
    await note("investigate", "traced", { path: probe.path });

    await live("draft");
    const proposal = (await awaitJob(ctx, "draft", jobs.proposeMapping(runId))) as ProposalResult;
    await stepJson(step, "mapping.propose", async () => ws.proposeMapping({ ...proposal, source: "payroll", incident_id: incidentId }, p.routine_id));
    await stepJson(step, "incident.proposal", async () => ws.updateIncident(incidentId, { proposal_id: proposal.proposal_id }));
    await note("draft", "mapping proposed", { proposal_id: proposal.proposal_id }, "waiting_for_approval");

    const decision = await awaitApproval(ctx, "publish_or_approve", "mapping", proposal.proposal_id);
    if (decision !== "approved") {
      await note("publish_or_approve", decision, { proposal_id: proposal.proposal_id }, decision === "expired" ? "expired" : "closed");
      return { routine_id: p.routine_id, held: true, decision };
    }
    await note("publish_or_approve", "mapping approved", { proposal_id: proposal.proposal_id }, "running");

    // Repair: rebuild with the approved mapping, re-check, compare, publish, replay.
    await live("repair");
    const repairedId = await stepJson(step, "repair.id", async () => ws.routineRunId(DEMO.cutoff));
    const repaired = (await awaitJob(ctx, "repair.score", jobs.score(repairedId, DEMO.cutoff, DEMO.candidateVintage, proposal.to))) as { run: RunBrief };
    await stepJson(step, "repair.register", async () => ws.registerRun(repaired.run, p.routine_id));
    const rechecks = (await awaitJob(ctx, "repair.checks", jobs.checks(DEMO.candidateVintage, proposal.to))) as ChecksResult;
    await note("repair", rechecks.failing.length ? "checks failed" : "checks passed", { run_id: repairedId, failing: rechecks.failing });
    if (rechecks.failing.length) {
      await stepJson(step, "repair.hold", async () => ws.holdRun(repairedId, rechecks.failing, p.routine_id));
      return { routine_id: p.routine_id, held: true };
    }
    await stepJson(step, "incident.resolve", async () => ws.updateIncident(incidentId, { resolved_by_run: repairedId }));
    await this.compareAndPublish(ctx, repairedId, note);
    await note("memory_note", "skipped", { note: "git memory arrives in M6" }, "done");
    return { routine_id: p.routine_id, held: false, published: repairedId };
  }

  private async compareAndPublish(ctx: GateCtx, runId: string, note: (n: string, o: string, d?: Record<string, unknown>, s?: string) => Promise<void>): Promise<void> {
    const { step, ws } = ctx;
    const published = await stepJson(step, "published.read", async () => ws.publishedRunId());
    const change = (await awaitJob(ctx, "what_changed", jobs.whatChanged(published ?? DEMO.previousPublished, runId))) as ChangeSummary;
    const tol = withinTolerance(change);
    await note("what_changed", tol.ok ? "within tolerance" : "beyond tolerance", { company_change: Math.round(tol.company * 1000) / 1000, worst_org_change: Math.round(tol.worstOrg * 1000) / 1000 });
    if (tol.ok) {
      await stepJson(step, "publish", async () => ws.publishRun(runId, "routine", "routine", TOLERANCE.policy, ctx.routineId));
      await note("publish_or_approve", "published", { run_id: runId, policy: TOLERANCE.policy });
    } else {
      await note("publish_or_approve", "waiting for publish approval", { run_id: runId }, "waiting_for_approval");
      return;
    }
    const replay = (await awaitJob(ctx, "replay", jobs.replay(runId))) as ReplayResult;
    await stepJson(step, "replay.record", async () => ws.recordReplay(runId, replay));
    await note("replay", replay.equal ? "identical business result" : "MISMATCH", { run_id: runId, replay_hash: replay.replay_hash });
  }
}
