// Backtest strip (SPEC 16.2): quarterly pseudo-real-time backtests with 80% and 95% whiskers, the expected value,
// actual departures (hollow when provisional), the published runs marked, and the 2026-09-20 definition change drawn
// as a break. Question: how did forecasts made the same way compare with what happened?
import { scaleBand, scaleLinear } from "d3-scale";
import type { HistoryPoint } from "../../shared/contracts";
import { fmtVal, niceTicks, shortDate, TipRow, Tooltip, useTooltip, useWidth } from "./kit";

export function HistoryStrip({ points, step, height = 220 }: { points: HistoryPoint[]; step: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 14, right: 12, bottom: 36, left: 40 };
  const iw = Math.max(120, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const ymax = Math.max(1, ...points.map((p) => Math.max(p.i95[1], p.actual ?? 0)));
  const ticks = niceTicks(ymax);
  const x = scaleBand<string>()
    .domain(points.map((p) => `${p.origin}${p.published_run_id ?? ""}`))
    .range([0, iw])
    .paddingInner(0.3)
    .paddingOuter(0.2);
  const y = scaleLinear().domain([0, ticks[ticks.length - 1]!]).range([ih, 0]);
  const breakAt = points.findIndex((p) => p.origin >= "2026-09-20" || p.published_run_id === "R-2026-10-01#1");
  // Date labels are about 40 px wide at 11 px: label every k-th backtest so neighbours never touch, and give the
  // published runs one bracketed label under the group (their dates are in the tooltip and the table view).
  const backtestIdx = points.flatMap((p, i) => (p.published_run_id ? [] : [i]));
  const stride = Math.max(1, Math.ceil(44 / x.step()));
  const labeled = new Set(backtestIdx.filter((_, j) => j % stride === 0));
  const pubKeys = points.filter((p) => p.published_run_id).map((p) => `${p.origin}${p.published_run_id ?? ""}`);
  const pubSpan = pubKeys.length > 0 ? [x(pubKeys[0]!) ?? 0, (x(pubKeys[pubKeys.length - 1]!) ?? 0) + x.bandwidth()] : null;
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Backtest strip: expected departures with 80% and 95% ranges against actual departures at quarterly origins">
        <g transform={`translate(${m.left},${m.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {breakAt > 0 ? (
            <g>
              <line x1={(x(`${points[breakAt]!.origin}${points[breakAt]!.published_run_id ?? ""}`) ?? 0) - x.step() * 0.15} x2={(x(`${points[breakAt]!.origin}${points[breakAt]!.published_run_id ?? ""}`) ?? 0) - x.step() * 0.15} y1={-6} y2={ih} stroke="var(--axis)" strokeWidth={1} />
              <text x={(x(`${points[breakAt]!.origin}${points[breakAt]!.published_run_id ?? ""}`) ?? 0) - x.step() * 0.15 + 4} y={-2} textAnchor="start">
                @2
              </text>
            </g>
          ) : null}
          {points.map((p, i) => {
            const key = `${p.origin}${p.published_run_id ?? ""}`;
            const cx = (x(key) ?? 0) + x.bandwidth() / 2;
            const pub = Boolean(p.published_run_id);
            const withheld = Boolean(p.omitted_reason);
            return (
              <g
                key={key}
                onPointerMove={(e) =>
                  show(e, (
                    <>
                      <div className="tt-title">
                        {pub ? `Published run ${p.published_run_id}` : `Backtest at ${p.origin}`}
                      </div>
                      {withheld ? (
                        <div>Withheld: fewer than 10 people changed between points</div>
                      ) : (
                        <>
                          <TipRow name="Expected" value={fmtVal(p.expected, step)} line="var(--series-vol)" />
                          <TipRow name="80% range" value={`${p.i80[0]} to ${p.i80[1]}`} />
                          <TipRow name="95% range" value={`${p.i95[0]} to ${p.i95[1]}`} />
                          <TipRow name={p.actual_status === "provisional" ? "Actual (provisional)" : "Actual"} value={p.actual ?? "pending"} />
                        </>
                      )}
                    </>
                  ))
                }
                onPointerLeave={hide}
              >
                <rect x={x(key)} y={0} width={x.bandwidth()} height={ih} fill="transparent" />
                {withheld ? (
                  <text x={cx} y={ih - 6} textAnchor="middle">
                    withheld
                  </text>
                ) : (
                  <>
                    <line x1={cx} x2={cx} y1={y(p.i95[0])} y2={y(p.i95[1])} stroke="var(--series-vol)" strokeOpacity={0.35} strokeWidth={2} strokeLinecap="round" />
                    <line x1={cx} x2={cx} y1={y(p.i80[0])} y2={y(p.i80[1])} stroke="var(--series-vol)" strokeOpacity={0.7} strokeWidth={6} strokeLinecap="round" />
                    <line x1={cx - 7} x2={cx + 7} y1={y(p.expected)} y2={y(p.expected)} stroke="var(--series-vol)" strokeWidth={2} />
                    {p.actual !== null ? <circle cx={cx} cy={y(p.actual)} r={4.5} fill={p.actual_status === "mature" ? "var(--ink)" : "var(--surface)"} stroke={p.actual_status === "mature" ? "var(--surface)" : "var(--ink)"} strokeWidth={2} /> : null}
                    {pub ? <circle cx={cx} cy={y(p.expected)} r={6} fill="none" stroke="var(--accent)" strokeWidth={2} /> : null}
                  </>
                )}
                {labeled.has(i) ? (
                  <text x={cx} y={ih + 16} textAnchor="middle">
                    {shortDate(p.origin)}
                  </text>
                ) : null}
              </g>
            );
          })}
          {pubSpan ? (
            <g>
              <path d={`M${pubSpan[0]},${ih + 6}v4H${pubSpan[1]}v-4`} fill="none" stroke="var(--axis)" strokeWidth={1} />
              <text x={pubSpan[1]} y={ih + 32} textAnchor="end">
                {pubKeys.length > 1 ? "Published runs" : "Published run"}
              </text>
            </g>
          ) : null}
          <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span className="legend-key">
          <span className="legend-line" style={{ background: "var(--series-vol)", height: 6, opacity: 0.7 }} /> 80% range
        </span>
        <span className="legend-key">
          <span className="legend-line" style={{ background: "var(--series-vol)", opacity: 0.35 }} /> 95% range
        </span>
        <span className="legend-key">
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="4" fill="var(--ink)" />
          </svg>
          Actual
        </span>
        <span className="legend-key">
          <svg width="12" height="12" aria-hidden="true">
            <circle cx="6" cy="6" r="4" fill="none" stroke="var(--ink)" strokeWidth="2" />
          </svg>
          Provisional actual
        </span>
        <span className="legend-key">
          <svg width="14" height="14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill="none" stroke="var(--accent)" strokeWidth="2" />
          </svg>
          Published run
        </span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function HistoryTable({ points, step }: { points: HistoryPoint[]; step: number }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Origin</th>
          <th className="num">Expected</th>
          <th className="num">80% range</th>
          <th className="num">95% range</th>
          <th className="num">Actual</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={`${p.origin}${p.published_run_id ?? ""}`}>
            <td>{p.published_run_id ? `${p.origin} (run ${p.published_run_id})` : p.origin}</td>
            <td className="num">{p.omitted_reason ? "withheld" : fmtVal(p.expected, step)}</td>
            <td className="num">{p.omitted_reason ? "" : `${p.i80[0]} to ${p.i80[1]}`}</td>
            <td className="num">{p.omitted_reason ? "" : `${p.i95[0]} to ${p.i95[1]}`}</td>
            <td className="num">{p.actual ?? ""}</td>
            <td>{p.actual_status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
