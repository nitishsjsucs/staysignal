// Trust page charts (SPEC 16.1): the monthly backtest timeline, the reliability diagram, interval coverage against
// nominal, the model comparison small multiples and the count PIT histogram. SVG with d3-scale and d3-shape; values
// and labels use text tokens; every chart has a hover layer and a table view in its card. Synthetic world only.
import { scaleBand, scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import type { EvaluationEntry } from "../../shared/contracts";
import { fmtVal, niceTicks, shortDate, TipRow, Tooltip, useTooltip, useWidth } from "./kit";

export const MODEL_COLORS: Record<string, string> = {
  "dtcr-mnl": "var(--series-vol)",
  hist: "var(--series-other)",
  aj: "var(--series-inv)",
  oracle: "var(--series-ret)",
  survivalboost: "var(--series-challenger)",
  "survivalboost-shock": "var(--series-challenger)",
  "dtcr-mnl-12k": "var(--series-like)",
};
export const MODEL_LABELS: Record<string, string> = {
  "dtcr-mnl": "Competing-risks model",
  hist: "Trailing rate (status quo)",
  aj: "Aalen-Johansen marginal",
  oracle: "Oracle (knows the truth)",
  survivalboost: "SurvivalBoost challenger (12,000 rows)",
  "survivalboost-shock": "SurvivalBoost with shared shocks",
  "dtcr-mnl-12k": "Competing-risks model on the same 12,000 rows",
};

const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;

/** Question: over two years, did forecasts track actual departures? */
export function BacktestTimeline({ entries, height = 260 }: { entries: EvaluationEntry[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const pts = [...entries].sort((a, b) => a.origin.localeCompare(b.origin));
  const m = { top: 12, right: 16, bottom: 30, left: 40 };
  const iw = Math.max(120, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const ymax = Math.max(1, ...pts.map((p) => Math.max(p.i95[1], p.actual)));
  const ticks = niceTicks(ymax);
  const x = scaleBand<string>().domain(pts.map((p) => p.origin)).range([0, iw]).padding(0.2);
  const cx = (p: EvaluationEntry) => (x(p.origin) ?? 0) + x.bandwidth() / 2;
  const y = scaleLinear().domain([0, ticks[ticks.length - 1]!]).range([ih, 0]);
  const band = (lo: (p: EvaluationEntry) => number, hi: (p: EvaluationEntry) => number) =>
    area<EvaluationEntry>().x(cx).y0((p) => y(lo(p))).y1((p) => y(hi(p))).curve(curveMonotoneX)(pts) ?? "";
  const mid = line<EvaluationEntry>().x(cx).y((p) => y(p.expected)).curve(curveMonotoneX)(pts) ?? "";
  const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(iw / 70))));
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Backtest timeline: ${pts.length} monthly origins, expected against actual voluntary departures`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <path d={band((p) => p.i95[0], (p) => p.i95[1])} fill="var(--series-vol-band95)" />
          <path d={band((p) => p.i80[0], (p) => p.i80[1])} fill="var(--series-vol-band80)" />
          <path d={mid} fill="none" stroke="var(--series-vol)" strokeWidth={2} />
          {pts.map((p, i) => (
            <g key={p.origin} onPointerMove={(e) => show(e, (
              <>
                <div className="tt-title">Origin {p.origin}, next {p.horizon_months} month{p.horizon_months > 1 ? "s" : ""}</div>
                <TipRow name="Expected" value={fmtVal(p.expected, 0.1)} line="var(--series-vol)" />
                <TipRow name="80% range" value={`${p.i80[0]} to ${p.i80[1]}`} />
                <TipRow name="95% range" value={`${p.i95[0]} to ${p.i95[1]}`} />
                <TipRow name={p.status === "mature" ? "Actual" : `Actual (${p.status})`} value={p.status === "pending" ? "pending" : p.actual} />
              </>
            ))} onPointerLeave={hide}>
              <rect x={x(p.origin)} y={0} width={x.bandwidth()} height={ih} fill="transparent" />
              {p.status !== "pending" ? (
                <circle cx={cx(p)} cy={y(p.actual)} r={4.5} fill={p.status === "mature" ? "var(--ink)" : "var(--surface)"} stroke={p.status === "mature" ? "var(--surface)" : "var(--ink)"} strokeWidth={2} />
              ) : null}
              {i % every === 0 ? (
                <text x={cx(p)} y={ih + 18} textAnchor="middle">
                  {shortDate(p.origin)}
                </text>
              ) : null}
            </g>
          ))}
          <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span className="legend-key"><span className="legend-line" style={{ background: "var(--series-vol)" }} /> Expected</span>
        <span className="legend-key"><span className="legend-swatch" style={{ background: "var(--series-vol-band80)" }} /> 80% range</span>
        <span className="legend-key"><span className="legend-swatch" style={{ background: "var(--series-vol-band95)" }} /> 95% range</span>
        <span className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="var(--ink)" /></svg>Actual (mature)</span>
        <span className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="none" stroke="var(--ink)" strokeWidth="2" /></svg>Provisional</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

interface Bin {
  bin: number;
  n: number;
  predicted: number;
  observed: number;
  observed_i80: [number, number];
}

/** Question: when the model says 5%, do about 5% leave? */
export function ReliabilityDiagram({ bins, height = 280 }: { bins: Bin[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 12, right: 16, bottom: 36, left: 48 };
  const side = Math.min(Math.max(160, width - m.left - m.right), height - m.top - m.bottom);
  const top = Math.max(0.01, ...bins.map((b) => Math.max(b.predicted, b.observed_i80[1]))) * 1.1;
  const s = scaleLinear().domain([0, top]).range([0, side]);
  const ticks = s.ticks(4);
  const nmax = Math.max(1, ...bins.map((b) => b.n));
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={side + m.top + m.bottom} role="img" aria-label="Reliability diagram: observed against predicted 3-month voluntary departure probability by decile">
        <g transform={`translate(${m.left},${m.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={side} y1={side - s(t)} y2={side - s(t)} />
              <text x={-8} y={side - s(t)} dy="0.32em" textAnchor="end">{pct(t, 1)}</text>
              <text x={s(t)} y={side + 18} textAnchor="middle">{pct(t, 1)}</text>
            </g>
          ))}
          <line x1={0} y1={side} x2={side} y2={0} stroke="var(--axis)" strokeDasharray="4 4" />
          {bins.map((b) => (
            <g key={b.bin} onPointerMove={(e) => show(e, (
              <>
                <div className="tt-title">Decile {b.bin}</div>
                <TipRow name="Predicted" value={pct(b.predicted, 2)} />
                <TipRow name="Observed" value={pct(b.observed, 2)} swatch="var(--series-vol)" />
                <TipRow name="80% interval" value={`${pct(b.observed_i80[0], 2)} to ${pct(b.observed_i80[1], 2)}`} />
                <TipRow name="Person-windows" value={b.n.toLocaleString("en-US")} />
              </>
            ))} onPointerLeave={hide}>
              <line x1={s(b.predicted)} x2={s(b.predicted)} y1={side - s(b.observed_i80[0])} y2={side - s(b.observed_i80[1])} stroke="var(--series-vol)" strokeWidth={2} strokeOpacity={0.6} />
              <circle cx={s(b.predicted)} cy={side - s(b.observed)} r={4 + 6 * Math.sqrt(b.n / nmax)} fill="var(--series-vol)" fillOpacity={0.85} stroke="var(--surface)" strokeWidth={2} />
            </g>
          ))}
          <line className="axis-line" x1={0} x2={side} y1={side} y2={side} />
          <text x={side / 2} y={side + 32} textAnchor="middle">Predicted probability</text>
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="var(--series-vol)" /></svg>Observed share by decile (size: person-windows)</span>
        <span className="legend-key"><span className="legend-line" style={{ background: "var(--axis)" }} /> Perfect calibration</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export interface CoverageRow {
  key: string;
  label: string;
  model: string;
  coverage80: number;
  coverage95: number;
  ci80?: [number, number];
  note: string;
}

/** Question: do our ranges contain the truth as often as they claim? */
export function CoverageDots({ rows }: { rows: CoverageRow[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const labelW = Math.min(240, Math.max(130, width * 0.38));
  const rowH = 30;
  const height = rows.length * rowH + 30;
  const iw = Math.max(80, width - labelW - 20);
  const x = scaleLinear().domain([0.4, 1]).range([0, iw]);
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Interval coverage against nominal 80% and 95%">
        <g transform={`translate(${labelW},6)`}>
          {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t)} x2={x(t)} y1={0} y2={rows.length * rowH} />
              <text x={x(t)} y={rows.length * rowH + 16} textAnchor="middle">{pct(t)}</text>
            </g>
          ))}
          {[0.8, 0.95].map((t) => (
            <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={rows.length * rowH} stroke="var(--axis)" strokeDasharray="4 3" />
          ))}
          {rows.map((r, i) => {
            const cy = i * rowH + rowH / 2;
            return (
              <g key={r.key} onPointerMove={(e) => show(e, (
                <>
                  <div className="tt-title">{r.label}</div>
                  <TipRow name="80% range held" value={pct(r.coverage80, 1)} swatch={MODEL_COLORS[r.model]} />
                  {r.ci80 ? <TipRow name="Block bootstrap 80% interval" value={`${pct(r.ci80[0])} to ${pct(r.ci80[1])}`} /> : null}
                  <TipRow name="95% range held" value={pct(r.coverage95, 1)} />
                  <div style={{ marginTop: 4, color: "var(--muted)" }}>{r.note}</div>
                </>
              ))} onPointerLeave={hide}>
                <rect x={-labelW} y={cy - rowH / 2} width={labelW + iw} height={rowH} fill="transparent" />
                <text x={-10} y={cy} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink-2)" }}>{r.label}</text>
                {r.ci80 ? <line x1={x(Math.max(0.4, r.ci80[0]))} x2={x(r.ci80[1])} y1={cy} y2={cy} stroke={MODEL_COLORS[r.model]} strokeWidth={2} strokeOpacity={0.5} /> : null}
                <rect x={x(Math.max(0.4, r.coverage95)) - 5.5} y={cy - 5.5} width={11} height={11} fill="var(--surface)" stroke={MODEL_COLORS[r.model]} strokeWidth={2} />
                <circle cx={x(Math.max(0.4, r.coverage80))} cy={cy} r={4} fill={MODEL_COLORS[r.model]} />
              </g>
            );
          })}
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        <span className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="var(--ink-2)" /></svg>80% range held</span>
        <span className="legend-key"><svg width="12" height="12"><rect x="2" y="2" width="8" height="8" fill="none" stroke="var(--ink-2)" strokeWidth="2" /></svg>95% range held</span>
        <span className="legend-key"><span className="legend-line" style={{ background: "var(--axis)" }} /> Nominal 80% and 95%</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export interface MetricDot {
  model: string;
  value: number;
}

