// Data health (SPEC 13, beats 3 and 4): the check heatmap, the open incident with the failing lineage path and the
// root-cause ranking, the deterministic mapping diff with its evidence and the data engineer's approval, the routine's
// progress, and the replay record of the repaired run.
import { useState } from "react";
import type { CheckResult } from "../../shared/contracts";
import { hasScope, invalidate, type Me, postJSON, useQuery } from "../api";
import { CheckHeatmap } from "../charts/CheckHeatmap";
import { ChartCard } from "../components/ChartCard";
import { ApproveReject } from "../components/Actions";
import { IconAlert, IconCheck, IconPlay } from "../components/icons";
import { StatusPill, SyntheticChip } from "../components/ui";
import { useWorkspace } from "../live";
import { PageHead } from "./Forecast";

interface QualityResp {
  checks: { check_id: string; name: string; severity: "error" | "warn"; node: string; phase: number }[];
  results: CheckResult[];
  incidents: Incident[];
}

interface Incident {
  incident_id: string;
  run_id: string;
  status: string;
  created_at: string;
  failing: string[];
  probe?: { probes: { entity: string; pay_basis_code: string; median_ratio: number; n: number; anomaly: number }[]; ranking: { node: string; score: number; parts: Record<string, number> }[]; path: string[] };
  proposal_id?: string;
  resolved_by_run?: string;
}

interface Mapping {
  active: string;
  proposals: { subject_id: string; status: string; proposer: string; payload: { from: string; to: string; diff: { added: Record<string, { multiplier: number; meaning: string }>; unknown_codes: { from: string; to: string } }; evidence: { entity: string; code: string; median_ratio_under_active_mapping: number; n: number; dictionary: string }[]; title: string } }[];
}

interface Replays {
  replays: { replay_hash: string; equal: boolean; duration_ms: number; created_at: string; warehouse?: string; negative_check?: { hash_differs: boolean } }[];
}

const NODE_LABEL: Record<string, string> = {
  stg_payroll__lines: "stg_payroll__lines.pay_basis_code",
  stg_map__pay_basis: "stg_map__pay_basis (active mapping)",
  int_comp__annualized: "int_comp__annualized.annual_base",
  fct_comp_position: "fct_comp_position.compa_ratio",
  feature_snapshot: "feature snapshot: comp_below_mid",
  forecast_run: "candidate forecast run",
};

