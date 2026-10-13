// Workforce page (SPEC 16.1, 16.2): where the people of a cohort came from and went over the last 12 months, from the
// governed semantic layer (the `workforce_flows` tool over a compiled catalog entry). Cohort-level only; links under 10
// people are merged and a side under 10 is withheld (SPEC 17.5). Synthetic data.
import type { FunnelData, WorkforceFlowsData } from "../../shared/contracts";
import { isRefusal, type Me, type Refusal, useQuery } from "../api";
import { FlowSankey, FlowTable } from "../charts/FlowSankey";
import { FunnelPlot, FunnelTable } from "../charts/FunnelPlot";
import { ChartCard } from "../components/ChartCard";
import { ErrorState, RefusalNote, Skeleton } from "../components/ui";
import { useView } from "../router";
import { PageHead } from "./Forecast";

interface Envelope<T> {
  result_id: string;
  provenance: { catalog_entry?: string };
  data: T;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

const fmt = (v: number | null) => (v === null ? "withheld" : v.toLocaleString("en-US"));

function Funnel({ horizon }: { horizon: number }) {
  const q = useQuery<FunnelData | Refusal>(`/api/workforce/funnel?horizon=${horizon}`);
  const d = q.data && !isRefusal(q.data) ? q.data : null;
  return (
    <ChartCard
      id="funnel"
      title="Which cohorts are unusual once size is taken into account?"
      subtitle={d?.origin ? `Observed over expected voluntary departures in the ${d.horizon}-month window from ${d.origin} (a pseudo-real-time backtest: model and data as known then), against the expected count; small cohorts scatter more, so the limits narrow as cohorts grow. Groups and above with 50 or more people; synthetic data.` : "No mature backtest window yet"}
      loading={q.loading && !q.data}
      error={q.error}
      empty={Boolean(d && !d.points.length)}
      emptyText="No cohort you can see has a mature window at this horizon."
      table={d ? <FunnelTable points={d.points} /> : undefined}
      height={340}
    >
      {d ? <FunnelPlot points={d.points} /> : null}
      <p className="card-sub" style={{ marginTop: 8 }}>
        A point outside the limits is a reason to look, not a finding: one window, and the limits assume independent people.
      </p>
    </ChartCard>
  );
}

export function WorkforcePage(_: { me: Me }) {
  const view = useView();
  const q = useQuery<Envelope<WorkforceFlowsData> | Refusal>(`/api/workforce/flows?cohort=${encodeURIComponent(view.cohort)}`);
  const head = <PageHead title="Workforce flows" sub="Hires, moves between groups and exits over the last 12 months, from the governed semantic layer. Cohort-level only; small links are merged." />;
  if (q.error) return <ErrorState error={q.error} />;
  if (q.data && isRefusal(q.data)) {
    return (
      <>
        {head}
        <RefusalNote code={q.data.code} message={q.data.message} />
      </>
    );
  }
  const env = q.data as Envelope<WorkforceFlowsData> | null;
  if (!env) {
    return (
      <>
        {head}
        <Skeleton height={320} />
      </>
    );
  }
  const v = env.data;
  return (
    <>
      {head}
      <div className="stat-row" data-testid="flow-tiles">
        <Tile label={`People at the start (${v.from})`} value={fmt(v.headcount_start)} note={v.cohort.name} />
        <Tile label="Arrived" value={fmt(v.joined)} note="hires and moves in" />
        <Tile label="Left or moved out" value={fmt(v.left)} note="exits and moves out" />
        <Tile label={`People at the end (${v.to})`} value={fmt(v.headcount_end)} note={v.headcount_end === null ? "withheld: it would reveal a small flow" : "start plus arrivals minus departures"} />
      </div>
      <ChartCard
        id="flows"
        title={`Where did people in ${v.cohort.name} come from and go?`}
        subtitle={`${v.from} to ${v.to} · catalog entry ${v.catalog_entry} · synthetic data`}
        resultIds={[env.result_id]}
        table={<FlowTable links={v.links} />}
        height={320}
      >
        <FlowSankey links={v.links} cohort={v.cohort.name} />
        <p className="card-sub" style={{ marginTop: 8 }}>
          Links under 10 people are merged, and a side under 10 is withheld; exits other than voluntary are one band, never by type. Voluntary exits keep their forecast color; every other band is neutral.
        </p>
      </ChartCard>
      <div style={{ marginTop: 16 }} data-testid="funnel-card">
        <Funnel horizon={view.horizon} />
      </div>
    </>
  );
}
