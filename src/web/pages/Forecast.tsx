// Forecast page (SPEC 16.1, beat 1): the hero number with its ranges and the status-quo trailing-rate number, the fan
// chart, the trust strip, the pseudo-real-time backtest strip, the variance decomposition and the cohort breakdown.
import type { BreakdownData, ForecastData } from "../../shared/contracts";
import { hasScope, isRefusal, type Me, type Refusal, useQuery } from "../api";
import { BreakdownBars, BreakdownTable, VarianceBar } from "../charts/bars";
import { FanChart, FanTable } from "../charts/FanChart";
import { HistoryStrip, HistoryTable } from "../charts/HistoryStrip";
import { fmtVal } from "../charts/kit";
import { ChartCard } from "../components/ChartCard";
import { IconHold } from "../components/icons";
import { ErrorState, RefusalNote, Skeleton, StatusPill, SyntheticChip } from "../components/ui";
import { useView } from "../router";

interface Envelope<T> {
  result_id: string;
  rounding: { step: number; band: string } | null;
  provenance: { run_id?: string; cutoff?: string; vintage?: string };
  data: T;
}

interface HistoryData {
  cohort: { name: string; n: number };
  points: import("../../shared/contracts").HistoryPoint[];
  note: string;
  coverage80: { held: number; windows: number } | null;
}

interface Trust {
  backtest: { oe: number | null; coverage80: { held: number; windows: number }; effective_windows: number } | null;
  freshness: { status: string; detail: string; date: string };
  checks: { passing: number; total: number; failing: string[] };
}

