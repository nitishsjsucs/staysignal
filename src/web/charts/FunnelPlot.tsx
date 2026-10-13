// Funnel plot (SPEC 16.2): each cohort's observed over expected departures in one mature backtest window, against its
// expected count, with 95% and 99.8% Poisson limits that narrow as cohorts grow. Answers "which cohorts are unusual
// once size is taken into account?" without ranking anyone. Points outside the 95% limits are labeled; the rest are
// in the tooltip and the table view.
import { scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import type { FunnelPoint } from "../../shared/contracts";
import { funnelLimits, funnelVerdict, Z95, Z998 } from "../../shared/stats/funnel";
import { TipRow, Tooltip, useTooltip, useWidth } from "./kit";

const VERDICT: Record<string, string> = { inside: "inside the 95% limits", outside95: "outside the 95% limits", outside998: "outside the 99.8% limits" };

export function FunnelPlot({ points, height = 300 }: { points: FunnelPoint[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 12, right: 16, bottom: 36, left: 44 };
  const iw = Math.max(120, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const xmax = Math.max(4, ...points.map((p) => p.expected)) * 1.08;
  const ymax = Math.max(2, ...points.map((p) => p.oe)) * 1.08;
  const x = scaleLinear().domain([0, xmax]).range([0, iw]).nice();
  const y = scaleLinear().domain([0, ymax]).range([ih, 0]).nice();
  const grid = Array.from({ length: 80 }, (_, i) => 0.6 + (i / 79) * (x.domain()[1]! - 0.6));
  // labels for points outside the 95% limits, nudged apart so two points at the same place stay readable
  const labels = new Map<string, { x: number; y: number; anchor: "start" | "end" }>();
  const taken: { x: number; y: number }[] = [];
  for (const p of [...points].filter((q) => funnelVerdict(q.observed, q.expected) !== "inside").sort((a, b) => a.oe - b.oe || a.cohort.localeCompare(b.cohort))) {
    const px = x(p.expected);
    let ly = y(Math.min(p.oe, y.domain()[1]!));
    while (taken.some((o) => Math.abs(o.x - px) < 120 && Math.abs(o.y - ly) < 13)) ly -= 13;
    taken.push({ x: px, y: ly });
    labels.set(p.cohort, { x: px > iw - 130 ? px - 8 : px + 8, y: ly, anchor: px > iw - 130 ? "end" : "start" });
  }
  const curve = (z: number, side: 0 | 1) =>
    line<number>()
      .x((e) => x(e))
      .y((e) => y(Math.min(y.domain()[1]!, funnelLimits(e, z)[side])))(grid) ?? "";
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Funnel plot of ${points.length} cohorts: observed over expected departures against expected count, with 95% and 99.8% limits`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {y.ticks(4).map((t) => (
            <g key={`y${t}`}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {t.toFixed(1)}
              </text>
            </g>
          ))}
          {x.ticks(5).map((t) => (
            <text key={`x${t}`} x={x(t)} y={ih + 18} textAnchor="middle">
              {t}
            </text>
          ))}
          <text x={iw / 2} y={ih + 32} textAnchor="middle" style={{ fill: "var(--ink-3)" }}>
            expected departures in the window
          </text>
          <line x1={0} x2={iw} y1={y(1)} y2={y(1)} stroke="var(--axis)" strokeDasharray="4 3" />
          {[0, 1].map((side) => (
            <g key={side}>
              <path d={curve(Z95, side as 0 | 1)} fill="none" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="5 3" />
              <path d={curve(Z998, side as 0 | 1)} fill="none" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="1.5 3" />
            </g>
          ))}
          {points.map((p) => {
            const v = funnelVerdict(p.observed, p.expected);
            const cx = x(p.expected);
            const cy = y(Math.min(p.oe, y.domain()[1]!));
            return (
              <g
                key={p.cohort}
                onPointerMove={(e) =>
                  show(
                    e,
                    <>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>{p.name}</div>
                      <TipRow name="Observed" value={p.observed} />
                      <TipRow name="Expected" value={p.expected.toFixed(1)} />
                      <TipRow name="Observed over expected" value={p.oe.toFixed(2)} swatch="var(--series-vol)" />
                      <TipRow name="People" value={p.n.toLocaleString("en-US")} />
                      <div style={{ marginTop: 4, color: "var(--muted)" }}>{VERDICT[v]}</div>
                    </>,
                  )
                }
                onPointerLeave={hide}
              >
                <circle cx={cx} cy={cy} r={12} fill="transparent" />
                <circle cx={cx} cy={cy} r={p.level === "group" ? 4.5 : 5.5} fill={p.level === "group" ? "var(--surface)" : "var(--series-vol)"} stroke={p.level === "group" ? "var(--series-vol)" : "var(--surface)"} strokeWidth={2} />
                {v !== "inside" && labels.get(p.cohort) ? (
                  <text x={labels.get(p.cohort)!.x} y={labels.get(p.cohort)!.y} dy="0.32em" textAnchor={labels.get(p.cohort)!.anchor} className="halo" style={{ fill: "var(--ink-2)" }}>
                    {p.name}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="chart-legend">
        <span className="legend-key">
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="4" fill="var(--series-vol)" />
          </svg>
          Company and organizations
        </span>
        <span className="legend-key">
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="3.5" fill="none" stroke="var(--series-vol)" strokeWidth={2} />
          </svg>
          Groups
        </span>
        <span className="legend-key">
          <svg width="22" height="12">
            <line x1="1" x2="21" y1="6" y2="6" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="5 3" />
          </svg>
          95% limits
        </span>
        <span className="legend-key">
          <svg width="22" height="12">
            <line x1="1" x2="21" y1="6" y2="6" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="1.5 3" />
          </svg>
          99.8% limits
        </span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function FunnelTable({ points }: { points: FunnelPoint[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Cohort</th>
          <th className="num">People</th>
          <th className="num">Expected</th>
          <th className="num">Observed</th>
          <th className="num">Observed over expected</th>
          <th>Against the limits</th>
        </tr>
      </thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.cohort}>
            <td>{p.name}</td>
            <td className="num">{p.n.toLocaleString("en-US")}</td>
            <td className="num">{p.expected.toFixed(1)}</td>
            <td className="num">{p.observed}</td>
            <td className="num">{p.oe.toFixed(2)}</td>
            <td>{VERDICT[funnelVerdict(p.observed, p.expected)]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