/** One small multiple of the model comparison: a dot per model on a shared metric axis (never a dual axis). */
/** Variants drawn hollow in their model's color (same model, different intervals), so color is never the only cue. */
export const HOLLOW = new Set(["survivalboost-shock"]);

export const MODEL_SHORT: Record<string, string> = { "dtcr-mnl": "Model", hist: "Trailing rate", aj: "Aalen-Johansen", oracle: "Oracle", survivalboost: "SurvivalBoost", "survivalboost-shock": "SB + shocks", "dtcr-mnl-12k": "Model, 12k rows" };

export function MetricDots({ title, dots, reference, format, height, labels = false }: { title: string; dots: MetricDot[]; reference?: number; format: (v: number) => string; height?: number; labels?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const rowH = 26;
  const h = height ?? dots.length * rowH + 44;
  const labelW = labels ? 96 : 0;
  const values = dots.map((d) => d.value).concat(reference !== undefined ? [reference] : []);
  const lo = Math.min(0, ...values);
  const hi = Math.max(...values) * 1.1 || 1;
  const x = scaleLinear().domain([lo, hi]).range([0, Math.max(60, width - 44 - labelW)]).nice();
  const yb = scaleBand<string>().domain(dots.map((d) => d.model)).range([18, h - 26]).padding(0.3);
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={h} role="img" aria-label={`${title}: ${dots.map((d) => `${MODEL_LABELS[d.model]} ${format(d.value)}`).join(", ")}`}>
        <text x={0} y={12} style={{ fill: "var(--ink)", fontWeight: 600 }}>{title}</text>
        {labels
          ? dots.map((d) => (
              <text key={d.model} x={labelW - 6} y={(yb(d.model) ?? 0) + yb.bandwidth() / 2} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                {MODEL_SHORT[d.model] ?? d.model}
              </text>
            ))
          : null}
        <g transform={`translate(${12 + labelW},0)`}>
          {x.ticks(3).map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t)} x2={x(t)} y1={18} y2={h - 26} />
              <text x={x(t)} y={h - 10} textAnchor="middle">{format(t)}</text>
            </g>
          ))}
          {reference !== undefined ? <line x1={x(reference)} x2={x(reference)} y1={18} y2={h - 26} stroke="var(--axis)" strokeDasharray="4 3" /> : null}
          {dots.map((d) => (
            <g key={d.model} onPointerMove={(e) => show(e, <TipRow name={MODEL_LABELS[d.model] ?? d.model} value={format(d.value)} swatch={MODEL_COLORS[d.model]} />)} onPointerLeave={hide}>
              <rect x={0} y={yb(d.model)} width={x.range()[1]} height={yb.bandwidth()} fill="transparent" />
              {HOLLOW.has(d.model) ? (
                <circle cx={x(d.value)} cy={(yb(d.model) ?? 0) + yb.bandwidth() / 2} r={4.5} fill="var(--surface)" stroke={MODEL_COLORS[d.model]} strokeWidth={2} />
              ) : (
                <circle cx={x(d.value)} cy={(yb(d.model) ?? 0) + yb.bandwidth() / 2} r={5.5} fill={MODEL_COLORS[d.model]} stroke="var(--surface)" strokeWidth={2} />
              )}
            </g>
          ))}
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Question: are the predictive distributions calibrated as a whole? A flat histogram at 1/10 means yes. */
export function PitHistogram({ bins, height = 160 }: { bins: number[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 8, right: 8, bottom: 24, left: 36 };
  const iw = Math.max(80, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const x = scaleBand<number>().domain(bins.map((_, i) => i)).range([0, iw]).paddingInner(0.12);
  const y = scaleLinear().domain([0, Math.max(0.2, ...bins) * 1.1]).range([ih, 0]);
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`PIT histogram: ${bins.map((b) => b.toFixed(2)).join(", ")}`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {y.ticks(3).map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-6} y={y(t)} dy="0.32em" textAnchor="end">{t.toFixed(2)}</text>
            </g>
          ))}
          {bins.map((b, i) => (
            <rect key={i} x={x(i)} y={y(b)} width={x.bandwidth()} height={Math.max(0, ih - y(b))} rx={3} fill="var(--seq-4)" onPointerMove={(e) => show(e, <TipRow name={`${(i / 10).toFixed(1)} to ${((i + 1) / 10).toFixed(1)}`} value={b.toFixed(3)} swatch="var(--seq-4)" />)} onPointerLeave={hide} />
          ))}
          <line x1={0} x2={iw} y1={y(0.1)} y2={y(0.1)} stroke="var(--axis)" strokeDasharray="4 3" />
          <text x={0} y={ih + 16}>0</text>
          <text x={iw} y={ih + 16} textAnchor="end">1</text>
          <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Question: which conditions are associated with higher predicted risk (not causes)? One feature per panel. */
