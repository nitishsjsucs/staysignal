// Trace gantt (SPEC 16.2, Traces): where the time went in one answer and what was checked. One row per span (the
// pre-router, model calls, tool calls, the grounding check, a repair or the template), a bar from its start to its
// end on a shared millisecond axis, direct labels with the duration and outcome, hover details and a table view.
// A single neutral hue: span kinds are told apart by their labels, not by color (dataviz rules).
import type { ReactNode } from "react";
import { niceTicks, TipRow, Tooltip, useTooltip, useWidth } from "./kit";

export interface Span {
  kind: string;
  name: string;
  start_ms: number;
  dur_ms: number;
  tokens?: { input: number | null; output: number | null; cached: number | null };
  outcome?: string;
  result_ids?: string[];
}

const ROW = 26;
const TOP = 8;
const AXIS = 22;

function tokensText(t: Span["tokens"]): string | null {
  if (!t || (t.input === null && t.output === null)) return null;
  return `${t.input ?? 0} in, ${t.output ?? 0} out${t.cached ? `, ${t.cached} cached` : ""}`;
}

export function TraceGantt({ spans }: { spans: Span[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const { tip, show, hide } = useTooltip();
  const narrow = width < 520;
  const labelW = narrow ? 104 : 160;
  const end = Math.max(1, ...spans.map((s) => s.start_ms + s.dur_ms));
  const ticks = niceTicks(end, narrow ? 3 : 5);
  const max = ticks[ticks.length - 1] ?? end;
  const plotW = Math.max(60, width - labelW - 8);
  const x = (ms: number) => labelW + (ms / max) * plotW;
  const height = TOP + spans.length * ROW + AXIS;
  return (
    <div ref={ref} onMouseLeave={hide}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Trace with ${spans.length} spans over ${end} milliseconds`}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={x(t)} x2={x(t)} y1={TOP} y2={TOP + spans.length * ROW} />
            <text x={x(t)} y={height - 6} textAnchor="middle">
              {t} ms
            </text>
          </g>
        ))}
        {spans.map((s, i) => {
          const y = TOP + i * ROW;
          const x0 = x(s.start_ms);
          const w = Math.max(2, x(s.start_ms + s.dur_ms) - x0);
          const detail: ReactNode = (
            <>
              <div className="tt-title">
                {s.kind}: {s.name}
              </div>
              <TipRow name="Start" value={`${s.start_ms} ms`} />
              <TipRow name="Duration" value={`${s.dur_ms} ms`} />
              {tokensText(s.tokens) ? <TipRow name="Tokens" value={tokensText(s.tokens)} /> : null}
              {s.outcome ? <TipRow name="Outcome" value={s.outcome} /> : null}
              {s.result_ids?.length ? <TipRow name="Results" value={s.result_ids.join(", ")} /> : null}
            </>
          );
          return (
            <g key={`${s.kind}-${s.name}-${i}`} onMouseMove={(e) => show(e, detail)}>
              <rect x={0} y={y} width={width} height={ROW} fill="transparent" />
              <text x={labelW - 8} y={y + ROW / 2} dominantBaseline="middle" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                {narrow ? s.kind : `${s.kind}: ${s.name}`}
              </text>
              <rect x={x0} y={y + 7} width={w} height={ROW - 14} rx={2} fill="var(--ink-3)" />
              <text x={Math.min(x0 + w + 6, width - 4)} y={y + ROW / 2} dominantBaseline="middle" textAnchor={x0 + w + 80 > width ? "end" : "start"}>
                {s.dur_ms} ms{s.outcome ? ` · ${s.outcome}` : ""}
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function TraceTable({ spans }: { spans: Span[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Span</th>
          <th className="num">Start (ms)</th>
          <th className="num">Duration (ms)</th>
          <th>Tokens</th>
          <th>Outcome</th>
        </tr>
      </thead>
      <tbody>
        {spans.map((s, i) => (
          <tr key={`${s.kind}-${i}`}>
            <td>
              {s.kind}: {s.name}
            </td>
            <td className="num">{s.start_ms}</td>
            <td className="num">{s.dur_ms}</td>
            <td>{tokensText(s.tokens) ?? ""}</td>
            <td>{s.outcome ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