function TrustTile({ label, value, note, status }: { label: string; value: string; note: string; status: "good" | "warning" | "critical" | "info" }) {
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

function TrustStrip({ cohort, horizon }: { cohort: string; horizon: number }) {
  const { data } = useQuery<Trust>(`/api/trust?cohort=${encodeURIComponent(cohort)}&horizon=${horizon}`);
  if (!data) return <Skeleton height={86} />;
  const bt = data.backtest;
  const cov = bt ? bt.coverage80 : null;
  const oeStatus = bt?.oe == null ? "info" : Math.abs(bt.oe - 1) <= 0.15 ? "good" : "warning";
  return (
    <div className="stat-row" data-testid="trust-strip">
      <TrustTile label="Backtest observed over expected" value={bt?.oe != null ? bt.oe.toFixed(2) : "n/a"} note={bt ? (bt.oe != null && bt.oe < 1 ? "forecasts ran high" : "on target") : "not evaluated at this level"} status={oeStatus} />
      <TrustTile label="80% range held" value={cov ? `${cov.held} of ${cov.windows}` : "n/a"} note={cov ? `about ${bt?.effective_windows} independent windows` : "organization level and above"} status={cov ? (cov.held / cov.windows >= 0.65 ? "good" : "warning") : "info"} />
      <TrustTile label="Data freshness" value={data.freshness.status === "pass" ? "Fresh" : "Stale"} note={`HRIS checked ${data.freshness.date}`} status={data.freshness.status === "pass" ? "good" : "critical"} />
      <TrustTile label="Checks passing" value={`${data.checks.passing} of ${data.checks.total}`} note={data.checks.failing.length ? `failing: ${data.checks.failing.join(", ")}` : "no failures"} status={data.checks.failing.length ? "critical" : "good"} />
    </div>
  );
}

export function ForecastPage({ me }: { me: Me }) {
  const view = useView();
  const q = `cohort=${encodeURIComponent(view.cohort)}&horizon=${view.horizon}${view.run ? `&run=${encodeURIComponent(view.run)}` : ""}`;
  const f = useQuery<Envelope<ForecastData> | Refusal>(`/api/forecast?${q}`);
  const hist = useQuery<Envelope<HistoryData> | Refusal>(`/api/forecast/history?cohort=${encodeURIComponent(view.cohort)}&horizon=${view.horizon}`);
  const by = view.cohort.startsWith("org:") ? "group" : view.cohort === "company" ? "group" : view.cohort.startsWith("group:") && hasScope(me, "forecast:read:team") ? "team" : null;
  const bd = useQuery<Envelope<BreakdownData> | Refusal>(by ? `/api/forecast/breakdown?cohort=${encodeURIComponent(view.cohort)}&by=${by}&horizon=${view.horizon}` : null);
  const levels = useQuery<Envelope<BreakdownData> | Refusal>(view.cohort.startsWith("org:") && hasScope(me, "forecast:read:all") ? `/api/forecast/breakdown?cohort=${encodeURIComponent(view.cohort)}&by=level_band&horizon=${view.horizon}` : null);

  if (f.error) return <ErrorState error={f.error} />;
  if (f.data && isRefusal(f.data)) {
    return (
      <>
        <PageHead title="Forecast" />
        <RefusalNote code={f.data.code} message={f.data.message} />
      </>
    );
  }
  const env = f.data as Envelope<ForecastData> | null;
  const d = env?.data;
  const step = d?.step ?? 0.1;
  return (
    <>
      <PageHead title={d ? `${d.cohort.name}: voluntary departures` : "Forecast"} sub={d ? `Next ${d.horizon} month${d.horizon > 1 ? "s" : ""} (about ${d.horizon === 1 ? 30 : d.horizon === 3 ? 90 : 180} days) from the ${d.cutoff} cutoff, ${d.cohort.n.toLocaleString("en-US")} people, ${d.metric_def}. Cohort-level only.` : undefined} />
      {d && d.run_status === "held" ? (
        <div className="banner warning" role="status">
          <IconHold size={16} />
          <div>
            <div className="banner-title">Held for review: {d.run_id}</div>
            <div className="banner-body">This run failed checks upstream of its features. Its values are shown greyed for analysts and data engineers only; nothing was published.</div>
          </div>
        </div>
      ) : null}
      <section className="card" aria-label="Headline forecast" data-testid="hero">
        {!d ? (
          <Skeleton height={96} />
        ) : (
          <div className="hero" style={d.run_status === "held" ? { opacity: 0.55 } : undefined}>
            <div>
              <div className="hero-label">Expected voluntary departures</div>
              <div className="hero-figure" data-testid="hero-figure">
                {fmtVal(d.expected, step)}
              </div>
              <div className="hero-range">
                80% range <strong className="num">{d.i80[0]} to {d.i80[1]}</strong> · 95% range <strong className="num">{d.i95[0]} to {d.i95[1]}</strong>
              </div>
            </div>
            <div className="hero-side">
              <span className="label-sm">Trailing-rate status quo</span>
              <span className="value">{fmtVal(d.hist.expected, step)}</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>last 12 months at {(d.hist.annual_rate * 100).toFixed(1)}% a year</span>
            </div>
            <div className="hero-side">
              <span className="label-sm">Annualized rate</span>
              <span className="value">{(d.annual_rate * 100).toFixed(1)}%</span>
              <span style={{ fontSize: 12, color: "var(--ink-3)" }}>rounded to {step} by cohort size</span>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
              <SyntheticChip />
              <span className="chip">
                Run {d.run_id} · {d.run_status}
              </span>
            </div>
          </div>
        )}
        {env ? (
          <div className="card-foot">
            <span>Computed result</span>
            <code>{env.result_id}</code>
            <span>vintage {d?.vintage}</span>
          </div>
        ) : null}
      </section>
      <TrustStrip cohort={view.cohort} horizon={view.horizon} />
      <div className="grid">
        <ChartCard id="fan" className="span-7" title="How do departures accumulate, and how wide is the range?" subtitle={d ? `${d.cohort.name} · cumulative over 6 months · cutoff ${d.cutoff}` : undefined} loading={!d} resultIds={[env?.result_id]} table={d ? <FanTable curve={d.curve} step={step} /> : undefined} height={260}>
          {d ? <FanChart curve={d.curve} cutoff={d.cutoff} horizon={d.horizon} step={step} showOther={Boolean(d.other)} /> : null}
        </ChartCard>
        <ChartCard
          id="history"
          className="span-5"
          title="How did forecasts made the same way compare with what happened?"
          subtitle="Pseudo-real-time backtest: model and data as known at each cutoff, not forecasts that were published"
          loading={hist.loading && !hist.data}
          error={hist.error}
          empty={Boolean(hist.data && (isRefusal(hist.data) || (hist.data as Envelope<HistoryData>).data.points.length === 0))}
          emptyText={hist.data && isRefusal(hist.data) ? hist.data.message : "No backtests for this cohort (comparisons over time need 50 or more people)."}
          resultIds={[hist.data && !isRefusal(hist.data) ? hist.data.result_id : null]}
          table={hist.data && !isRefusal(hist.data) ? <HistoryTable points={hist.data.data.points} step={step} /> : undefined}
        >
          {hist.data && !isRefusal(hist.data) ? (
            <>
              <HistoryStrip points={hist.data.data.points} step={step} />
              {hist.data.data.coverage80 ? (
                <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 8 }} data-testid="coverage-line">
                  In non-overlapping quarterly backtests the 80% range held {hist.data.data.coverage80.held} of {hist.data.data.coverage80.windows} times (synthetic world).
                </p>
              ) : null}
            </>
          ) : null}
        </ChartCard>
        <ChartCard id="variance" className="span-5" title="Why is the range as wide as it is?" subtitle="Share of the variance of the count, by source (law of total variance, rounded to 5 points)" loading={!d} resultIds={[env?.result_id]}>
          {d ? <VarianceBar variance={d.variance} /> : null}
        </ChartCard>
        {bd.data || levels.data ? (
          <ChartCard
            id="breakdown"
            className="span-7"
            title="Which parts of the cohort contribute to the expected count?"
            subtitle={by === "team" ? "Teams sorted by name; for planning, not an evaluation of the team's manager" : "Sorted by name, never ranked by risk"}
            loading={bd.loading && !bd.data}
            empty={Boolean(bd.data && isRefusal(bd.data))}
            emptyText={bd.data && isRefusal(bd.data) ? bd.data.message : undefined}
            resultIds={[bd.data && !isRefusal(bd.data) ? bd.data.result_id : null, levels.data && !isRefusal(levels.data) ? levels.data.result_id : null]}
            table={bd.data && !isRefusal(bd.data) ? <BreakdownTable rows={bd.data.data.rows} /> : undefined}
          >
            {bd.data && !isRefusal(bd.data) ? <BreakdownBars rows={bd.data.data.rows} horizon={view.horizon} /> : null}
            {levels.data && !isRefusal(levels.data) ? (
              <div style={{ marginTop: 16 }}>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  By level band
                </div>
                <BreakdownBars rows={levels.data.data.rows} horizon={view.horizon} />
              </div>
            ) : null}
          </ChartCard>
        ) : null}
      </div>
    </>
  );
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p>{sub}</p> : null}
      </div>
      {actions}
    </div>
  );
}
