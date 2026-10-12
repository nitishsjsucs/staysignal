// Workforce flows as a three-column Sankey (SPEC 16.2, Workforce): where people came from (start of the window, hires,
// moves in) and where they went (end of the window, exits, moves out), through the cohort. Emphasis form: every band is
// neutral except voluntary exits, which keep the voluntary series color, and other exits, which keep the grey "Other
// exits" color; labels sit in gutters outside the bands, in text tokens. Merged and withheld links follow SPEC 17.5.
// Hover shows each link; the table view lists every link. Synthetic data.
import { useState } from "react";
import type { FlowLink } from "../../shared/contracts";
import { TipRow, Tooltip, useTooltip, useWidth } from "./kit";

const SHORT: Record<string, string> = {
  "Start of window": "Start",
  "End of window": "End",
  "Moved in by a restructure": "Restructure in",
  "Moved out by a restructure": "Restructure out",
  "Other arrivals (merged)": "Merged arrivals",
  "Other departures and moves (merged)": "Merged departures",
  "Arrivals (fewer than 10, withheld)": "Arrivals withheld",
  "Departures and moves (fewer than 10, withheld)": "Departures withheld",
};

function tone(name: string): { fill: string; opacity: number } {
  if (name === "Voluntary exits") return { fill: "var(--series-vol)", opacity: 0.55 };
  if (name === "Other exits") return { fill: "var(--series-other)", opacity: 0.55 };
  return { fill: "var(--ink-3)", opacity: 0.16 };
}

interface Node {
  name: string;
  value: number | null;
  y: number;
  h: number;
}

const BAR = 6;
const MIN_SLOT = 20;
const GAP = 6;
const TOP = 22;

function column(items: { name: string; value: number | null }[], scale: number): { nodes: Node[]; height: number } {
  let y = TOP;
  const nodes: Node[] = [];
  for (const it of items) {
    const h = it.value === null ? 0 : Math.max(2, it.value * scale);
    nodes.push({ name: it.name, value: it.value, y, h });
    y += Math.max(h, MIN_SLOT) + GAP;
  }
  return { nodes, height: y };
}

function band(xa: number, ya0: number, ya1: number, xb: number, yb0: number, yb1: number): string {
  const xm = (xa + xb) / 2;
  return `M${xa},${ya0}C${xm},${ya0} ${xm},${yb0} ${xb},${yb0}L${xb},${yb1}C${xm},${yb1} ${xm},${ya1} ${xa},${ya1}Z`;
}

