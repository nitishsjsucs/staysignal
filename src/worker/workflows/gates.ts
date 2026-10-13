// Workflow gates (ADR 0016; pattern copied from onboardflow src/worker/workflows/gates.ts and ADR 0002, MIT, with D1
// replaced by Durable Object SQLite). The truth lives in the WorkspaceAgent's SQLite and is checked in a step before
// every wait; waitForEvent is only a wake-up with a valid type and a bounded timeout, followed by a re-check. A timeout
// throws, so it is caught and recorded in a following step. waitForApproval and approveWorkflow are not used.
import type { AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { MemoryNoteInput, MemoryWriteOutcome, RunBrief } from "../../shared/contracts";
import type { JobSpec } from "../../shared/routines/definitions";

/** The WorkspaceAgent methods a workflow calls over RPC (every call is I/O; the CPU stays in the agent). */
export interface WorkspaceRpc {
  epoch(): Promise<number>;
  enqueueJob(spec: JobSpec, workflowInstanceId: string | null): Promise<{ job_key: string; status: string; result: unknown }>;
  getJob(key: string): Promise<{ status: string; result: unknown } | null>;
  getApproval(subjectId: string): Promise<{ status: string } | null>;
  routineStep(routineId: string, step: string, outcome: string, detail?: Record<string, unknown>, status?: string): Promise<void>;
  activeMapping(): Promise<string>;
  routineRunId(cutoff: string): Promise<string>;
  registerRun(brief: RunBrief, routineId: string | null): Promise<void>;
  holdRun(runId: string, failing: string[], routineId: string | null): Promise<string>;
  updateIncident(incidentId: string, patch: Record<string, unknown>): Promise<void>;
  proposeMapping(p: { proposal_id: string; source: string; from: string; to: string; diff: unknown; evidence: unknown; incident_id: string }, routineId: string | null): Promise<void>;
  publishedRunId(): Promise<string | null>;
  publishRun(runId: string, actor: string, actorKind: "human" | "routine", policy: string, routineId: string | null): Promise<number>;
  recordReplay(runId: string, r: { replay_hash: string; equal: boolean; duration_ms: number; detail: unknown }): Promise<void>;
  memoryNote(note: MemoryNoteInput): Promise<MemoryWriteOutcome>;
}

export interface GateCtx {
  step: AgentWorkflowStep;
  ws: WorkspaceRpc;
  instanceId: string;
  routineId: string;
  epoch: number;
}

/** step.do with a JSON-serialized result, so any plain value crosses the step boundary with its type. */
export async function stepJson<T>(step: AgentWorkflowStep, name: string, fn: () => Promise<T> | T): Promise<T> {
  const s = await step.do(name, async () => JSON.stringify((await fn()) ?? null));
  return JSON.parse(s) as T;
}

export const JOB_TIMEOUT = "15 minutes";
export const APPROVAL_TIMEOUT = "7 days";
const MAX_WAITS = 8;

/** Event types allow letters, digits, "-" and "_" only, at most 100 characters. */
export function validEventType(t: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9\-_]*$/.test(t) && t.length <= 100;
}

export async function awaitJob(ctx: GateCtx, label: string, spec: JobSpec): Promise<unknown> {
  const { step, ws } = ctx;
  const first = await stepJson(step, `${label}.enqueue`, async () => ws.enqueueJob(spec, ctx.instanceId));
  if (first.status === "done") return first.result;
  const type = `job_${first.job_key}`;
  if (!validEventType(type)) throw new NonRetryableError(`invalid event type ${type}`);
  for (let k = 1; k <= MAX_WAITS; k++) {
    let timedOut = false;
    try {
      await step.waitForEvent(`${label}.wait.${k}`, { type, timeout: JOB_TIMEOUT });
    } catch {
      timedOut = true;
    }
    const row = await stepJson(step, `${label}.check.${k}`, async () => ws.getJob(first.job_key));
    if (row?.status === "done") return row.result;
    if (row?.status === "failed") {
      await stepJson(step, `${label}.failed`, async () => ws.routineStep(ctx.routineId, label, "job failed", { job_key: first.job_key }, "failed"));
      throw new NonRetryableError(`engine job ${spec.kind} failed`);
    }
    if (timedOut) {
      await stepJson(step, `${label}.stalled`, async () => ws.routineStep(ctx.routineId, label, "stalled", { job_key: first.job_key, left_for_a_person: "start the runner (npm run dev or npm run runner:prod)" }, "stalled"));
      throw new NonRetryableError(`engine job ${spec.kind} stalled`);
    }
  }
  throw new NonRetryableError(`engine job ${spec.kind} did not complete after ${MAX_WAITS} wake-ups`);
}

export async function awaitApproval(ctx: GateCtx, label: string, kind: "mapping" | "publish" | "review", subjectId: string): Promise<"approved" | "rejected" | "expired"> {
  const { step, ws } = ctx;
  const type = `approve_${kind}_${subjectId}`;
  if (!validEventType(type)) throw new NonRetryableError(`invalid event type ${type}`);
  for (let k = 1; k <= MAX_WAITS; k++) {
    const status = await stepJson(step, `${label}.approval.check.${k}`, async () => {
      const a = await ws.getApproval(subjectId);
      return a?.status ?? "missing";
    });
    if (status === "approved" || status === "rejected") return status;
    if (status === "missing") throw new NonRetryableError(`approval subject ${subjectId} missing`);
    try {
      await step.waitForEvent(`${label}.approval.wait.${k}`, { type, timeout: APPROVAL_TIMEOUT });
    } catch {
      await stepJson(step, `${label}.approval.expired`, async () => ws.routineStep(ctx.routineId, label, "approval expired", { subject_id: subjectId }, "expired"));
      return "expired";
    }
  }
  return "expired";
}
