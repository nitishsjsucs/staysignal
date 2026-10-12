// Every chart card: a title phrased as its question, a subtitle with cohort, horizon and cutoff, a "View as table"
// toggle (also the accessible and Playwright text target), a provenance footer with result IDs, and loading, empty and
// error states (SPEC 16.2).
import { type ReactNode, useState } from "react";
import { navigate } from "../router";
import { EmptyState, ErrorState, Skeleton } from "./ui";

export interface ChartCardProps {
  title: string;
  subtitle?: ReactNode;
  resultIds?: (string | null | undefined)[];
  loading?: boolean;
  error?: Error | null;
  empty?: boolean;
  emptyText?: ReactNode;
  table?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  height?: number;
  id?: string;
}

export function ChartCard({ title, subtitle, resultIds = [], loading, error, empty, emptyText, table, actions, children, className = "", height = 220, id }: ChartCardProps) {
  const [showTable, setShowTable] = useState(false);
  const ids = resultIds.filter((x): x is string => Boolean(x));
  return (
    <section className={`card ${className}`} aria-labelledby={id ? `${id}-title` : undefined} data-testid={id}>
      <div className="card-head">
        <div>
          <h2 className="card-title" id={id ? `${id}-title` : undefined}>
            {title}
          </h2>
          {subtitle ? <div className="card-sub">{subtitle}</div> : null}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          {actions}
          {table ? (
            <button type="button" className="link-btn" onClick={() => setShowTable((s) => !s)} aria-pressed={showTable}>
              {showTable ? "View as chart" : "View as table"}
            </button>
          ) : null}
        </div>
      </div>
      {error ? <ErrorState error={error} /> : loading ? <Skeleton height={height} /> : empty ? <EmptyState>{emptyText}</EmptyState> : showTable && table ? <div className="table-wrap">{table}</div> : children}
      {ids.length ? (
        <div className="card-foot">
          <span>Computed results</span>
          {ids.map((id) => (
            <a
              key={id}
              href={`/r/${id}`}
              onClick={(e) => {
                e.preventDefault();
                navigate(`/r/${id}`);
              }}
            >
              <code>{id}</code>
            </a>
          ))}
        </div>
      ) : null}
    </section>
  );
}
