// Bar-based charts: the variance decomposition bar, cohort breakdown bars with interval whiskers (sorted by name,
// never ranked), and the what-changed waterfall drawn against the width of the 80% interval.
import { scaleBand, scaleLinear } from "d3-scale";
import type { BreakdownRow, FactorBar } from "../../shared/contracts";
import { fmtVal, niceTicks, TipRow, Tooltip, useTooltip, useWidth } from "./kit";

const VAR_PARTS: { key: "parameter" | "org_shock" | "team_shock" | "process"; label: string; color: string }[] = [
  { key: "process", label: "Individual outcomes", color: "var(--seq-4)" },
  { key: "team_shock", label: "Team shocks", color: "var(--seq-6)" },
  { key: "org_shock", label: "Company-wide shocks", color: "var(--seq-2)" },
  { key: "parameter", label: "Model parameters", color: "var(--seq-5)" },
];

/** Question: why is the range as wide as it is? Shares of variance, rounded to 5 points. */
export function VarianceBar({ variance }: { variance: Record<string, number> }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const total = VAR_PARTS.reduce((s, p) => s + (variance[p.key] ?? 0), 0) || 100;
  let x0 = 0;
  const h = 18;
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={h} role="img" aria-label={`Variance shares: ${VAR_PARTS.map((p) => `${p.label} ${variance[p.key] ?? 0}%`).join(", ")}`}>
        {VAR_PARTS.map((p) => {
          const w = ((variance[p.key] ?? 0) / total) * width;
          const r = (
            <rect key={p.key} x={x0} y={0} width={Math.max(0, w - 2)} height={h} rx={3} fill={p.color} onPointerMove={(e) => show(e, <TipRow name={p.label} value={`${variance[p.key] ?? 0}%`} swatch={p.color} />)} onPointerLeave={hide} />
          );
          x0 += w;
          return r;
        })}
      </svg>
      <div className="chart-legend">
        {VAR_PARTS.map((p) => (
          <span key={p.key} className="legend-key">
            <span className="legend-swatch" style={{ background: p.color }} />
            {p.label} <span className="num" style={{ color: "var(--ink)", fontWeight: 600 }}>{variance[p.key] ?? 0}%</span>
          </span>
        ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** Question: which parts of the organization contribute to the expected count? Sorted by name. */
export function BreakdownBars({ rows, horizon }: { rows: BreakdownRow[]; horizon: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const labelW = Math.min(200, Math.max(110, width * 0.32));
  const rowH = 30;
  const height = rows.length * rowH + 24;
  const max = Math.max(1, ...rows.map((r) => r.i80?.[1] ?? r.expected ?? 0));
  const ticks = niceTicks(max, 4);
  const x = scaleLinear().domain([0, ticks[ticks.length - 1]!]).range([0, Math.max(60, width - labelW - 48)]);
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Expected voluntary departures over ${horizon} months by part of the cohort`}>
        <g transform={`translate(${labelW},4)`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t)} x2={x(t)} y1={0} y2={rows.length * rowH} />
              <text x={x(t)} y={rows.length * rowH + 14} textAnchor="middle">
                {t}
              </text>
            </g>
          ))}
          {rows.map((r, i) => {
            const cy = i * rowH + rowH / 2;
            return (
              <g key={r.cohort_id} onPointerMove={(e) => show(e, r.suppressed ? <div>{r.cohort}: suppressed to protect a small group</div> : (
                <>
                  <div className="tt-title">{r.cohort} (n {r.n})</div>
                  <TipRow name="Expected" value={fmtVal(r.expected ?? 0, r.n >= 200 ? 0.1 : r.n >= 50 ? 0.5 : 1)} />
                  <TipRow name="80% range" value={r.i80 ? `${r.i80[0]} to ${r.i80[1]}` : ""} />
                  <TipRow name="Annualized rate" value={r.rate !== null ? `${(r.rate * 100).toFixed(1)}%` : ""} />
                </>
              ))} onPointerLeave={hide}>
                <rect x={-labelW} y={i * rowH} width={labelW + x.range()[1]! + 40} height={rowH} fill="transparent" />
                <text x={-10} y={cy} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                  {r.cohort.length > 26 ? `${r.cohort.slice(0, 25)}...` : r.cohort}
                </text>
                {r.suppressed || r.expected === null ? (
                  <text x={4} y={cy} dy="0.32em">
                    suppressed
                  </text>
                ) : (
                  <>
                    <rect x={0} y={cy - 7} width={Math.max(2, x(r.expected))} height={14} rx={3} fill="var(--series-vol)" />
                    {r.i80 ? <line x1={x(r.i80[0])} x2={x(r.i80[1])} y1={cy} y2={cy} stroke="var(--ink-2)" strokeWidth={1.5} /> : null}
                    {r.i80 ? <line x1={x(r.i80[1])} x2={x(r.i80[1])} y1={cy - 4} y2={cy + 4} stroke="var(--ink-2)" strokeWidth={1.5} /> : null}
                    <text x={x(Math.max(r.expected, r.i80?.[1] ?? 0)) + 6} y={cy} dy="0.32em" style={{ fill: "var(--ink)" }}>
                      {fmtVal(r.expected, r.n >= 200 ? 0.1 : r.n >= 50 ? 0.5 : 1)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function BreakdownTable({ rows }: { rows: BreakdownRow[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Cohort</th>
          <th className="num">People</th>
          <th className="num">Expected</th>
          <th className="num">80% range</th>
          <th className="num">Annualized rate</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.cohort_id}>
            <td>{r.cohort}</td>
            <td className="num">{r.n}</td>
            <td className="num">{r.suppressed ? "suppressed" : (r.expected ?? "")}</td>
            <td className="num">{r.i80 ? `${r.i80[0]} to ${r.i80[1]}` : ""}</td>
            <td className="num">{r.rate !== null ? `${(r.rate * 100).toFixed(1)}%` : ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Question: why does this forecast differ from the last one, and is the change big relative to the uncertainty? */
export function Waterfall({ from, to, factors, width80, step, fromLabel, toLabel }: { from: number; to: number; factors: FactorBar[]; width80: number; step: number; fromLabel: string; toLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const height = 300;
  const m = { top: 16, right: 16, bottom: 70, left: 44 };
  const iw = Math.max(200, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const steps: { key: string; label: string; base: number; value: number; kind: "total" | "delta"; merged: string[] }[] = [];
  steps.push({ key: "from", label: fromLabel, base: 0, value: from, kind: "total", merged: [] });
  let acc = from;
  for (const f of factors) {
    steps.push({ key: f.factor, label: f.label.replace(/ \(.*\)$/, ""), base: acc, value: f.phi, kind: "delta", merged: f.merged_from });
    acc += f.phi;
  }
  steps.push({ key: "to", label: toLabel, base: 0, value: to, kind: "total", merged: [] });
  const lo = Math.min(0, ...steps.map((s) => Math.min(s.base, s.base + s.value)), to - width80 / 2);
  const hi = Math.max(...steps.map((s) => Math.max(s.base, s.base + s.value)), to + width80 / 2);
  const ticks = niceTicks(hi, 4);
  const y = scaleLinear().domain([Math.min(0, lo), ticks[ticks.length - 1]!]).range([ih, 0]);
  const x = scaleBand<string>().domain(steps.map((s) => s.key)).range([0, iw]).paddingInner(0.35).paddingOuter(0.15);
  const bw = Math.min(56, x.bandwidth());
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Waterfall from ${fmtVal(from, step)} to ${fmtVal(to, step)} by factor`}>
        <g transform={`translate(${m.left},${m.top})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          <rect x={0} y={y(to + width80 / 2)} width={iw} height={Math.max(1, y(to - width80 / 2) - y(to + width80 / 2))} fill="var(--series-vol-wash)" />
          <text x={iw - 4} y={y(to + width80 / 2) + 12} textAnchor="end">
            width of the 80% range of the current run
          </text>
          {steps.map((s, i) => {
            const top = y(Math.max(s.base, s.base + s.value));
            const bottom = y(Math.min(s.base, s.base + s.value));
            const cx = (x(s.key) ?? 0) + x.bandwidth() / 2;
            const color = s.kind === "total" ? "var(--ink-3)" : s.value > 0 ? "var(--div-pos)" : "var(--div-neg)";
            const next = steps[i + 1];
            return (
              <g key={s.key} onPointerMove={(e) => show(e, (
                <>
                  <div className="tt-title">{s.label}</div>
                  <TipRow name={s.kind === "total" ? "Expected voluntary departures" : "Contribution"} value={`${s.kind === "delta" && s.value > 0 ? "+" : ""}${fmtVal(s.value, step)}`} swatch={color} />
                  {s.merged.length ? <div style={{ marginTop: 4, color: "var(--ink-3)" }}>Merged: {s.merged.join(", ")} (fewer than 10 people changed)</div> : null}
                </>
              ))} onPointerLeave={hide}>
                <rect x={cx - bw / 2 - 6} y={0} width={bw + 12} height={ih} fill="transparent" />
                <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(2, bottom - top)} rx={3} fill={color} />
                <text x={cx} y={top - 6} textAnchor="middle" style={{ fill: "var(--ink)", fontWeight: 600 }}>
                  {s.kind === "delta" && s.value > 0 ? "+" : ""}
                  {fmtVal(s.value, step)}
                </text>
                {next && next.kind === "delta" ? <line x1={cx + bw / 2} x2={(x(next.key) ?? 0) + x.bandwidth() / 2 - bw / 2} y1={y(s.kind === "total" ? s.value : s.base + s.value)} y2={y(s.kind === "total" ? s.value : s.base + s.value)} stroke="var(--axis)" /> : null}
                <foreignObject x={cx - x.step() / 2} y={ih + 6} width={x.step()} height={60}>
                  <div style={{ fontSize: 11, color: "var(--ink-2)", textAlign: "center", lineHeight: 1.25 }}>{softHyphens(s.label)}</div>
                </foreignObject>
              </g>
            );
          })}
          <line className="axis-line" x1={0} x2={iw} y1={y(0)} y2={y(0)} />
        </g>
      </svg>
      <div className="chart-legend waterfall-legend" aria-hidden="true">
        <span className="legend-key">
          <span className="legend-swatch pos" /> Raises expected departures
        </span>
        <span className="legend-key">
          <span className="legend-swatch neg" /> Lowers expected departures
        </span>
        <span className="legend-key">
          <span className="legend-swatch" style={{ background: "var(--series-vol-wash)" }} /> 80% range width
        </span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

// Waterfall columns can be narrower than a factor name: break long words only at a syllable (a soft hyphen shows as
// "Compo-" when the word wraps and is invisible otherwise), never mid-syllable as overflow-wrap would.
const SYLLABLES: Record<string, string> = { Composition: "Compo\u00adsition", Definition: "Defi\u00adnition", Calendar: "Calen\u00addar", Previous: "Previ\u00adous" };

export function softHyphens(label: string): string {
  return label.replace(/[A-Za-z]+/g, (w) => SYLLABLES[w] ?? w);
}
