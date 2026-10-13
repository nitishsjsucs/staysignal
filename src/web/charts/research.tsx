// Research page charts (SPEC 16.2): the arm dot plot (each cell's mean observed over expected with its seed-bootstrap
// 90% interval against the equivalence band) and coverage by sigma (company and organizations, and teams). The
// handling each hypothesis expects to work is blue; the one it expects to fail is orange; labels name both.
import { scaleLinear } from "d3-scale";
import type { ResearchCell } from "../../shared/contracts";
import { TipRow, Tooltip, useTooltip, useWidth } from "./kit";

export const EXPECTED_TO_WORK = new Set(["matured", "censored", "deduplicated", "shock_aware", "matured_shock_aware"]);
export const HANDLING_LABEL: Record<string, string> = {
  matured: "matured",
  naive: "naive",
  censored: "censored",
  no_events: "no events",
  deduplicated: "deduplicated",
  not_deduplicated: "not deduplicated",
  shock_aware: "shock-aware",
  independence: "independence",
  matured_shock_aware: "matured + shock-aware",
  naive_independence: "naive + independence",
};
const color = (h: string) => (EXPECTED_TO_WORK.has(h) ? "var(--series-vol)" : "var(--series-inv)");
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function ArmDots({ cells, metric, band, title }: { cells: ResearchCell[]; metric: "oe" | "cov80"; band: [number, number]; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const rowH = 24;
  const labelW = Math.min(170, Math.max(120, width * 0.38));
  const h = cells.length * rowH + 44;
  const lo = (c: ResearchCell) => (metric === "oe" ? c.oe_lo90 : c.cov80_lo90);
  const hi = (c: ResearchCell) => (metric === "oe" ? c.oe_hi90 : c.cov80_hi90);
  const val = (c: ResearchCell) => (metric === "oe" ? c.oe : c.cov80);
  const values = cells.flatMap((c) => [lo(c), hi(c)]).concat(band);
  const x = scaleLinear()
    .domain([Math.min(...values) - 0.02, Math.max(...values) + 0.02])
    .range([0, Math.max(80, width - labelW - 16)])
    .nice();
  const fmt = metric === "oe" ? (v: number) => v.toFixed(2) : pct;
  const ref1 = metric === "oe" ? 1 : 0.8;
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={h} role="img" aria-label={`${title}: ${cells.map((c) => `${c.level} ${HANDLING_LABEL[c.handling] ?? c.handling} ${fmt(val(c))}`).join(", ")}`}>
        <text x={0} y={12} style={{ fill: "var(--ink)", fontWeight: 600 }}>
          {title}
        </text>
        <g transform={`translate(${labelW},0)`}>
          <rect x={x(band[0])} y={18} width={x(band[1]) - x(band[0])} height={h - 44} fill="var(--good)" fillOpacity={0.1} />
          {x.ticks(4).map((t) => (
            <g key={t}>
              <line className="grid-line" x1={x(t)} x2={x(t)} y1={18} y2={h - 26} />
              <text x={x(t)} y={h - 10} textAnchor="middle">
                {fmt(t)}
              </text>
            </g>
          ))}
          <line x1={x(ref1)} x2={x(ref1)} y1={18} y2={h - 26} stroke="var(--axis)" strokeDasharray="4 3" />
          {cells.map((c, i) => {
            const cy = 18 + i * rowH + rowH / 2;
            const eq = metric === "oe" ? c.oe_equivalent : c.cov80_equivalent;
            const p = metric === "oe" ? c.oe_tost_p : c.cov80_tost_p;
            return (
              <g
                key={`${c.level}-${c.handling}`}
                onPointerMove={(e) =>
                  show(
                    e,
                    <>
                      <div style={{ fontWeight: 600, marginBottom: 4 }}>
                        {c.level} · {HANDLING_LABEL[c.handling] ?? c.handling}
                      </div>
                      <TipRow name={metric === "oe" ? "Observed over expected" : "80% range held"} value={fmt(val(c))} swatch={color(c.handling)} />
                      <TipRow name="Seed bootstrap 90% interval" value={`${fmt(lo(c))} to ${fmt(hi(c))}`} />
                      <TipRow name="TOST p" value={p < 0.001 ? "< 0.001" : p.toFixed(3)} />
                      <TipRow name="Equivalence" value={eq ? "shown" : "not shown"} />
                      <TipRow name="Seeds" value={c.seeds} />
                    </>,
                  )
                }
                onPointerLeave={hide}
              >
                <rect x={-labelW} y={cy - rowH / 2} width={labelW + x.range()[1]!} height={rowH} fill="transparent" />
                <text x={-8} y={cy} dy="0.32em" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                  {c.level} · {HANDLING_LABEL[c.handling] ?? c.handling}
                </text>
                <line x1={x(lo(c))} x2={x(hi(c))} y1={cy} y2={cy} stroke={color(c.handling)} strokeWidth={2} />
                <circle cx={x(val(c))} cy={cy} r={eq ? 5 : 4.5} fill={eq ? color(c.handling) : "var(--surface)"} stroke={color(c.handling)} strokeWidth={2} />
              </g>
            );
          })}
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function CoverageBySigma({ cells, metric, title }: { cells: ResearchCell[]; metric: "cov80" | "team_cov80"; title: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const h = 220;
  const m = { top: 24, right: 16, bottom: 30, left: 40 };
  const iw = Math.max(120, width - m.left - m.right);
  const ih = h - m.top - m.bottom;
  const sigmas = ["0", "0.25", "0.5"];
  const x = scaleLinear().domain([0, 0.5]).range([0, iw]);
  const y = scaleLinear().domain([0.4, 1]).range([ih, 0]);
  const series = ["independence", "shock_aware"].map((hd) => ({
    handling: hd,
    points: sigmas.map((s) => cells.find((c) => c.factor === "C" && c.level === s && c.handling === hd)).flatMap((c) => (c && c[metric] !== null ? [{ s: Number(c.level), v: c[metric] as number, c }] : [])),
  }));
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={h} role="img" aria-label={`${title}: ${series.map((s) => `${HANDLING_LABEL[s.handling]} ${s.points.map((p) => pct(p.v)).join(", ")}`).join("; ")}`}>
        <text x={0} y={12} style={{ fill: "var(--ink)", fontWeight: 600 }}>
          {title}
        </text>
        <g transform={`translate(${m.left},${m.top})`}>
          <rect x={0} y={y(0.85)} width={iw} height={y(0.75) - y(0.85)} fill="var(--good)" fillOpacity={0.1} />
          {[0.4, 0.6, 0.8, 1].map((t) => (
            <g key={t}>
              <line className="grid-line" x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">
                {pct(t).replace(".0", "")}
              </text>
            </g>
          ))}
          {sigmas.map((s) => (
            <text key={s} x={x(Number(s))} y={ih + 18} textAnchor="middle">
              sigma {s}
            </text>
          ))}
          {series.map((s) => (
            <g key={s.handling}>
              <path d={s.points.map((p, i) => `${i ? "L" : "M"}${x(p.s)},${y(Math.max(0.4, p.v))}`).join("")} fill="none" stroke={color(s.handling)} strokeWidth={2} />
              {s.points.map((p) => (
                <g key={p.s} onPointerMove={(e) => show(e, <><TipRow name={`${HANDLING_LABEL[s.handling]}, sigma ${p.s}`} value={pct(p.v)} swatch={color(s.handling)} />{metric === "team_cov80" && p.c.team_pit_ks !== null ? <TipRow name="PIT distance (KS)" value={p.c.team_pit_ks.toFixed(3)} /> : null}</>)} onPointerLeave={hide}>
                  <circle cx={x(p.s)} cy={y(Math.max(0.4, p.v))} r={10} fill="transparent" />
                  <circle cx={x(p.s)} cy={y(Math.max(0.4, p.v))} r={4.5} fill={color(s.handling)} stroke="var(--surface)" strokeWidth={2} />
                </g>
              ))}
              {s.points.length ? (
                <text x={x(s.points[s.points.length - 1]!.s) - 6} y={y(Math.max(0.4, s.points[s.points.length - 1]!.v)) - 10} textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                  {HANDLING_LABEL[s.handling]}
                </text>
              ) : null}
            </g>
          ))}
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}
