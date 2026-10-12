// Trust (SPEC 16.1, 10): how forecasts made the same way have done on the synthetic world. Monthly pseudo-real-time
// backtests, calibration of individual predictions shown only as deciles, interval coverage against nominal, the
// model comparison on the same six quarterly origins, and the count PIT histogram. Everything is a cohort aggregate.
import type { ComparisonMetrics, EvaluationFixture, EvaluationLevel } from "../../shared/contracts";
import { useQuery, type Me } from "../api";
import { BacktestTimeline, type CoverageRow, CoverageDots, EffectLine, MetricDots, MODEL_COLORS, MODEL_LABELS, PitHistogram, ReliabilityDiagram } from "../charts/trust";
import { ChartCard } from "../components/ChartCard";
import { EmptyState, ErrorState, Skeleton, StatusPill, SyntheticChip } from "../components/ui";
import { useView } from "../router";
import { PageHead } from "./Forecast";

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

function overlap(h: number, eff: number): string {
  return h === 1 ? `Adjacent 1-month windows do not overlap; about ${eff} independent windows` : `Adjacent ${h}-month windows overlap by ${h - 1} months, so this rests on about ${eff} independent windows`;
}

function Tile({ label, value, note, status }: { label: string; value: string; note: string; status: "good" | "warning" | "info" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div style={{ marginTop: 4 }}>
        <StatusPill status={status}>{note}</StatusPill>
      </div>
    </div>
  );
}

function coverageRows(ev: EvaluationFixture, h: number): CoverageRow[] {
  const rows: CoverageRow[] = [];
  for (const level of ["company", "organization"]) {
    const l = ev.backtest.levels[`${level}|${h}`];
    if (l) rows.push({ key: `bt-${level}`, label: `Model, ${level === "company" ? "company" : "organizations"} (monthly)`, model: "dtcr-mnl", coverage80: l.coverage80, coverage95: l.coverage95, ci80: l.coverage80_block_i80, note: `${l.windows} mature windows from ${l.origins} monthly origins; about ${l.effective_windows} independent` });
  }
  for (const level of ["company", "organization"]) {
    const s = ev.comparison?.summary[`${level}|${h}`];
    if (!s) continue;
    for (const model of ev.comparison.models) {
      const v = s[model];
      if (!v || typeof v !== "object") continue;
      rows.push({ key: `cmp-${level}-${model}`, label: `${MODEL_LABELS[model]}, ${level === "company" ? "company" : "organizations"} (quarterly)`, model, coverage80: v.coverage80, coverage95: v.coverage95, note: `the same ${ev.comparison.origins.length} quarterly origins for every model` });
    }
  }
  return rows;
}

