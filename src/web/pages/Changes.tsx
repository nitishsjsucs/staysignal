// What changed (SPEC 12, beat 2): the exact Shapley waterfall between the previous and the current published run,
// drawn against the width of the 80% range, and the run version timeline with the one-click publish-pointer rollback.
import type { ChangeEntry, RunBrief } from "../../shared/contracts";
import { hasScope, isRefusal, type Me, type Refusal, useQuery } from "../api";
import { Waterfall } from "../charts/bars";
import { fmtVal } from "../charts/kit";
import { ChartCard } from "../components/ChartCard";
import { RollbackControl } from "../components/Actions";
import { RefusalNote, StatusPill } from "../components/ui";
import { useView } from "../router";
import { PageHead } from "./Forecast";

interface ChangeData extends Omit<ChangeEntry, "cohort_id" | "horizon"> {
  cohort: { id: string; name: string; n: number };
  horizon: number;
  from: string;
  to: string;
  largest: string;
}

interface Envelope<T> {
  result_id: string;
  data: T;
}

interface Runs {
  published: string;
  runs: RunBrief[];
  mapping: string;
}

interface Audit {
  actions: { seq: number; kind: string; actor: string; payload_json: string; created_at: string; reverses_seq: number | null }[];
}

const EXPLAIN: Record<string, string> = {
  calendar: "The cutoff moved a month: the window now covers different calendar months (season) and every clock aged. No new events.",
  composition: "People joined, left or moved between the two cutoffs.",
  input_data: "Late data about the past arrived (late terminations and corrections, such as the 2026-09-15 audit batch).",
  model: "The monthly retrain replaced the model artifact.",
  definition: "The metric definition changed: voluntary_departures@2 excludes fixed-term employees.",
  time_and_population: "Fewer than 10 people changed for one of these factors, so it is merged with Calendar to protect individuals.",
};

export function ChangesPage({ me }: { me: Me }) {
  const view = useView();
  const ch = useQuery<Envelope<ChangeData> | Refusal>(`/api/changes?cohort=${encodeURIComponent(view.cohort)}&horizon=${view.horizon}&from=${encodeURIComponent("R-2026-09-01#1")}&to=${encodeURIComponent("R-2026-10-01#1")}`);
  const runs = useQuery<Runs>("/api/runs");
  const audit = useQuery<Audit>(hasScope(me, "rollback") ? "/api/audit" : null);
  const d = ch.data && !isRefusal(ch.data) ? ch.data.data : null;
  const publishes = (audit.data?.actions ?? []).filter((a) => a.kind === "run.publish");
  const reversed = new Set((audit.data?.actions ?? []).filter((a) => a.kind === "rollback").map((a) => a.reverses_seq));
  const lastPublish = [...publishes].reverse().find((a) => !reversed.has(a.seq) && JSON.parse(a.payload_json).previous_run_id);
  return (
    <>
      <PageHead title="What changed" sub="Between the previous published forecast (R-2026-09-01#1) and the current one (R-2026-10-01#1): exact contributions that sum to the change." />
      {ch.data && isRefusal(ch.data) ? <RefusalNote code={ch.data.code} message={ch.data.message} /> : null}
      <div className="grid">
        <ChartCard
          id="waterfall"
          className="span-8"
          title="Why does this forecast differ from the last one, and is the change big relative to the uncertainty?"
          subtitle={d ? `${d.cohort.name} · ${d.horizon} months · ${d.from} to ${d.to} · rounded to ${d.step}` : undefined}
          loading={ch.loading && !ch.data}
          error={ch.error}
          empty={Boolean(ch.data && isRefusal(ch.data))}
          emptyText="Comparisons over time are served for cohorts of 50 or more people."
          resultIds={[ch.data && !isRefusal(ch.data) ? ch.data.result_id : null]}
          height={300}
          table={
            d ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Factor</th>
                    <th className="num">Contribution</th>
                    <th className="num">People changed</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Previous run</td>
                    <td className="num">{fmtVal(d.from_value, d.step)}</td>
                    <td />
                  </tr>
                  {d.factors.map((f) => (
                    <tr key={f.factor}>
                      <td>{f.label}</td>
                      <td className="num">{fmtVal(f.phi, d.step)}</td>
                      <td className="num">{f.changed_people ?? "merged"}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>Current run</td>
                    <td className="num">{fmtVal(d.to_value, d.step)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            ) : undefined
          }
        >
          {d ? <Waterfall from={d.from_value} to={d.to_value} factors={d.factors} width80={d.interval80_width} step={d.step} fromLabel="Previous (Sep 1)" toLabel="Current (Oct 1)" /> : null}
        </ChartCard>
        <section className="card span-4" aria-label="Factors">
          <div className="card-head">
            <div>
              <h2 className="card-title">What each bar means</h2>
              <div className="card-sub">Five factors switched between the two runs; 32 scored combinations, Shapley values over 120 orderings</div>
            </div>
          </div>
          <div className="list">
            {(d?.factors ?? []).map((f) => (
              <div key={f.factor} className="list-item">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{f.label}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-2)" }}>{EXPLAIN[f.factor]}</div>
                </div>
                <div className="num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                  {f.phi > 0 ? "+" : ""}
                  {fmtVal(f.phi, d?.step ?? 0.1)}
                </div>
              </div>
            ))}
          </div>
          {d ? (
            <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 8 }}>
              Total change {d.delta > 0 ? "+" : ""}
              {fmtVal(d.delta, d.step)} against an 80% range about {fmtVal(d.interval80_width, 1)} wide.
            </p>
          ) : null}
        </section>
        <section className="card span-12" aria-label="Run versions" data-testid="run-timeline">
          <div className="card-head">
            <div>
              <h2 className="card-title">Which versions exist and which is published?</h2>
              <div className="card-sub">Publication is a pointer; rollback moves it back and adds a reversal entry. Nothing is deleted.</div>
            </div>
            {hasScope(me, "rollback") && lastPublish ? <RollbackControl seq={lastPublish.seq} label="Roll back the last publication" defaultReason="Restore the previous version" /> : null}
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Cutoff</th>
                  <th>Vintage</th>
                  <th>Model</th>
                  <th>Definition</th>
                  <th>Mapping</th>
                  <th>Business result hash</th>
                </tr>
              </thead>
              <tbody>
                {(runs.data?.runs ?? []).map((r) => (
                  <tr key={r.run_id}>
                    <td>
                      <strong>{r.run_id}</strong>
                    </td>
                    <td>
                      <StatusPill status={r.status === "published" ? "good" : r.status === "held" ? "held" : "info"}>{r.status}</StatusPill>
                    </td>
                    <td>{r.cutoff}</td>
                    <td className="mono">{r.vintage}</td>
                    <td>{r.model}</td>
                    <td>{r.metric_def}</td>
                    <td>{r.mapping}</td>
                    <td className="mono">{r.result_hash.slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
