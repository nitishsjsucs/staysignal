// Impact ratios of the action audit (SPEC 16.2, Governance): one small multiple per screen (tenure band, location and,
// for the auditor, the audit-only age flag), a dot per group at its selection rate divided by the highest group's,
// against the four-fifths line. Groups under the line carry a status pill (icon and label, never color alone); groups
// too small to screen are listed without a dot. One neutral hue for the dots; hover and a table view.
import type { AuditGroupRow } from "../../shared/contracts";
import { StatusPill } from "../components/ui";
import { TipRow, Tooltip, useTooltip, useWidth } from "./kit";

const ROW = 30;
const PAD = 26;

export const SCREEN_LABEL: Record<string, string> = { tenure_band: "Tenure band (proxy screen)", location: "Location (proxy screen)", age40: "Age 40 or over (audit-only attribute)" };

function pct(v: number | null): string {
  return v === null ? "" : `${(v * 100).toFixed(1)}%`;
}

export function ImpactRatios({ name, rows }: { name: string; rows: AuditGroupRow[] }) {
  const [ref, width] = useWidth<HTMLDivElement>(560);
  const { tip, show, hide } = useTooltip();
  const labelW = width < 480 ? 96 : 140;
  const plotW = Math.max(80, width - labelW - 16);
  const x = (r: number) => labelW + Math.min(1.1, Math.max(0, r)) / 1.1 * plotW;
  const height = PAD + rows.length * ROW + 18;
  return (
    <div ref={ref} onMouseLeave={hide} className="impact-multiple">
      <h3 className="impact-title">{SCREEN_LABEL[name] ?? name}</h3>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Impact ratios by ${name}`}>
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => (
          <g key={t}>
            <line className={t === 0.8 ? "axis-line" : "grid-line"} x1={x(t)} x2={x(t)} y1={PAD - 6} y2={PAD + rows.length * ROW} strokeDasharray={t === 0.8 ? "4 3" : undefined} />
            <text x={x(t)} y={height - 4} textAnchor="middle">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        <text x={x(0.8)} y={PAD - 10} textAnchor="middle">
          four-fifths
        </text>
        {rows.map((r, i) => {
          const y = PAD + i * ROW + ROW / 2;
          return (
            <g
              key={r.group}
              onMouseMove={(e) =>
                show(
                  e,
                  <>
                    <div className="tt-title">{r.group}</div>
                    <TipRow name="People" value={r.people.toLocaleString("en-US")} />
                    <TipRow name="Selection rate" value={r.too_small ? "too small to screen" : pct(r.rate)} />
                    <TipRow name="Impact ratio" value={r.ratio === null ? "n/a" : r.ratio.toFixed(2)} />
                    <TipRow name="Fisher p" value={r.fisher_p === null ? "n/a" : r.fisher_p < 0.001 ? "< 0.001" : r.fisher_p.toFixed(3)} />
                  </>,
                )
              }
            >
              <rect x={0} y={y - ROW / 2} width={width} height={ROW} fill="transparent" />
              <text x={labelW - 8} y={y} dominantBaseline="middle" textAnchor="end" style={{ fill: "var(--ink-2)" }}>
                {r.group}
              </text>
              {r.ratio === null ? (
                <text x={labelW + 4} y={y} dominantBaseline="middle">
                  too small to screen
                </text>
              ) : (
                <>
                  <line x1={x(0)} x2={x(r.ratio)} y1={y} y2={y} stroke="var(--grid)" strokeWidth={2} />
                  <circle cx={x(r.ratio)} cy={y} r={5} fill="var(--ink-2)" stroke="var(--surface)" strokeWidth={2} />
                  <text x={x(r.ratio) + 10} y={y} dominantBaseline="middle">
                    {r.ratio.toFixed(2)}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <div className="impact-flags">
        {rows
          .filter((r) => r.four_fifths_flag)
          .map((r) => (
            <StatusPill key={r.group} status="warning">
              {r.group}: below four-fifths{r.fisher_p !== null && r.fisher_p < 0.05 ? ", Fisher p < 0.05" : ""}
            </StatusPill>
          ))}
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export function ImpactTable({ screens }: { screens: Record<string, { rows: AuditGroupRow[] }> }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Screen</th>
          <th>Group</th>
          <th className="num">People</th>
          <th className="num">Share of population</th>
          <th className="num">Share of attention</th>
          <th className="num">Selection rate</th>
          <th className="num">Impact ratio</th>
          <th className="num">Fisher p</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(screens).flatMap(([name, s]) =>
          s.rows.map((r) => (
            <tr key={`${name}-${r.group}`}>
              <td>{SCREEN_LABEL[name] ?? name}</td>
              <td>{r.group}</td>
              <td className="num">{r.people.toLocaleString("en-US")}</td>
              <td className="num">{pct(r.population_share)}</td>
              <td className="num">{pct(r.attention_share)}</td>
              <td className="num">{r.too_small ? "" : pct(r.rate)}</td>
              <td className="num">{r.ratio === null ? "" : r.ratio.toFixed(2)}</td>
              <td className="num">{r.fisher_p === null ? "" : r.fisher_p < 0.001 ? "< 0.001" : r.fisher_p.toFixed(3)}</td>
              <td style={{ whiteSpace: "normal" }}>{[r.four_fifths_flag ? "below four-fifths" : "", ...r.warnings].filter(Boolean).join("; ")}</td>
            </tr>
          )),
        )}
      </tbody>
    </table>
  );
}