export function TrustPage(_: { me: Me }) {
  const view = useView();
  const h = view.horizon;
  const { data: ev, error, loading } = useQuery<EvaluationFixture>("/api/evaluation");
  if (error) return <ErrorState error={error} />;
  if (loading && !ev) return <Skeleton height={320} />;
  if (!ev) return <EmptyState>No recorded evaluation yet.</EmptyState>;
  const cohort = view.cohort === "company" || view.cohort.startsWith("org:") ? view.cohort : "company";
  const series = ev.backtest.entries.filter((e) => e.cohort === cohort && e.horizon_months === h);
  const levelKey = `${cohort === "company" ? "company" : "organization"}|${h}`;
  const lvl: EvaluationLevel | undefined = ev.backtest.levels[levelKey];
  const cmp = ev.comparison?.summary[`company|${h}`];
  const cmpOrg = ev.comparison?.summary[`organization|${h}`];
  const name = cohort === "company" ? "Larkspur (company)" : cohort.slice(4);
  const metricDots = (s: typeof cmp, key: "mae" | "observed_over_expected" | "coverage80") =>
    s
      ? ev.comparison.models.flatMap((m) => {
          const v = s[m];
          return v && typeof v === "object" ? [{ model: m, value: (v as ComparisonMetrics)[key] }] : [];
        })
      : [];
  return (
    <>
      <PageHead title="Trust" sub="How forecasts made the same way have done. Pseudo-real-time backtests: model and data as known at each cutoff, not forecasts that were published. Synthetic world: this tests the pipeline and the uncertainty method, not real-world accuracy." />
      {lvl ? (
        <div className="stat-row" data-testid="trust-summary">
          <Tile label="Observed over expected" value={lvl.observed_over_expected.toFixed(2)} note={lvl.observed_over_expected < 1 ? "forecasts ran high" : "forecasts ran low"} status={Math.abs(lvl.observed_over_expected - 1) <= 0.15 ? "good" : "warning"} />
          <Tile label="80% range held" value={pct(lvl.coverage80)} note={`about ${lvl.effective_windows} independent windows`} status={lvl.coverage80 >= 0.7 ? "good" : "warning"} />
          <Tile label="Skill against the trailing rate" value={`${lvl.skill_vs_hist >= 0 ? "+" : ""}${pct(lvl.skill_vs_hist)}`} note="1 minus the ratio of mean absolute errors" status={lvl.skill_vs_hist > 0 ? "good" : "warning"} />
          <Tile label="Calibration at 3 months (ICI)" value={ev.calibration ? pct(ev.calibration.ici, 2) : "n/a"} note={ev.calibration ? `E90 ${pct(ev.calibration.e90, 2)}` : "company level only"} status={ev.calibration && ev.calibration.ici < 0.01 ? "good" : "info"} />
        </div>
      ) : null}
      <div className="grid">
        <ChartCard
          id="backtest"
          className="span-12"
          title="Over two years, did forecasts track actual departures?"
          subtitle={`${name} · next ${h} month${h > 1 ? "s" : ""} · ${lvl ? overlap(h, lvl.effective_windows) : "monthly origins"} · hollow dots are provisional actuals, left out of every number`}
          empty={series.length === 0}
          emptyText="Backtests are shown for the company and organizations of 50 or more people you can view."
          height={260}
          table={
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr><th>Origin</th><th className="num">Expected</th><th className="num">80% range</th><th className="num">95% range</th><th className="num">Actual</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {series.map((e) => (
                    <tr key={e.origin}><td>{e.origin}</td><td className="num">{e.expected.toFixed(1)}</td><td className="num">{e.i80[0]} to {e.i80[1]}</td><td className="num">{e.i95[0]} to {e.i95[1]}</td><td className="num">{e.status === "pending" ? "" : e.actual}</td><td>{e.status}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          }
        >
          <BacktestTimeline entries={series} />
        </ChartCard>
        <ChartCard
          id="reliability"
          className="span-6"
          title="When the model says 5%, do about 5% leave?"
          subtitle={ev.calibration ? `Individual 3-month predictions at mature origins, in deciles (${ev.calibration.n.toLocaleString("en-US")} person-windows); team-clustered 80% intervals; ICI ${pct(ev.calibration.ici, 2)}, E50 ${pct(ev.calibration.e50, 2)}, E90 ${pct(ev.calibration.e90, 2)}` : undefined}
          empty={!ev.calibration}
          emptyText="Calibration is a company-level view."
          height={300}
          table={
            ev.calibration ? (
              <table className="table">
                <thead><tr><th>Decile</th><th className="num">Predicted</th><th className="num">Observed</th><th className="num">80% interval</th><th className="num">n</th></tr></thead>
                <tbody>
                  {ev.calibration.reliability.map((b) => (
                    <tr key={b.bin}><td>{b.bin}</td><td className="num">{pct(b.predicted, 2)}</td><td className="num">{pct(b.observed, 2)}</td><td className="num">{pct(b.observed_i80[0], 2)} to {pct(b.observed_i80[1], 2)}</td><td className="num">{b.n.toLocaleString("en-US")}</td></tr>
                  ))}
                </tbody>
              </table>
            ) : undefined
          }
        >
          {ev.calibration ? <ReliabilityDiagram bins={ev.calibration.reliability} /> : null}
        </ChartCard>
        <ChartCard
          id="coverage"
          className="span-6"
          title="Do our ranges contain the truth as often as they claim?"
          subtitle={`Next ${h} month${h > 1 ? "s" : ""}; dashed lines at the nominal 80% and 95%; the model's line is a moving-block bootstrap interval over origins`}
          empty={coverageRows(ev, h).length === 0}
          height={300}
          table={
            <table className="table">
              <thead><tr><th>Model and level</th><th className="num">80% held</th><th className="num">95% held</th></tr></thead>
              <tbody>
                {coverageRows(ev, h).map((r) => (
                  <tr key={r.key}><td>{r.label}</td><td className="num">{pct(r.coverage80, 1)}</td><td className="num">{pct(r.coverage95, 1)}</td></tr>
                ))}
              </tbody>
            </table>
          }
        >
          <CoverageDots rows={coverageRows(ev, h)} />
        </ChartCard>
        <ChartCard
          id="comparison"
          className="span-8"
          title="Is the competing-risks model better than the status quo?"
          subtitle={`The same ${ev.comparison?.origins.length ?? 6} quarterly origins for every model, next ${h} month${h > 1 ? "s" : ""}; the oracle knows the latent propensities and the generator, which no model can`}
          empty={!cmp}
          emptyText="The comparison is a company-level view."
          height={260}
        >
          {cmp ? (
            <>
              <div className="label-sm" style={{ margin: "4px 0" }}>Company</div>
              <div className="multiples">
                <MetricDots title="Mean absolute error" dots={metricDots(cmp, "mae")} format={(v) => v.toFixed(1)} labels />
                <MetricDots title="Observed over expected" dots={metricDots(cmp, "observed_over_expected")} reference={1} format={(v) => v.toFixed(2)} />
                <MetricDots title="80% range held" dots={metricDots(cmp, "coverage80")} reference={0.8} format={(v) => pct(v)} />
              </div>
              {cmpOrg ? (
                <>
                  <div className="label-sm" style={{ margin: "12px 0 4px" }}>Organizations</div>
                  <div className="multiples">
                    <MetricDots title="Mean absolute error" dots={metricDots(cmpOrg, "mae")} format={(v) => v.toFixed(1)} labels />
                    <MetricDots title="Observed over expected" dots={metricDots(cmpOrg, "observed_over_expected")} reference={1} format={(v) => v.toFixed(2)} />
                    <MetricDots title="80% range held" dots={metricDots(cmpOrg, "coverage80")} reference={0.8} format={(v) => pct(v)} />
                  </div>
                </>
              ) : null}
              <div className="chart-legend">
                {ev.comparison.models.map((m) => (
                  <span key={m} className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill={MODEL_COLORS[m]} /></svg>{MODEL_LABELS[m]}</span>
                ))}
              </div>
            </>
          ) : null}
        </ChartCard>
        <ChartCard
          id="pit"
          className="span-4"
          title="Are the predictive distributions calibrated as a whole?"
          subtitle={lvl ? `${cohort === "company" ? "Company" : "Organizations"}, next ${h} month${h > 1 ? "s" : ""}: non-randomized count PIT; flat at 0.1 means calibrated; mean RPS ${lvl.rps.toFixed(2)}` : undefined}
          empty={!lvl}
          height={180}
        >
          {lvl ? <PitHistogram bins={lvl.pit_histogram} /> : null}
        </ChartCard>
        {ev.effects && cmp ? (
          <ChartCard
            id="effects"
            className="span-12"
            title="Which conditions are associated with higher predicted risk?"
            subtitle={`Associational, not causal: the mean predicted 3-month probability over the ${ev.effects.population.toLocaleString("en-US")} people in the current population when one feature is set to each value, everything else as observed; bands from the model's parameter uncertainty`}
            height={200}
            table={
              <table className="table">
                <thead><tr><th>Feature</th><th>Value</th><th className="num">Mean predicted</th><th className="num">80% band</th></tr></thead>
                <tbody>
                  {Object.values(ev.effects.effects).flatMap((f) =>
                    f.points.map((p) => (
                      <tr key={`${f.label}${p.x}`}><td>{f.label}</td><td>{String(p.x)}</td><td className="num">{pct(p.cif, 2)}</td><td className="num">{pct(p.lo, 2)} to {pct(p.hi, 2)}</td></tr>
                    )),
                  )}
                </tbody>
              </table>
            }
          >
            <div className="multiples">
              {Object.entries(ev.effects.effects).map(([key, f]) => (
                <EffectLine key={key} label={f.label} points={f.points} binary={f.points.length === 2} />
              ))}
            </div>
          </ChartCard>
        ) : null}
      </div>
      <p style={{ fontSize: 12, color: "var(--ink-3)", margin: "12px 0" }}>
        <SyntheticChip /> Recorded {ev.date} by {ev.commands.join(" and ")}. {ev.backtest.provisional_windows_excluded} provisional windows were left out of every number.
      </p>
    </>
  );
}