export function FlowSankey({ links, cohort }: { links: FlowLink[]; cohort: string }) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const { tip, show, hide } = useTooltip();
  const [hover, setHover] = useState<string | null>(null);
  // the start-to-end band runs straight across the top; arrivals and departures stack below it
  const incoming = links.filter((l) => l.target === cohort);
  const outgoing = [...links.filter((l) => l.source === cohort && l.target === "End of window"), ...links.filter((l) => l.source === cohort && l.target !== "End of window")];
  const inTotal = incoming.reduce((s, l) => s + (l.value ?? 0), 0);
  const outTotal = outgoing.reduce((s, l) => s + (l.value ?? 0), 0);
  const label = (name: string) => SHORT[name] ?? name;
  const value = (v: number | null) => (v === null ? "withheld" : v.toLocaleString("en-US"));
  const narrow = width < 520;
  const charW = narrow ? 5.6 : 6.2;
  const gutter = (names: string[]) => Math.min(150, Math.max(64, Math.max(...names.map((n) => n.length)) * charW + 14));
  const ml = gutter(incoming.map((l) => `${label(l.source)} ${value(l.value)}`));
  const mr = gutter(outgoing.map((l) => `${label(l.target)} ${value(l.value)}`));
  const scale = (narrow ? 180 : 220) / Math.max(1, inTotal, outTotal);
  const left = column(incoming.map((l) => ({ name: l.source, value: l.value })), scale);
  const right = column(outgoing.map((l) => ({ name: l.target, value: l.value })), scale);
  const midH = Math.max(inTotal, outTotal) * scale;
  const height = Math.max(left.height, right.height, TOP + midH + 8) + 4;
  const x0 = ml;
  const x2 = width - mr - BAR;
  const x1 = Math.round((x0 + x2) / 2);
  let inY = TOP;
  let outY = TOP;
  const bands = [
    ...incoming.map((l, i) => {
      const n = left.nodes[i]!;
      const d = l.value === null ? null : band(x0 + BAR, n.y, n.y + n.h, x1, inY, inY + n.h);
      inY += l.value === null ? 0 : n.h;
      return { link: l, d, key: `in:${l.source}`, name: l.source };
    }),
    ...outgoing.map((l, i) => {
      const n = right.nodes[i]!;
      const d = l.value === null ? null : band(x1 + BAR, outY, outY + n.h, x2, n.y, n.y + n.h);
      outY += l.value === null ? 0 : n.h;
      return { link: l, d, key: `out:${l.target}`, name: l.target };
    }),
  ];
  const nodeFill = (n: Node) => (n.value === null ? "none" : n.name === "Voluntary exits" ? "var(--series-vol)" : n.name === "Other exits" ? "var(--series-other)" : "var(--ink-3)");
  const fontSize = narrow ? 10 : 11;
  return (
    <div ref={ref} onMouseLeave={() => (hide(), setHover(null))}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Workforce flows through ${cohort}: arrivals on the left, departures and moves on the right (synthetic data)`}>
        {bands.map((b) =>
          b.d ? (
            <path
              key={b.key}
              d={b.d}
              fill={tone(b.name).fill}
              fillOpacity={hover === b.key ? Math.min(0.9, tone(b.name).opacity + 0.25) : tone(b.name).opacity}
              onMouseMove={(e) => {
                setHover(b.key);
                show(
                  e,
                  <>
                    <div className="tt-title">
                      {b.link.source} to {b.link.target}
                    </div>
                    <TipRow name="People" value={value(b.link.value)} />
                    {b.link.merged_from ? <TipRow name="Merged" value={b.link.merged_from.join(", ")} /> : null}
                  </>,
                );
              }}
            />
          ) : null,
        )}
        {left.nodes.map((n) => (
          <g key={`l-${n.name}`}>
            <rect x={x0} y={n.y} width={BAR} height={Math.max(n.h, 2)} rx={2} fill={nodeFill(n)} stroke={n.value === null ? "var(--ink-3)" : "none"} strokeDasharray="2 2" />
            <text x={x0 - 6} y={n.y + Math.max(n.h, MIN_SLOT) / 2} dominantBaseline="middle" textAnchor="end" className="flow-label" fontSize={fontSize}>
              {label(n.name)} <tspan className="flow-value">{value(n.value)}</tspan>
            </text>
          </g>
        ))}
        <rect x={x1} y={TOP} width={BAR} height={Math.max(midH, 2)} rx={2} fill="var(--ink-2)" />
        <text x={x1 + BAR / 2} y={TOP - 8} textAnchor="middle" className="flow-label" fontSize={fontSize}>
          {cohort}
        </text>
        {right.nodes.map((n) => (
          <g key={`r-${n.name}`}>
            <rect x={x2} y={n.y} width={BAR} height={Math.max(n.h, 2)} rx={2} fill={nodeFill(n)} stroke={n.value === null ? "var(--ink-3)" : "none"} strokeDasharray="2 2" />
            <text x={x2 + BAR + 6} y={n.y + Math.max(n.h, MIN_SLOT) / 2} dominantBaseline="middle" className="flow-label" fontSize={fontSize}>
              {label(n.name)} <tspan className="flow-value">{value(n.value)}</tspan>
            </text>
          </g>
        ))}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export function FlowTable({ links }: { links: FlowLink[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col" className="num">
            People
          </th>
          <th scope="col">Merged</th>
        </tr>
      </thead>
      <tbody>
        {links.map((l) => (
          <tr key={`${l.source}>${l.target}`}>
            <td>{l.source}</td>
            <td>{l.target}</td>
            <td className="num">{l.value === null ? "withheld (fewer than 10)" : l.value.toLocaleString("en-US")}</td>
            <td>{l.merged_from?.join(", ") ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
