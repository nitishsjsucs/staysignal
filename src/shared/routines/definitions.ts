// Routine and engine-job definitions shared by the Worker, the fixture runner and (by the same canonical JSON) the
// engine (SPEC 14.7). Job keys are SHA-256 of the canonical {kind, params}, so the same job always has the same key
// and completing it twice is a no-op (ADR 0017).
import { canonicalJson } from "../canonical-json";

export type JobKind = "ingest_source" | "run_checks" | "score_forecast" | "rca_probe" | "propose_mapping" | "what_changed" | "replay";

export interface JobSpec {
  kind: JobKind;
  params: Record<string, unknown>;
}

export function jobKeyInput(spec: JobSpec): string {
  return canonicalJson({ kind: spec.kind, params: spec.params });
}

/** The demo routine's inputs (SPEC 3 beat 3, 6.1): the held-back September 2026 payroll lands on the demo clock and
 * the candidate run is scored five minutes later. */
export const DEMO = {
  arrival: { source: "payroll", period: "2026-09" },
  arrivedAt: "2026-10-05T14:00:00Z",
  candidateVintage: "2026-10-05T14:05:00Z",
  cutoff: "2026-10-01",
  model: "m2026.09",
  metricDef: "voluntary_departures@2",
  previousPublished: "R-2026-09-01#1",
} as const;

export const TOLERANCE = { company: 0.15, organization: 0.25, policy: "publish.auto@1" } as const;

export function runIdFor(cutoff: string, version: number): string {
  return `R-${cutoff}#${version}`;
}

export const ROUTINE_STEPS = ["ingest", "checks", "features_and_score", "gate", "what_changed", "investigate", "draft", "publish_or_approve", "memory_note"] as const;
export type RoutineStep = (typeof ROUTINE_STEPS)[number];

export const jobs = {
  ingest: (source: string, period: string): JobSpec => ({ kind: "ingest_source", params: { source, period } }),
  checks: (vintage: string, mapping: string): JobSpec => ({ kind: "run_checks", params: { vintage, mapping } }),
  score: (runId: string, cutoff: string, vintage: string, mapping: string): JobSpec => ({
    kind: "score_forecast",
    params: { run_id: runId, cutoff, vintage, model: DEMO.model, metric_def: DEMO.metricDef, mapping },
  }),
  probe: (runId: string, failing: string[]): JobSpec => ({ kind: "rca_probe", params: { run_id: runId, failing: [...failing].sort() } }),
  proposeMapping: (runId: string): JobSpec => ({ kind: "propose_mapping", params: { source: "payroll", active: "payroll@1", evidence_run: runId } }),
  whatChanged: (fromRun: string, toRun: string): JobSpec => ({ kind: "what_changed", params: { from_run: fromRun, to_run: toRun } }),
  replay: (runId: string): JobSpec => ({ kind: "replay", params: { run_id: runId } }),
};
