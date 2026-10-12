// Freshness and check heatmap (SPEC 16.2): checks by day with the status palette plus an icon in every non-passing
// cell, so status is never color alone. Question: which checks failed, when, on which source?
import { scaleBand } from "d3-scale";
import type { CheckResult } from "../../shared/contracts";
import { Tooltip, useTooltip, useWidth } from "./kit";

const FILL: Record<string, string> = { pass: "color-mix(in srgb, var(--good) 22%, var(--surface))", warn: "var(--warning)", fail: "var(--critical)" };

export function CheckHeatmap({ checks, results }: { checks: { check_id: string; name: string; severity: string }[]; results: CheckResult[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const days = [...new Set(results.map((r) => r.date))].sort();
  const ids = checks.map((c) => c.check_id).filter((id) => results.some((r) => r.check_id === id));
  const labelW = 56;
  const cell = Math.max(8, Math.min(22, (width - labelW - 8) / Math.max(1, days.length)));
  const x = scaleBand<string>().domain(days).range([0, cell * days.length]).paddingInner(0.12);
  const y = scaleBand<string>().domain(ids).range([0, ids.length * 22]).paddingInner(0.15);
  const byKey = new Map<string, CheckResult>();
  for (const r of results) {
    const k = `${r.check_id}|${r.date}`;
    const prev = byKey.get(k);
    if (!prev || r.status === "fail" || (r.status === "warn" && prev.status === "pass")) byKey.set(k, r);
  }
  const height = ids.length * 22 + 30;
  const tickEvery = Math.ceil(days.length / Math.max(2, Math.floor((width - labelW) / 64)));
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Check results by day">
        <g transform={`translate(${labelW},0)`}>
          {ids.map((id) => (
            <text key={id} x={-8} y={(y(id) ?? 0) + y.bandwidth() / 2} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
              {id}
            </text>
          ))}
          {ids.flatMap((id) =>
            days.map((d) => {
              const r = byKey.get(`${id}|${d}`);
              if (!r) return null;
              const cx = (x(d) ?? 0) + x.bandwidth() / 2;
              const cy = (y(id) ?? 0) + y.bandwidth() / 2;
              const name = checks.find((c) => c.check_id === id)?.name ?? id;
              return (
                <g key={`${id}${d}`} onPointerMove={(e) => show(e, (
                  <>
                    <div className="tt-title">
                      {id} on {d}
                    </div>
                    <div style={{ marginBottom: 4 }}>{name}</div>
                    <div>
                      <strong>{r.status === "pass" ? "Passed" : r.status === "warn" ? "Warning" : "Failed"}</strong>
                      {r.failing_rows ? `: ${r.failing_rows} failing rows` : ""}
                    </div>
                  </>
                ))} onPointerLeave={hide}>
                  <rect x={x(d)} y={y(id)} width={x.bandwidth()} height={y.bandwidth()} rx={2} fill={FILL[r.status]} />
                  {r.status !== "pass" && x.bandwidth() >= 10 ? (
                    <text x={cx} y={cy} dy="0.35em" textAnchor="middle" style={{ fill: r.status === "fail" ? "#ffffff" : "#0b0b0b", fontSize: 10, fontWeight: 700 }}>
                      {r.status === "fail" ? "x" : "!"}
                    </text>
                  ) : null}
                </g>
              );
            }),
          )}
          {days.map((d, i) =>
            i % tickEvery === 0 || i === days.length - 1 ? (
              <text key={d} x={(x(d) ?? 0) + x.bandwidth() / 2} y={ids.length * 22 + 14} textAnchor="middle">
                {d.slice(5)}
              </text>
            ) : null,
          )}
        </g>
      </svg>
      <div className="chart-legend">
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: FILL.pass }} /> Passed
        </span>
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: FILL.warn }} /> ! Warning
        </span>
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: FILL.fail }} /> x Failed
        </span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}