export function QualityPage({ me }: { me: Me }) {
  const live = useWorkspace();
  const q = useQuery<QualityResp>("/api/quality/checks");
  const mapping = useQuery<Mapping>(hasScope(me, "quality:read") ? "/api/mappings/payroll" : null);
  const published = live?.published?.runId ?? null;
  const replays = useQuery<Replays>(published ? `/api/runs/${encodeURIComponent(published)}/replays` : null);
  const [busy, setBusy] = useState(false);
  const incidents = q.data?.incidents ?? [];
  const open = incidents.filter((i) => i.status === "open" && !i.resolved_by_run);
  const latest = incidents[incidents.length - 1];
  const routine = live?.routineRuns[0];
  const proposal = mapping.data?.proposals.find((p) => p.subject_id === latest?.proposal_id) ?? mapping.data?.proposals[mapping.data.proposals.length - 1];
  const arrive = async () => {
    setBusy(true);
    try {
      await postJSON("/api/demo/arrival", {});
      invalidate();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHead
        title="Data health"
        sub="Checks run on every source arrival and before every forecast. A run whose upstream checks fail is held; nothing reaches a People Partner until it is repaired."
        actions={
          hasScope(me, "forecast:read:all") || hasScope(me, "quality:read") ? (
            <button type="button" className="btn btn-primary" onClick={() => void arrive()} disabled={busy || Boolean(routine && routine.status === "running")} data-testid="simulate-arrival">
              <IconPlay size={14} /> Simulate payroll arrival (synthetic)
            </button>
          ) : null
        }
      />
      {open.length ? (
        <div className="banner critical" role="status" data-testid="held-banner">
          <IconAlert size={16} />
          <div>
            <div className="banner-title">
              Held for review: {open[0]!.run_id} ({open[0]!.incident_id})
            </div>
            <div className="banner-body">Checks {open[0]!.failing.join(", ")} failed upstream of the forecast features. The published forecast did not move.</div>
          </div>
        </div>
      ) : latest?.resolved_by_run ? (
        <div className="banner good" role="status" data-testid="repaired-banner">
          <IconCheck size={16} />
          <div>
            <div className="banner-title">
              Repaired: {latest.resolved_by_run} replaced the held {latest.run_id}
            </div>
            <div className="banner-body">The mapping change was approved, affected models rebuilt, checks passed and the change was within tolerance, so the routine published it under publish.auto@1.</div>
          </div>
        </div>
      ) : null}
      {routine ? (
        <section className="card" aria-label="Routine" data-testid="routine">
          <div className="card-head">
            <div>
              <h2 className="card-title">What did the routine do, and what is waiting for a person?</h2>
              <div className="card-sub">
                {routine.routineId} · source_arrival_refresh · {routine.status.replace(/_/g, " ")}
              </div>
            </div>
            <SyntheticChip label="Simulated arrival" />
          </div>
          <RoutineSteps routineId={routine.routineId} />
        </section>
      ) : null}
      <div className="grid">
        <ChartCard
          id="heatmap"
          className="span-12"
          title="Which checks failed, when, and on which source?"
          subtitle="Phase-1 checks at the daily 06:00 batch on the synthetic clock, plus every routine run"
          loading={q.loading && !q.data}
          error={q.error}
          table={
            q.data ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Check</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th className="num">Failing rows</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.results
                    .filter((r) => r.status !== "pass")
                    .map((r) => (
                      <tr key={`${r.check_id}${r.date}`}>
                        <td>{r.check_id}</td>
                        <td>{r.date}</td>
                        <td>{r.status}</td>
                        <td className="num">{r.failing_rows}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : undefined
          }
        >
          {q.data ? <CheckHeatmap checks={q.data.checks} results={q.data.results} /> : null}
        </ChartCard>
        {latest?.probe ? (
          <>
            <section className="card span-6" aria-label="Lineage" data-testid="lineage">
              <div className="card-head">
                <div>
                  <h2 className="card-title">Where did the bad value come from and what did it touch?</h2>
                  <div className="card-sub">Column lineage from the vendor file to the held run (failing path highlighted)</div>
                </div>
              </div>
              <div className="flow">
                {latest.probe.path.map((n, i) => (
                  <div key={n}>
                    <div className="flow-node on-path">
                      <StatusPill status={i === 0 ? "critical" : "serious"}>{i === 0 ? "origin" : "affected"}</StatusPill>
                      <span className="mono">{NODE_LABEL[n] ?? n}</span>
                    </div>
                    {i < latest.probe!.path.length - 1 ? <div className="flow-arrow">flows into</div> : null}
                  </div>
                ))}
              </div>
            </section>
            <section className="card span-6" aria-label="Root cause" data-testid="ranking">
              <div className="card-head">
                <div>
                  <h2 className="card-title">Which node most likely caused the failures?</h2>
                  <div className="card-sub">Root-cause ranking: coverage of the failing checks, the node's own probe anomaly, and whether it changed</div>
                </div>
              </div>
              <RankingBars ranking={latest.probe.ranking.slice(0, 5)} />
              <div style={{ marginTop: 12 }}>
                <div className="label-sm" style={{ marginBottom: 4 }}>
                  Probe: annualized pay to band midpoint, by entity and pay-basis code
                </div>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th>Code</th>
                      <th className="num">Lines</th>
                      <th className="num">Median ratio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latest.probe.probes.map((p) => (
                      <tr key={`${p.entity}${p.pay_basis_code}`}>
                        <td>{p.entity}</td>
                        <td>{p.pay_basis_code}</td>
                        <td className="num">{p.n}</td>
                        <td className="num" style={p.anomaly >= 0.9 ? { color: "var(--critical-ink)", fontWeight: 600 } : undefined}>
                          {p.median_ratio.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
        {proposal ? (
          <section className="card span-7" aria-label="Mapping change" data-testid="mapping">
            <div className="card-head">
              <div>
                <h2 className="card-title">What exactly is being changed, and why?</h2>
                <div className="card-sub">
                  {proposal.payload.title} · proposer of record: the StaySignal agent (generated deterministically from evidence; ADR 0006 single-approver exception)
                </div>
              </div>
              <StatusPill status={proposal.status === "approved" ? "good" : proposal.status === "pending" ? "warning" : "info"}>{proposal.status}</StatusPill>
            </div>
            <div className="diff">
              <div>source: payroll</div>
              <div className="del">- version: {proposal.payload.from}</div>
              <div className="add">+ version: {proposal.payload.to}</div>
              <div>  codes:</div>
              <div>    M: x12 (monthly amount)</div>
              {Object.entries(proposal.payload.diff.added).map(([code, v]) => (
                <div key={code} className="add">
                  +   {code}: x{v.multiplier} ({v.meaning})
                </div>
              ))}
              <div className="del">- unknown_codes: {proposal.payload.diff.unknown_codes.from}</div>
              <div className="add">+ unknown_codes: {proposal.payload.diff.unknown_codes.to}</div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--ink-2)" }}>
              {proposal.payload.evidence.map((e) => (
                <p key={e.entity}>
                  Evidence: the vendor dictionary defines {e.code} as "{e.dictionary}"; under the active mapping {e.entity}'s {e.n} lines sit at a median {e.median_ratio_under_active_mapping.toFixed(1)} times their band midpoints.
                </p>
              ))}
            </div>
            {proposal.status === "pending" ? (
              <div style={{ marginTop: 12 }}>
                {hasScope(me, "mapping:approve") ? <ApproveReject subjectId={proposal.subject_id} testid="mapping-approve" /> : <p style={{ fontSize: 12, color: "var(--ink-3)" }}>Waiting for a data engineer (mapping:approve).</p>}
              </div>
            ) : null}
          </section>
        ) : null}
        {replays.data?.replays.length ? (
          <section className="card span-5" aria-label="Replay" data-testid="replay">
            <div className="card-head">
              <div>
                <h2 className="card-title">Does replay reproduce the published number?</h2>
                <div className="card-sub">Rebuilt from the content-addressed landed files in a fresh state; never moves the published pointer</div>
              </div>
            </div>
            {replays.data.replays.map((r) => (
              <dl key={r.created_at} className="kv">
                <dt>Run</dt>
                <dd>{published}</dd>
                <dt>Result</dt>
                <dd>{r.equal ? <StatusPill status="good">Identical business-result hash</StatusPill> : <StatusPill status="critical">Hash differs</StatusPill>}</dd>
                <dt>Replay hash</dt>
                <dd className="mono">{r.replay_hash.slice(0, 24)}</dd>
                <dt>Duration</dt>
                <dd>{(r.duration_ms / 1000).toFixed(1)} s</dd>
                <dt>Negative check</dt>
                <dd>{r.negative_check?.hash_differs ? "Forced to payroll@1, the hash differs (as it must)" : "not recorded"}</dd>
              </dl>
            ))}
          </section>
        ) : null}
      </div>
    </>
  );
}

function RankingBars({ ranking }: { ranking: { node: string; score: number; parts: Record<string, number> }[] }) {
  const max = Math.max(...ranking.map((r) => r.score), 0.01);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {ranking.map((r, i) => (
        <div key={r.node} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 160px 44px", gap: 8, alignItems: "center", fontSize: 12 }}>
          <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.node}>
            {i + 1}. {r.node}
          </span>
          <span style={{ background: "var(--surface-sunk)", borderRadius: 3, height: 10, display: "block" }}>
            <span style={{ display: "block", height: 10, width: `${(r.score / max) * 100}%`, background: i === 0 ? "var(--series-vol)" : "var(--seq-2)", borderRadius: 3 }} />
          </span>
          <span className="num" style={{ textAlign: "right" }}>
            {r.score.toFixed(2)}
          </span>
        </div>
      ))}
    </div>
  );
}

interface RoutineResp {
  routine_id: string;
  status: string;
  steps: { step: string; outcome: string; at: string; [k: string]: unknown }[];
}

const STEP_ORDER = ["ingest", "checks", "features_and_score", "gate", "investigate", "draft", "publish_or_approve", "repair", "what_changed", "replay", "memory_note"];
const STEP_LABEL: Record<string, string> = { ingest: "Ingest", checks: "Checks", features_and_score: "Score", gate: "Gate", investigate: "Investigate", draft: "Draft fix", publish_or_approve: "Approve or publish", repair: "Repair", what_changed: "Compare", replay: "Replay", memory_note: "Memory" };

export function RoutineSteps({ routineId }: { routineId: string }) {
  const { data } = useQuery<RoutineResp>(`/api/routines/${encodeURIComponent(routineId)}`);
  const steps = data?.steps ?? [];
  const lastByStep = new Map<string, (typeof steps)[number]>();
  for (const s of steps) lastByStep.set(s.step, s);
  return (
    <div className="stepper" data-testid="routine-steps">
      {STEP_ORDER.map((name) => {
        const s = lastByStep.get(name);
        const cls = !s ? "" : s.outcome === "held" || s.outcome.includes("waiting") ? "held" : s.outcome.includes("fail") || s.outcome === "MISMATCH" ? "failed" : "done";
        return (
          <div key={name} className={`step ${cls}`}>
            <span className="step-dot" aria-hidden="true" />
            <span className="step-label">{STEP_LABEL[name]}</span>
            <span className="step-note">{s ? s.outcome : "not reached"}</span>
          </div>
        );
      })}
    </div>
  );
}
