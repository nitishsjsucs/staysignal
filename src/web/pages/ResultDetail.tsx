// Result (SPEC 16.1): any computed result with its provenance, so every number in the product can be traced.
import { useQuery } from "../api";
import { ErrorState, Skeleton, SyntheticChip } from "../components/ui";
import { PageHead } from "./Forecast";

interface Stored {
  result_id: string;
  label: string;
  provenance: Record<string, unknown>;
  rounding: { step: number; band: string } | null;
  suppressed_cells: number;
  data: unknown;
}

export function ResultPage({ id }: { id: string }) {
  const { data, error } = useQuery<Stored>(`/api/results/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Skeleton height={300} />;
  const p = data.provenance;
  return (
    <>
      <PageHead title="Computed result" sub="Every number in StaySignal comes from a result like this one: a governed tool, its arguments, the run, the vintage and the disclosure rounding." />
      <section className="card" data-testid="result">
        <div className="card-head">
          <div>
            <h2 className="card-title mono">{data.result_id}</h2>
            <div className="card-sub">Content-addressed: the same question on the same data gives the same ID</div>
          </div>
          <SyntheticChip />
        </div>
        <dl className="kv">
          <dt>Tool</dt>
          <dd>{String(p.tool ?? "")}</dd>
          <dt>Computed by</dt>
          <dd>{String(p.computed_by ?? "")}</dd>
          <dt>Run</dt>
          <dd>{String(p.run_id ?? "n/a")}</dd>
          <dt>Catalog entry</dt>
          <dd className="mono">{String(p.catalog_entry ?? "n/a")}</dd>
          <dt>Metric definition</dt>
          <dd>{String(p.metric_def ?? "n/a")}</dd>
          <dt>Vintage</dt>
          <dd>{String(p.vintage ?? "n/a")}</dd>
          <dt>Arguments</dt>
          <dd className="mono">{JSON.stringify(p.args ?? {})}</dd>
          <dt>Rounding</dt>
          <dd>{data.rounding ? `${data.rounding.step} (cohort ${data.rounding.band})` : "none"}</dd>
          <dt>Suppressed cells</dt>
          <dd>{data.suppressed_cells}</dd>
        </dl>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 12 }}>Values</summary>
          <pre className="diff" style={{ marginTop: 8 }}>
            {JSON.stringify(data.data, null, 2)}
          </pre>
        </details>
      </section>
    </>
  );
}