export function EffectLine({ label, points, binary = false, height = 170 }: { label: string; points: { x: number; cif: number; lo: number; hi: number }[]; binary?: boolean; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 22, right: 12, bottom: 24, left: 44 };
  const iw = Math.max(80, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const xs = points.map((p) => p.x);
  const x = binary ? scaleBand<number>().domain(xs).range([0, iw]).padding(0.5) : null;
  const xl = scaleLinear().domain([Math.min(...xs), Math.max(...xs)]).range([0, iw]);
  const px = (v: number) => (x ? (x(v) ?? 0) + x.bandwidth() / 2 : xl(v));
  const top = Math.max(...points.map((p) => p.hi)) * 1.15;
  const y = scaleLinear().domain([0, top]).range([ih, 0]).nice();
  const bandPath = area<{ x: number; lo: number; hi: number }>().x((p) => px(p.x)).y0((p) => y(p.lo)).y1((p) => y(p.hi)).curve(curveMonotoneX)(points) ?? "";
  const linePath = line<{ x: number; cif: number }>().x((p) => px(p.x)).y((p) => y(p.cif)).curve(curveMonotoneX)(points) ?? "";
  const fmtX = (v: number) => (binary ? (v ? "Yes" : "No") : Number.isInteger(v) ? String(v) : v.toFixed(2));
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`${label}: predicted 3-month departure probability from ${pct(points[0]!.cif, 1)} to ${pct(points[points.length - 1]!.cif, 1)}`}>
        <text x={0} y={12} style={{ fill: "var(--ink)", fontWeight: 600 }}>{label}</text>
        <g transform={`translate(${m.left},${m.top})`}>
          {y.ticks(3).map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-6} y={y(t)} dy="0.32em" textAnchor="end">{pct(t, 1)}</text>
            </g>
          ))}
          {binary ? (
            points.map((p) => (
              <g key={p.x}>
                <line x1={px(p.x)} x2={px(p.x)} y1={y(p.lo)} y2={y(p.hi)} stroke="var(--series-vol)" strokeWidth={6} strokeOpacity={0.35} strokeLinecap="round" />
                <circle cx={px(p.x)} cy={y(p.cif)} r={5} fill="var(--series-vol)" stroke="var(--surface)" strokeWidth={2} />
              </g>
            ))
          ) : (
            <>
              <path d={bandPath} fill="var(--series-vol-band80)" />
              <path d={linePath} fill="none" stroke="var(--series-vol)" strokeWidth={2} />
            </>
          )}
          {points.map((p) => (
            <g key={`t${p.x}`} onPointerMove={(e) => show(e, (
              <>
                <div className="tt-title">{label}: {fmtX(p.x)}</div>
                <TipRow name="Mean predicted 3-month probability" value={pct(p.cif, 2)} line="var(--series-vol)" />
                <TipRow name="80% band (parameters)" value={`${pct(p.lo, 2)} to ${pct(p.hi, 2)}`} />
              </>
            ))} onPointerLeave={hide}>
              <rect x={px(p.x) - 10} y={0} width={20} height={ih} fill="transparent" />
              <text x={px(p.x)} y={ih + 16} textAnchor="middle">{fmtX(p.x)}</text>
            </g>
          ))}
          <line className="axis-line" x1={0} x2={iw} y1={ih} y2={ih} />
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

