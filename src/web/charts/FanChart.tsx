// Fan chart (SPEC 16.2): cumulative expected voluntary departures over the next 6 months with 80% and 95% bands, the
// selected horizon marked, and "Other exits" as one grey line at company and organization level. Question: how do
// departures accumulate, and how wide is the range at each point?
import { scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import type { CurvePoint } from "../../shared/contracts";
import { fmtVal, monthEnding, niceTicks, TipRow, Tooltip, useTooltip, useWidth } from "./kit";

interface Props {
  curve: CurvePoint[];
  cutoff: string;
  horizon: number;
  step: number;
  showOther: boolean;
  height?: number;
}

export function FanChart({ curve, cutoff, horizon, step, showOther, height = 260 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const pts = [{ month: 0, date: cutoff, vol: 0, vol_lo80: 0, vol_hi80: 0, vol_lo95: 0, vol_hi95: 0, other: 0 }, ...curve];
  const m = { top: 12, right: 64, bottom: 28, left: 40 };
  const iw = Math.max(80, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const ymax = Math.max(...pts.map((p) => Math.max(p.vol_hi95, showOther ? (p.other ?? 0) : 0)), 1);
  const ticks = niceTicks(ymax);
  const x = scaleLinear().domain([0, 6]).range([0, iw]);
  const y = scaleLinear().domain([0, ticks[ticks.length - 1]!]).range([ih, 0]);
  const band = (lo: "vol_lo80" | "vol_lo95", hi: "vol_hi80" | "vol_hi95") =>
    area<(typeof pts)[number]>()
      .x((d) => x(d.month))
      .y0((d) => y(d[lo]))
      .y1((d) => y(d[hi]))
      .curve(curveMonotoneX)(pts) ?? "";
  const mid = line<(typeof pts)[number]>()
    .x((d) => x(d.month))
    .y((d) => y(d.vol))
    .curve(curveMonotoneX)(pts) ?? "";
  const other = line<(typeof pts)[number]>()
    .x((d) => x(d.month))
    .y((d) => y(d.other ?? 0))
    .curve(curveMonotoneX)(pts) ?? "";
  const h = pts.find((p) => p.month === horizon) ?? pts[pts.length - 1]!;
  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const mo = Math.max(0, Math.min(6, Math.round(((e.clientX - rect.left) / rect.width) * 6)));
    const p = pts[mo]!;
    if (mo === 0) return hide();
    show(e, (
      <>
        <div className="tt-title">
          By end of {monthEnding(p.date)} ({mo} month{mo > 1 ? "s" : ""})
        </div>
        <TipRow name="Expected voluntary" value={fmtVal(p.vol, step)} line="var(--series-vol)" />
        <TipRow name="80% range" value={`${p.vol_lo80} to ${p.vol_hi80}`} swatch="var(--series-vol-band80)" />
        <TipRow name="95% range" value={`${p.vol_lo95} to ${p.vol_hi95}`} swatch="var(--series-vol-band95)" />
        {showOther && p.other !== undefined ? <TipRow name="Other exits" value={fmtVal(p.other, step)} line="var(--series-other)" /> : null}
      </>
    ));
  };
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Fan chart: by month ${horizon}, ${fmtVal(h.vol, step)} expected voluntary departures, 80% range ${h.vol_lo80} to ${h.vol_hi80}`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path d={band("vol_lo95", "vol_hi95")} fill="var(--series-vol-band95)" />
          <path d={band("vol_lo80", "vol_hi80")} fill="var(--series-vol-band80)" />
          {showOther ? <path d={other} fill="none" stroke="var(--series-other)" strokeWidth={2} /> : null}
          <path d={mid} fill="none" stroke="var(--series-vol)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          <line x1={x(h.month)} x2={x(h.month)} y1={0} y2={ih} stroke="var(--axis)" strokeWidth={1} />
          <circle cx={x(h.month)} cy={y(h.vol)} r={4.5} fill="var(--series-vol)" stroke="var(--surface)" strokeWidth={2} />
          <text x={x(h.month) + 8} y={y(h.vol)} dy="0.32em" style={{ fill: "var(--ink)", fontWeight: 600 }}>
            {fmtVal(h.vol, step)}
          </text>
          {pts.map((p) => (
            <text key={p.month} x={x(p.month)} y={ih + 18} textAnchor={p.month === 0 ? "start" : "middle"}>
              {p.month === 0 ? "Cutoff" : monthEnding(p.date)}
            </text>
          ))}
          <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
          {showOther ? (
            <text x={iw + 6} y={y(pts[6]?.other ?? 0)} dy="0.32em">
              Other
            </text>
          ) : null}
          <rect x={0} y={0} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={hide} />
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span className="legend-key">
          <span className="legend-line" style={{ background: "var(--series-vol)" }} /> Expected voluntary departures (cumulative)
        </span>
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: "var(--series-vol-band80)" }} /> 80% range
        </span>
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: "var(--series-vol-band95)" }} /> 95% range
        </span>
        {showOther ? (
          <span className="legend-key">
            <span className="legend-line" style={{ background: "var(--series-other)" }} /> Other exits (modeled as competing events; not a forecast of decisions)
          </span>
        ) : null}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function FanTable({ curve, step }: { curve: CurvePoint[]; step: number }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>By end of</th>
          <th className="num">Expected</th>
          <th className="num">80% range</th>
          <th className="num">95% range</th>
          <th className="num">Other exits</th>
        </tr>
      </thead>
      <tbody>
        {curve.map((p) => (
          <tr key={p.month}>
            <td>{monthEnding(p.date)}</td>
            <td className="num">{fmtVal(p.vol, step)}</td>
            <td className="num">
              {p.vol_lo80} to {p.vol_hi80}
            </td>
            <td className="num">
              {p.vol_lo95} to {p.vol_hi95}
            </td>
            <td className="num">{p.other !== undefined ? fmtVal(p.other, step) : "not shown"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
