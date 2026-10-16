// The charts of the README and docs/RESULTS.md, drawn from the committed result files only (npm run docs:figures; npm
// run results:readme writes them too), with the brand mark and the demo button. Pure functions: the same results give the same bytes, so a test compares the
// committed SVGs with a fresh render. Colors are the app's design tokens (src/web/design/tokens.css), each chart is a
// card that reads in either theme, every chart says its data is synthetic and names its command, date and file, and
// every number in a subtitle is computed from the file. Coordinates are written with one decimal, never with d3-format
// (which writes U+2212 for minus), and the text never carries an en or em dash.
import { scaleLinear, scalePoint } from "d3-scale";
import { type ActionAuditReport, type AgentEvalReport, type BacktestReport, type CalibrationReport, type DqFaultsReport, type Entry, FAULT_SHORT, FIGURE_DIR, FIGURES, latest, listing, type ModelComparisonReport, type RecoveryReport, type RecoveryShockReport, type ResearchReport, runsOf, verdictLine } from "./results.ts";

export interface Theme {
  mode: "light" | "dark";
  surface: string;
  sunk: string;
  border: string;
  ink: string;
  ink2: string;
  ink3: string;
  grid: string;
  axis: string;
  vol: string;
  band80: string;
  band95: string;
  other: string;
  accent: string;
  accentInk: string;
}

/** The design token behind each palette slot; a test checks every value against tokens.css in both modes. */
export const TOKEN_OF: Record<Exclude<keyof Theme, "mode">, string> = {
  surface: "--surface",
  sunk: "--surface-sunk",
  border: "--border",
  ink: "--ink",
  ink2: "--ink-2",
  ink3: "--ink-3",
  grid: "--grid",
  axis: "--axis",
  vol: "--series-vol",
  band80: "--series-vol-band80",
  band95: "--series-vol-band95",
  other: "--series-other",
  accent: "--accent",
  accentInk: "--accent-ink",
};

export const THEMES: readonly Theme[] = [
  { mode: "light", surface: "#fcfcfb", sunk: "#f3f2ee", border: "#e6e5df", ink: "#0b0b0b", ink2: "#52514e", ink3: "#6d6c67", grid: "#e1e0d9", axis: "#c3c2b7", vol: "#2a78d6", band80: "rgba(42, 120, 214, 0.2)", band95: "rgba(42, 120, 214, 0.1)", other: "#898781", accent: "#1c5cab", accentInk: "#ffffff" },
  { mode: "dark", surface: "#1a1a19", sunk: "#141413", border: "#2c2c2a", ink: "#ffffff", ink2: "#c3c2b7", ink3: "#a3a29a", grid: "#2c2c2a", axis: "#383835", vol: "#3987e5", band80: "rgba(57, 135, 229, 0.28)", band95: "rgba(57, 135, 229, 0.14)", other: "#898781", accent: "#86b6ef", accentInk: "#0b0b0b" },
];

/** Equivalence bounds registered before any run (research/PREREGISTRATION.md, "Equivalence bounds"). */
const OE_BOUNDS: [number, number] = [0.95, 1.05];
const COV80_BOUNDS: [number, number] = [0.75, 0.85];

const FULL = 1000;
const HALF = 560;
const PAD = 28;
const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SYNTHETIC = "Synthetic data (fictional Larkspur Systems)";

/** A number with fixed decimals, ASCII minus, and no negative zero. */
export function fx(v: number, d = 1): string {
  const s = v.toFixed(d);
  return Number(s) === 0 ? (0).toFixed(d) : s;
}

const pct = (v: number, d = 1) => `${fx(v * 100, d)}%`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A generous width estimate (Helvetica-like metrics plus slack), since an SVG shown through <img> cannot load fonts. */
export function textWidth(s: string, size: number, weight = 400): number {
  let w = 0;
  for (const c of s) {
    if (c === " " || "il.,:;'!|".includes(c)) w += 0.3;
    else if ("fjrtI()[]-/".includes(c)) w += 0.38;
    else if ("mwMW%@".includes(c)) w += 0.88;
    else if (c >= "A" && c <= "Z") w += 0.7;
    else if (c >= "0" && c <= "9") w += 0.58;
    else w += 0.56;
  }
  return w * size * (weight >= 600 ? 1.07 : 1);
}

export function wrap(s: string, max: number, size: number, weight = 400): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of s.split(" ")) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, size, weight) > max) {
      lines.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

interface TextOpts {
  size?: number;
  weight?: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
}

function text(x: number, y: number, s: string, o: TextOpts): string {
  const size = o.size ?? 14;
  return `<text x="${fx(x)}" y="${fx(y)}" font-size="${size}"${o.weight ? ` font-weight="${o.weight}"` : ""}${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""} fill="${o.fill}">${esc(s)}</text>`;
}

/** Text vertically centered on y. */
const centered = (x: number, y: number, s: string, o: TextOpts) => text(x, y + (o.size ?? 14) * 0.35, s, o);

const line = (x1: number, y1: number, x2: number, y2: number, stroke: string, width = 1, dash?: string) =>
  `<line x1="${fx(x1)}" y1="${fx(y1)}" x2="${fx(x2)}" y2="${fx(y2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;

const rect = (x: number, y: number, w: number, h: number, fill: string, rx = 0) => `<rect x="${fx(x)}" y="${fx(y)}" width="${fx(w)}" height="${fx(h)}"${rx ? ` rx="${rx}"` : ""} fill="${fill}"/>`;

/** A filled dot with a surface ring, or a hollow one. */
function dot(x: number, y: number, r: number, color: string, th: Theme, hollow = false): string {
  return hollow
    ? `<circle cx="${fx(x)}" cy="${fx(y)}" r="${r}" fill="${th.surface}" stroke="${color}" stroke-width="2"/>`
    : `<circle cx="${fx(x)}" cy="${fx(y)}" r="${r}" fill="${color}" stroke="${th.surface}" stroke-width="2"/>`;
}

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${fx(x)} ${fx(y)}`).join("");

/** A horizontal bar from x0, square at the baseline and rounded at its end. */
function hbar(x0: number, y: number, w: number, h: number, fill: string, r = 4): string {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `<path d="M${fx(x0)} ${fx(y)}H${fx(x0 + w - rr)}Q${fx(x0 + w)} ${fx(y)} ${fx(x0 + w)} ${fx(y + rr)}V${fx(y + h - rr)}Q${fx(x0 + w)} ${fx(y + h)} ${fx(x0 + w - rr)} ${fx(y + h)}H${fx(x0)}Z" fill="${fill}"/>`;
}

type Glyph = "band95" | "band80" | "line" | "dash" | "dot" | "ring" | "shade";

interface LegendItem {
  glyph: Glyph;
  color?: string;
  label: string;
}

function glyph(g: Glyph, x: number, cy: number, th: Theme, color = th.vol): string {
  switch (g) {
    case "band95":
      return rect(x, cy - 6, 16, 12, th.band95, 2);
    case "band80":
      return rect(x, cy - 6, 16, 12, th.band80, 2);
    case "shade":
      return `${rect(x, cy - 6, 16, 12, th.grid, 2)}`;
    case "line":
      return line(x, cy, x + 18, cy, color, 2);
    case "dash":
      return line(x, cy, x + 18, cy, color, 2, "5 3");
    case "dot":
      return dot(x + 9, cy, 5, color, th);
    case "ring":
      return dot(x + 9, cy, 4.5, color, th, true);
  }
}

interface Geom {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

interface Chart {
  name: string;
  width: number;
  title: string;
  subtitle: string;
  legend: LegendItem[];
  footer: string;
  bodyHeight: number;
  body: (g: Geom, th: Theme) => string;
}

function footerLine(command: string, dates: string, files: string, extra = ""): string {
  return `${SYNTHETIC} · ${command} · ${dates} · ${files}${extra ? ` · ${extra}` : ""}`;
}

/** Lays out the card: title, subtitle, legend, the chart's body and the synthetic-data footer. */
function card(c: Chart, th: Theme): string {
  const inner = c.width - 2 * PAD;
  const parts: string[] = [];
  let y = PAD;
  for (const [i, l] of wrap(c.title, inner, 20, 600).entries()) {
    y += i === 0 ? 20 : 26;
    parts.push(text(PAD, y, l, { size: 20, weight: 600, fill: th.ink }));
  }
  y += 6;
  for (const l of wrap(c.subtitle, inner, 15)) {
    y += 21;
    parts.push(text(PAD, y, l, { size: 15, fill: th.ink2 }));
  }
  if (c.legend.length) {
    y += 16;
    let x = PAD;
    let cy = y + 8;
    for (const item of c.legend) {
      const w = 24 + textWidth(item.label, 14);
      if (x > PAD && x + w > c.width - PAD) {
        x = PAD;
        cy += 24;
      }
      parts.push(glyph(item.glyph, x, cy, th, item.color), centered(x + 24, cy, item.label, { fill: th.ink2 }));
      x += w + 20;
    }
    y = cy + 8;
  }
  y += 20;
  const g: Geom = { x0: PAD, x1: c.width - PAD, y0: y, y1: y + c.bodyHeight };
  parts.push(c.body(g, th));
  y = g.y1 + 18;
  parts.push(line(PAD, y, c.width - PAD, y, th.grid));
  y += 4;
  for (const l of wrap(c.footer, inner, 12.5)) {
    y += 17;
    parts.push(text(PAD, y, l, { size: 12.5, fill: th.ink3 }));
  }
  const h = Math.ceil(y + PAD - 6);
  const id = `${c.name}-${th.mode}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${h}" viewBox="0 0 ${c.width} ${h}" role="img" aria-labelledby="${id}-title ${id}-desc">`,
    `<title id="${id}-title">${esc(c.title)}</title>`,
    `<desc id="${id}-desc">${esc(`${c.subtitle} ${c.footer}`)}</desc>`,
    `<style>text{font-family:${FONT};font-variant-numeric:tabular-nums}</style>`,
    `<rect x="0.5" y="0.5" width="${c.width - 1}" height="${h - 1}" rx="10" fill="${th.surface}" stroke="${th.border}"/>`,
    ...parts,
    "</svg>",
    "",
  ].join("\n");
}

const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const within = (v: number, [lo, hi]: [number, number]) => v >= lo && v <= hi;

/** F1: the company's 3-month backtest, origin by origin. */
function backtestCompany(e: { file: string; report: BacktestReport }): Chart | null {
  const rows = (e.report.entries ?? []).filter((x) => x.cohort === "company" && x.horizon_months === 3).sort((a, b) => a.origin.localeCompare(b.origin));
  const level = e.report.levels["company|3"];
  if (rows.length < 2 || !level) return null;
  const mature = rows.filter((x) => x.status === "mature");
  const held80 = mature.filter((x) => within(x.actual, x.i80)).length;
  const held95 = mature.filter((x) => within(x.actual, x.i95)).length;
  const first = rows[0]!.origin;
  const last = rows[rows.length - 1]!.origin;
  return {
    name: "backtest-company-3m",
    width: FULL,
    title: "Company, 3-month windows: forecast ranges against what happened",
    subtitle: `The 80% range held in ${held80} of ${mature.length} mature windows (${level.effective_windows} independent) and the 95% range in ${held95}. Model and data as known at each monthly origin, ${monthLabel(first)} to ${monthLabel(last)}.`,
    legend: [
      { glyph: "band95", label: "95% range" },
      { glyph: "band80", label: "80% range" },
      { glyph: "line", label: "Forecast (expected)" },
      { glyph: "dash", color: "other", label: "Trailing-rate status quo" },
      { glyph: "dot", color: "ink", label: "Observed" },
      { glyph: "ring", color: "ink", label: "Observed, provisional" },
    ],
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: 320,
    body: (g, th) => {
      const out: string[] = [];
      const x0 = g.x0 + 44;
      const x1 = g.x1 - 4;
      const y0 = g.y0 + 26;
      const y1 = g.y1 - 30;
      const shown = rows.filter((x) => x.status !== "pending");
      const top = Math.max(...rows.map((x) => Math.max(x.i95[1], x.expected, x.hist_expected)), ...shown.map((x) => x.actual));
      const y = scaleLinear().domain([0, top]).nice().range([y1, y0]);
      const x = scalePoint<string>().domain(rows.map((r) => r.origin)).range([x0, x1]).padding(0.5);
      const step = x.step();
      out.push(text(g.x0, g.y0 + 12, "Voluntary departures in the 3 months after each origin", { fill: th.ink3 }));
      const firstOpen = rows.findIndex((r) => r.status !== "mature");
      if (firstOpen > 0) {
        const sx = (x(rows[firstOpen]!.origin) ?? 0) - step / 2;
        out.push(rect(sx, y0, x1 - sx, y1 - y0, th.sunk), text(x1 - 6, y0 + 18, "not yet mature", { fill: th.ink3, anchor: "end" }));
      }
      for (const t of y.ticks(6)) out.push(line(x0, y(t), x1, y(t), th.grid), text(x0 - 10, y(t) + 5, String(t), { fill: th.ink3, anchor: "end" }));
      out.push(line(x0, y1, x1, y1, th.axis));
      const bw = Math.min(14, step * 0.45);
      for (const r of rows) {
        const cx = x(r.origin) ?? 0;
        out.push(rect(cx - bw / 2, y(r.i95[1]), bw, y(r.i95[0]) - y(r.i95[1]), th.band95, 3), rect(cx - bw / 2, y(r.i80[1]), bw, y(r.i80[0]) - y(r.i80[1]), th.band80, 3));
      }
      out.push(`<path d="${path(rows.map((r) => [x(r.origin) ?? 0, y(r.hist_expected)]))}" fill="none" stroke="${th.other}" stroke-width="2" stroke-dasharray="5 3"/>`);
      out.push(`<path d="${path(rows.map((r) => [x(r.origin) ?? 0, y(r.expected)]))}" fill="none" stroke="${th.vol}" stroke-width="2" stroke-linejoin="round"/>`);
      for (const r of rows) out.push(dot(x(r.origin) ?? 0, y(r.expected), 3.5, th.vol, th));
      for (const r of shown) out.push(dot(x(r.origin) ?? 0, y(r.actual), r.status === "mature" ? 5 : 4.5, th.ink, th, r.status !== "mature"));
      rows.forEach((r, i) => {
        if (i % 3 === 0) out.push(text(x(r.origin) ?? 0, y1 + 22, monthLabel(r.origin), { fill: th.ink3, anchor: "middle" }));
      });
      return out.join("\n");
    },
  };
}

/** F2: how often the ranges held, by level and horizon, against nominal. */
function coverage(e: { file: string; report: BacktestReport }): Chart | null {
  const groups = [
    { label: "Company", rows: Object.values(e.report.levels).filter((l) => l.level === "company") },
    { label: "Organizations", rows: Object.values(e.report.levels).filter((l) => l.level === "organization") },
  ].filter((gr) => gr.rows.length);
  if (!groups.length) return null;
  for (const gr of groups) gr.rows.sort((a, b) => a.horizon_months - b.horizon_months);
  const nRows = groups.reduce((a, gr) => a + gr.rows.length, 0);
  const rowH = 30;
  return {
    name: "coverage",
    width: HALF,
    title: "How often the ranges held",
    subtitle: "Share of mature windows inside each range, against the nominal 80% and 95% (dashed). Independent windows in brackets; organizations of 50 or more people.",
    legend: [
      { glyph: "dot", label: "80% range held" },
      { glyph: "ring", label: "95% range held" },
    ],
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: 26 + groups.length * 30 + nRows * rowH + 30,
    body: (g, th) => {
      const out: string[] = [];
      const lx = g.x0;
      const x0 = g.x0 + 132;
      const x1 = g.x1 - 64;
      const y0 = g.y0 + 26;
      const x = scaleLinear().domain([0, 1]).range([x0, x1]);
      let cy = y0;
      const bottom = y0 + groups.length * 30 + nRows * rowH;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) out.push(line(x(t), y0, x(t), bottom, th.grid), text(x(t), bottom + 22, pct(t, 0), { fill: th.ink3, anchor: "middle" }));
      for (const [v, label] of [[0.8, "80%"], [0.95, "95%"]] as const) out.push(line(x(v), y0 - 4, x(v), bottom, th.ink3, 1, "4 3"), text(x(v), g.y0 + 12, label, { fill: th.ink3, anchor: "middle" }));
      for (const [i, gr] of groups.entries()) {
        out.push(centered(lx, cy + 15, gr.label, { fill: th.ink, weight: 600 }));
        if (i === 0) out.push(centered(g.x1, cy + 15, "80% held", { fill: th.ink3, anchor: "end" }));
        cy += 30;
        for (const l of gr.rows) {
          const my = cy + rowH / 2;
          out.push(centered(lx + 12, my, `${l.horizon_months} month${l.horizon_months > 1 ? "s" : ""} [${l.effective_windows}]`, { fill: th.ink2 }));
          out.push(dot(x(l.coverage95), my, 5, th.vol, th, true), dot(x(l.coverage80), my, 5.5, th.vol, th));
          out.push(centered(g.x1, my, pct(l.coverage80), { fill: th.ink2, anchor: "end" }));
          cy += rowH;
        }
      }
      return out.join("\n");
    },
  };
}

const MODEL_LABEL: Record<string, string> = { "dtcr-mnl": "StaySignal model", hist: "Trailing rate", oracle: "Oracle (knows the hidden truth)" };

/** F3: count error of the model against the trailing rate and the oracle, by level and horizon. */
function modelVsTrailing(e: { file: string; report: ModelComparisonReport }): Chart | null {
  const models = ["dtcr-mnl", "hist", "oracle"].filter((m) => e.report.models.includes(m));
  if (!models.includes("dtcr-mnl") || !models.includes("hist")) return null;
  const mae = (s: ModelComparisonReport["summary"][string], m: string) => (s[m] as { mae: number } | undefined)?.mae;
  const panels = [
    { label: "Company", level: "company" },
    { label: "Organizations", level: "organization" },
  ].map((p) => ({ ...p, cells: Object.values(e.report.summary).filter((s) => s.level === p.level).sort((a, b) => a.horizon_months - b.horizon_months) }));
  const beats = (level: string) => {
    const cells = panels.find((p) => p.level === level)?.cells ?? [];
    return `${cells.filter((s) => (mae(s, "dtcr-mnl") ?? Infinity) < (mae(s, "hist") ?? -Infinity)).length} of ${cells.length}`;
  };
  return {
    name: "model-vs-trailing",
    width: HALF,
    title: "Count error against the trailing rate",
    subtitle: `Mean absolute error on the same ${e.report.origins.length} quarterly origins for every model; lower is better. The model is below the trailing rate at ${beats("company")} horizons for the company and ${beats("organization")} for organizations.`,
    legend: models.map((m) => ({ glyph: m === "oracle" ? "ring" : "dot", color: m === "dtcr-mnl" ? "vol" : m === "hist" ? "other" : "ink", label: MODEL_LABEL[m] ?? m }) as LegendItem),
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: 250,
    body: (g, th) => {
      const out: string[] = [];
      const gap = 28;
      const pw = (g.x1 - g.x0 - gap) / 2;
      const color = (m: string) => (m === "dtcr-mnl" ? th.vol : m === "hist" ? th.other : th.ink);
      panels.forEach((p, i) => {
        const px = g.x0 + i * (pw + gap);
        const x0 = px + 40;
        const x1 = px + pw;
        const y0 = g.y0 + 46;
        const y1 = g.y1 - 44;
        out.push(text(px, g.y0 + 12, p.label, { fill: th.ink, weight: 600 }), text(px, g.y0 + 32, "MAE (departures)", { fill: th.ink3 }));
        const top = Math.max(...p.cells.flatMap((s) => models.map((m) => mae(s, m) ?? 0)));
        const y = scaleLinear().domain([0, top]).nice().range([y1, y0]);
        const x = scalePoint<number>().domain(p.cells.map((s) => s.horizon_months)).range([x0, x1]).padding(0.6);
        for (const t of y.ticks(4)) out.push(line(x0, y(t), x1, y(t), th.grid), text(x0 - 8, y(t) + 5, String(t), { fill: th.ink3, anchor: "end" }));
        out.push(line(x0, y1, x1, y1, th.axis));
        const dx = (m: string) => (models.indexOf(m) - (models.length - 1) / 2) * 12;
        for (const m of models) {
          const pts = p.cells.map((s) => [(x(s.horizon_months) ?? 0) + dx(m), y(mae(s, m) ?? 0)] as [number, number]);
          out.push(`<path d="${path(pts)}" fill="none" stroke="${color(m)}" stroke-width="1.5" stroke-opacity="0.45"/>`);
          for (const [px2, py] of pts) out.push(dot(px2, py, m === "oracle" ? 4.5 : 5, color(m), th, m === "oracle"));
        }
        for (const s of p.cells) out.push(text(x(s.horizon_months) ?? 0, y1 + 22, String(s.horizon_months), { fill: th.ink3, anchor: "middle" }));
        out.push(text((x0 + x1) / 2, y1 + 42, "Horizon (months)", { fill: th.ink3, anchor: "middle" }));
      });
      return out.join("\n");
    },
  };
}

const FAULT_LABEL: Record<string, string> = { pay_basis: "Pay-basis code", duplicates: "Duplicate HRIS records", late_terminations: "Late terminations", missing_extract: "Missing payroll extract", broken_manager: "Broken manager refs" };
const suiteOf = (r: DqFaultsReport) => (r.design?.includes("phase-2") ? "phase 1 and built phase-2 checks" : "phase-1 checks");

/** F4: planted data faults detected before publishing, the earliest run against the latest. */
function dqFaults(runs: { file: string; report: DqFaultsReport }[]): Chart | null {
  const later = runs[runs.length - 1];
  if (!later) return null;
  const earlier = runs.length > 1 ? runs[0]! : null;
  const xs = Object.entries(later.report.summary);
  const total = xs.reduce((a, [, v]) => a + v.seeds, 0);
  const detected = xs.reduce((a, [, v]) => a + v.detected, 0);
  const held = xs.reduce((a, [, v]) => a + v.held, 0);
  const warnOnly = xs.filter(([, v]) => v.detected === v.seeds && v.held === 0).map(([k]) => FAULT_SHORT[k] ?? k);
  const seeds = Math.max(...xs.map(([, v]) => v.seeds));
  const rowH = 34;
  return {
    name: "dq-faults",
    width: HALF,
    title: "Planted data faults caught before publishing",
    subtitle: `Each fault planted in ${seeds} copies of the small world. Latest run: ${detected} of ${total} detected and ${held} held${warnOnly.length ? `; ${listing(warnOnly)} only warn` : ""}.`,
    legend: [...(earlier ? [{ glyph: "ring" as const, color: "other", label: `${earlier.report.date}: ${suiteOf(earlier.report)}` }] : []), { glyph: "dot", label: `${later.report.date}: ${suiteOf(later.report)}` }],
    footer: footerLine(later.report.command, earlier ? `${earlier.report.date} and ${later.report.date}` : later.report.date, earlier ? `${earlier.file}, ${later.file}` : later.file),
    bodyHeight: 24 + xs.length * rowH + 30,
    body: (g, th) => {
      const out: string[] = [];
      const x0 = g.x0 + 184;
      const x1 = g.x1 - 92;
      const y0 = g.y0 + 24;
      const bottom = y0 + xs.length * rowH;
      const x = scaleLinear().domain([0, seeds]).range([x0, x1]);
      out.push(text(x0, g.y0 + 10, `Detected, of ${seeds}`, { fill: th.ink3 }), text(g.x1, g.y0 + 10, "Held", { fill: th.ink3, anchor: "end" }));
      for (let t = 0; t <= seeds; t++) out.push(line(x(t), y0, x(t), bottom, th.grid), text(x(t), bottom + 22, String(t), { fill: th.ink3, anchor: "middle" }));
      xs.forEach(([k, v], i) => {
        const my = y0 + i * rowH + rowH / 2;
        out.push(centered(g.x0, my, FAULT_LABEL[k] ?? k, { fill: th.ink2 }));
        const before = earlier?.report.summary[k];
        if (before && before.detected !== v.detected) out.push(line(x(before.detected), my, x(v.detected), my, th.axis, 3));
        if (before) out.push(dot(x(before.detected), my, 5, th.other, th, true));
        out.push(dot(x(v.detected), my, 5.5, th.vol, th));
        out.push(centered(g.x1, my, `${v.held} of ${v.seeds}`, { fill: th.ink2, anchor: "end" }));
      });
      return out.join("\n");
    },
  };
}

const EVAL_ROWS: readonly [string, string][] = [
  ["routing", "Routing"],
  ["grounding", "Grounding"],
  ["refusal", "Refusals"],
  ["injection", "Injections resisted"],
  ["multi_turn", "Multi-turn"],
];
const EVAL_MODEL: Record<string, string> = { llama: "Qwen3-1.7B on this laptop", mlx: "Qwen3.6-27B on this laptop", stub: "the scripted stub" };

/** F5: the latest agent eval of a real model, by category. */
function agentEval(e: { file: string; report: AgentEvalReport }): Chart | null {
  const results = e.report.results ?? [];
  if (!results.length) return null;
  const rows = EVAL_ROWS.map(([cat, label]) => {
    const items = results.filter((r) => r.category === cat);
    return { label, ok: items.filter((r) => r.ok).length, n: items.length };
  }).filter((r) => r.n > 0);
  const oos = e.report.metrics.refusal_by_code?.OUT_OF_SCOPE;
  const extra = oos && oos.precision !== null && oos.refused_with_code > 0 ? { label: "Out-of-scope refusals right", ok: Math.round(oos.precision * oos.refused_with_code), n: oos.refused_with_code } : null;
  const p50 = e.report.metrics.latency_ms_p50;
  const rowH = 32;
  return {
    name: "agent-eval",
    width: HALF,
    title: "Agent eval on a small local model",
    subtitle: `${e.report.items} synthetic questions to ${EVAL_MODEL[e.report.model] ?? e.report.model}, through the same turn as the chat dock${p50 === null ? "" : `; latency p50 ${fx(p50 / 1000)} s`}. The public demo replays recorded Qwen3.6-27B turns instead.`,
    legend: [],
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: rows.length * rowH + (extra ? rowH + 16 : 0) + 30,
    body: (g, th) => {
      const out: string[] = [];
      const x0 = g.x0 + 186;
      const x1 = g.x1 - 106;
      const x = scaleLinear().domain([0, 1]).range([x0, x1]);
      const draw = (r: { label: string; ok: number; n: number }, top: number) => {
        const my = top + rowH / 2;
        out.push(centered(g.x0, my, r.label, { fill: th.ink2 }), hbar(x0, my - 8, x1 - x0, 16, th.band95), hbar(x0, my - 8, x(r.ok / r.n) - x0, 16, th.vol));
        out.push(centered(g.x1, my, `${r.ok} of ${r.n}`, { fill: th.ink2, anchor: "end" }));
      };
      rows.forEach((r, i) => draw(r, g.y0 + i * rowH));
      let bottom = g.y0 + rows.length * rowH;
      if (extra) {
        out.push(line(g.x0, bottom + 8, g.x1, bottom + 8, th.grid));
        draw(extra, bottom + 16);
        bottom += rowH + 16;
      }
      for (const t of [0, 0.5, 1]) out.push(text(x(t), bottom + 22, pct(t, 0), { fill: th.ink3, anchor: "middle" }));
      return out.join("\n");
    },
  };
}

/** F6: the pre-registered study's deciding cells, against the registered equivalence bounds. */
function research(e: { file: string; report: ResearchReport }): Chart | null {
  const r = e.report;
  const cell = (factor: string, level: string, handling: string) => r.cells.find((c) => c.factor === factor && c.level === level && c.handling === handling);
  const v = (h: string) => r.hypotheses[h]?.verdict ?? "not recorded";
  const left = [
    { head: `H1 late corrections, share 0.30: ${v("H1")}`, rows: [["naive", cell("A", "0.30", "naive"), false], ["matured", cell("A", "0.30", "matured"), true]] },
    { head: `H2 missing termination extract: ${v("H2")}`, rows: [["as no events", cell("B", "missing", "no_events"), false], ["as censored", cell("B", "missing", "censored"), true]] },
    { head: `H4 duplicates, share 0.05: ${v("H4")}`, rows: [["not deduplicated", cell("D", "0.05", "not_deduplicated"), false], ["deduplicated", cell("D", "0.05", "deduplicated"), true]] },
  ] as const;
  const right = ["0", "0.25", "0.5"].map((s) => ({ head: `Team shocks, sigma ${s}`, rows: [["independence", cell("C", s, "independence"), false], ["shock-aware", cell("C", s, "shock_aware"), true]] as const }));
  if ([...left, ...right].some((gr) => gr.rows.some(([, c]) => !c))) return null;
  const horizon = r.horizon_months ?? 3;
  const rowH = 26;
  const headH = 30;
  return {
    name: "research",
    width: FULL,
    title: "Pre-registered study: what breaks calibration, and what fixes it",
    subtitle: `${r.seeds.length} seeds, ${r.origins.length} quarterly origins, ${horizon}-month horizon; dots are seed means with seed-bootstrap 90% intervals, decided against bounds registered before any run. ${verdictLine(r)}.`,
    legend: [
      { glyph: "dot", label: "The handling the hypothesis expects to fix it" },
      { glyph: "dot", color: "other", label: "The naive handling" },
      { glyph: "shade", label: "Equivalence bounds" },
    ],
    footer: footerLine(r.command, r.date, e.file, "pre-registered in research/PREREGISTRATION.md"),
    bodyHeight: 52 + 3 * headH + 6 * rowH + 30,
    body: (g, th) => {
      const out: string[] = [];
      const gap = 40;
      const pw = (g.x1 - g.x0 - gap) / 2;
      const panel = (px: number, title: string, note: string, groups: readonly { head: string; rows: readonly (readonly [string, (typeof r.cells)[number] | undefined, boolean])[] }[], val: (c: (typeof r.cells)[number]) => [number, number, number], bounds: [number, number], ref: number, fmt: (t: number) => string) => {
        const x0 = px + 128;
        const x1 = px + pw - 6;
        const y0 = g.y0 + 52;
        const bottom = y0 + groups.length * headH + groups.reduce((a, gr) => a + gr.rows.length, 0) * rowH;
        const vals = groups.flatMap((gr) => gr.rows.flatMap(([, c]) => (c ? val(c) : [])));
        const x = scaleLinear().domain([Math.min(...vals, bounds[0]), Math.max(...vals, bounds[1])]).nice().range([x0, x1]);
        out.push(text(px, g.y0 + 12, title, { fill: th.ink, weight: 600 }), text(px, g.y0 + 34, note, { fill: th.ink3 }));
        out.push(rect(x(bounds[0]), y0, x(bounds[1]) - x(bounds[0]), bottom - y0, th.grid));
        for (const t of x.ticks(5)) out.push(line(x(t), y0, x(t), bottom, th.grid), text(x(t), bottom + 22, fmt(t), { fill: th.ink3, anchor: "middle" }));
        out.push(line(x(ref), y0 - 4, x(ref), bottom, th.ink3, 1));
        let cy = y0;
        for (const gr of groups) {
          out.push(centered(px, cy + headH / 2 + 2, gr.head, { fill: th.ink, weight: 600 }));
          cy += headH;
          for (const [label, c, fix] of gr.rows) {
            if (!c) continue;
            const my = cy + rowH / 2;
            const [mid, lo, hi] = val(c);
            const color = fix ? th.vol : th.other;
            out.push(centered(px + 12, my, label, { fill: th.ink2 }), line(x(lo), my, x(hi), my, color, 2), dot(x(mid), my, 5, color, th));
            cy += rowH;
          }
        }
      };
      panel(g.x0, "Data fixes: observed over expected (1 is right)", `Shaded: equivalence bounds ${fx(OE_BOUNDS[0], 2)} to ${fx(OE_BOUNDS[1], 2)}`, left, (c) => [c.oe, c.oe_lo90, c.oe_hi90], OE_BOUNDS, 1, (t) => fx(t, 2));
      panel(g.x0 + pw + gap, `H3a shared team shocks: ${v("H3a")}`, `80% range held. Shaded: ${pct(COV80_BOUNDS[0], 0)} to ${pct(COV80_BOUNDS[1], 0)}`, right, (c) => [c.cov80, c.cov80_lo90 ?? c.cov80, c.cov80_hi90 ?? c.cov80], COV80_BOUNDS, 0.8, (t) => pct(t, 0));
      return out.join("\n");
    },
  };
}

/** F7: calibration of individual 3-month predictions by decile. */
function reliability(e: { file: string; report: CalibrationReport }): Chart | null {
  const bins = e.report.reliability;
  if (!bins.length) return null;
  return {
    name: "reliability",
    width: HALF,
    title: "Calibration of individual 3-month predictions",
    subtitle: `Predicted against observed by decile, with team-cluster bootstrap 80% intervals. ICI ${fx(e.report.ici * 100)} percentage points over ${e.report.n.toLocaleString("en-US")} person-windows; only deciles are ever stored.`,
    legend: [{ glyph: "line", color: "ink3", label: "Perfect calibration" }],
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: 340,
    body: (g, th) => {
      const out: string[] = [];
      const x0 = g.x0 + 64;
      const y0 = g.y0 + 24;
      const y1 = g.y1 - 44;
      const side = Math.min(y1 - y0, g.x1 - x0 - 10);
      const x1 = x0 + side;
      const top = Math.max(...bins.flatMap((b) => [b.predicted, b.observed_i80[1]]));
      const sx = scaleLinear().domain([0, top]).nice().range([x0, x1]);
      const sy = scaleLinear().domain(sx.domain()).range([y0 + side, y0]);
      const yb = y0 + side;
      out.push(text(g.x0, g.y0 + 10, "Observed share who left", { fill: th.ink3 }));
      for (const t of sx.ticks(4)) {
        out.push(line(sx(t), y0, sx(t), yb, th.grid), text(sx(t), yb + 22, pct(t, 0), { fill: th.ink3, anchor: "middle" }));
        out.push(line(x0, sy(t), x1, sy(t), th.grid), text(x0 - 10, sy(t) + 5, pct(t, 0), { fill: th.ink3, anchor: "end" }));
      }
      const d = sx.domain()[1] ?? top;
      out.push(line(sx(0), sy(0), sx(d), sy(d), th.ink3, 1.5));
      for (const b of bins) out.push(line(sx(b.predicted), sy(b.observed_i80[0]), sx(b.predicted), sy(b.observed_i80[1]), th.vol, 2));
      for (const b of bins) out.push(dot(sx(b.predicted), sy(b.observed), 5, th.vol, th));
      out.push(text((x0 + x1) / 2, yb + 42, "Predicted 3-month probability (decile mean)", { fill: th.ink3, anchor: "middle" }));
      return out.join("\n");
    },
  };
}

/** F8: does the estimator recover a known truth, without and with team shocks? */
function recovery(rec: { file: string; report: RecoveryReport }, shock: { file: string; report: RecoveryShockReport } | null): Chart | null {
  const panels = [
    { title: `No shocks: ${rec.report.coverage_95.inside} of ${rec.report.coverage_95.slopes} inside, Wald p = ${fx(rec.report.wald.p_value, 3)}`, axis: "True slope", slopes: rec.report.slopes ?? [] },
    ...(shock ? [{ title: `Team shocks, sigma ${shock.report.sigma_team}: ${shock.report.coverage_95.inside} of ${shock.report.coverage_95.slopes} inside, p = ${fx(shock.report.wald.p_value, 3)}`, axis: "Marginal target slope", slopes: shock.report.slopes ?? [] }] : []),
  ];
  if (panels.some((p) => !p.slopes.length)) return null;
  const files = [rec, ...(shock ? [shock] : [])];
  return {
    name: "recovery",
    width: FULL,
    title: "Does the estimator recover a known truth?",
    subtitle: `Each dot is one of the competing-risks model's ${panels[0]!.slopes.length} slopes, fitted on a world whose hazards have the model's own form; whiskers are 95% intervals and the diagonal is perfect recovery.${shock ? " Right: team shocks the model omits, against marginal targets from a separate world." : ""}`,
    legend: [
      { glyph: "dot", label: "Inside its 95% interval" },
      { glyph: "ring", color: "ink", label: "Outside" },
    ],
    footer: footerLine(files.map((f) => f.report.command).join(" and "), files.map((f) => f.report.date).join(" and "), files.map((f) => f.file).join(", ")),
    bodyHeight: 396,
    body: (g, th) => {
      const out: string[] = [];
      const gap = 48;
      const pw = (g.x1 - g.x0 - gap) / panels.length;
      const all = panels.flatMap((p) => p.slopes.flatMap((s) => [s.truth, s.estimate - 1.96 * s.se, s.estimate + 1.96 * s.se]));
      const domain = scaleLinear().domain([Math.min(...all), Math.max(...all)]).nice().domain() as [number, number];
      panels.forEach((p, i) => {
        const px = g.x0 + i * (pw + gap);
        const y0 = g.y0 + 50;
        const side = Math.min(g.y1 - 44 - y0, pw - 60);
        const x0 = px + 48;
        const sx = scaleLinear().domain(domain).range([x0, x0 + side]);
        const sy = scaleLinear().domain(domain).range([y0 + side, y0]);
        const yb = y0 + side;
        out.push(text(px, g.y0 + 12, p.title, { fill: th.ink, weight: 600 }));
        for (const t of sx.ticks(5)) {
          out.push(line(sx(t), y0, sx(t), yb, th.grid), text(sx(t), yb + 22, fx(t, Number.isInteger(t) ? 0 : 1), { fill: th.ink3, anchor: "middle" }));
          out.push(line(x0, sy(t), x0 + side, sy(t), th.grid), text(x0 - 10, sy(t) + 5, fx(t, Number.isInteger(t) ? 0 : 1), { fill: th.ink3, anchor: "end" }));
        }
        out.push(line(sx(domain[0]), sy(domain[0]), sx(domain[1]), sy(domain[1]), th.ink3, 1.5));
        for (const s of p.slopes) out.push(line(sx(s.truth), sy(s.estimate - 1.96 * s.se), sx(s.truth), sy(s.estimate + 1.96 * s.se), s.inside_95 ? th.vol : th.ink, 1.5));
        for (const s of p.slopes) out.push(dot(sx(s.truth), sy(s.estimate), s.inside_95 ? 4.5 : 5, s.inside_95 ? th.vol : th.ink, th, !s.inside_95));
        out.push(text(x0 + side / 2, yb + 42, p.axis, { fill: th.ink3, anchor: "middle" }), text(px, g.y0 + 34, "Estimated slope", { fill: th.ink3 }));
      });
      return out.join("\n");
    },
  };
}

const SCREEN_LABEL: Record<string, string> = { tenure_band: "Tenure band", location: "Location" };

/** F9: the action audit's proxy screens, in the file's order; the audit-only screen is never drawn. */
function actionAudit(e: { file: string; report: ActionAuditReport }): Chart | null {
  const screens = Object.entries(e.report.screens).filter(([, s]) => s.kind === "proxy");
  if (!screens.length) return null;
  const nRows = screens.reduce((a, [, s]) => a + s.rows.length, 0);
  const rowH = 28;
  return {
    name: "action-audit",
    width: HALF,
    title: "Action audit: impact ratio by proxy screen",
    subtitle: `Each group's selection rate for an approved review over the highest group's, across ${e.report.reviews} seeded synthetic reviews. A flag is a reason to look, not a finding; groups under 10 people are not screened.`,
    legend: [
      { glyph: "dot", label: "Impact ratio" },
      { glyph: "dash", color: "ink3", label: "Four-fifths rule of thumb (0.8)" },
    ],
    footer: footerLine(e.report.command, e.report.date, e.file),
    bodyHeight: screens.length * 30 + nRows * rowH + 30,
    body: (g, th) => {
      const out: string[] = [];
      const x0 = g.x0 + 132;
      const x1 = g.x1 - 92;
      const y0 = g.y0;
      const bottom = y0 + screens.length * 30 + nRows * rowH;
      const x = scaleLinear().domain([0, 1]).range([x0, x1]);
      for (const t of [0, 0.2, 0.4, 0.6, 0.8, 1]) out.push(line(x(t), y0, x(t), bottom, th.grid), text(x(t), bottom + 22, fx(t), { fill: th.ink3, anchor: "middle" }));
      out.push(line(x(0.8), y0, x(0.8), bottom, th.ink3, 1.5, "5 3"));
      let cy = y0;
      for (const [name, s] of screens) {
        out.push(centered(g.x0, cy + 15, SCREEN_LABEL[name] ?? name, { fill: th.ink, weight: 600 }));
        cy += 30;
        for (const row of s.rows) {
          const my = cy + rowH / 2;
          out.push(centered(g.x0 + 12, my, row.group, { fill: th.ink2 }));
          if (row.too_small || row.ratio === null) out.push(centered(g.x1, my, "too small", { fill: th.ink3, anchor: "end" }));
          else out.push(dot(x(Math.min(row.ratio, 1)), my, 5.5, th.vol, th), centered(g.x1, my, `${fx(row.ratio, 2)}${row.four_fifths_flag ? ", below" : ""}`, { fill: th.ink2, anchor: "end" }));
          cy += rowH;
        }
      }
      return out.join("\n");
    },
  };
}

/** The app's brand mark (BrandMark in src/web/components/icons.tsx on the .brand-mark square of app.css). */
export function mark(th: Theme): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 26 26" role="img" aria-labelledby="mark-${th.mode}-title">`,
    `<title id="mark-${th.mode}-title">StaySignal</title>`,
    `<rect width="26" height="26" rx="7" fill="${th.accent}"/>`,
    `<g transform="translate(5 5)"><path d="M2 11.5c2.2 0 2.6-5 5-5s2.8 3 5 3" fill="none" stroke="${th.accentInk}" stroke-width="1.8" stroke-linecap="round"/><circle cx="12.2" cy="9.5" r="1.6" fill="${th.accentInk}"/></g>`,
    "</svg>",
    "",
  ].join("\n");
}

/** The README's call to action: a button to the live demo, in the accent of each theme. */
export function demoButton(th: Theme): string {
  const label = "Open the live demo";
  const note = "No account needed, synthetic company";
  const w = Math.ceil(56 + Math.max(textWidth(label, 18, 650), textWidth(note, 13)) + 24);
  const h = 56;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="demo-button-${th.mode}-title">`,
    `<title id="demo-button-${th.mode}-title">Open the live demo, no account needed</title>`,
    `<style>text{font-family:${FONT}}</style>`,
    `<rect width="${w}" height="${h}" rx="10" fill="${th.accent}"/>`,
    `<path d="M26 19L40 28L26 37Z" fill="${th.accentInk}"/>`,
    text(56, 26, label, { size: 18, weight: 650, fill: th.accentInk }),
    text(56, 44, note, { size: 13, fill: th.accentInk }),
    "</svg>",
    "",
  ].join("\n");
}

/** Resolves a legend color name ("other", "ink", ...) to the theme's value. */
function resolveLegend(c: Chart, th: Theme): Chart {
  return { ...c, legend: c.legend.map((l) => ({ ...l, color: l.color ? ((th as unknown as Record<string, string>)[l.color] ?? l.color) : th.vol })) };
}

function chartsFor(reports: readonly Entry[]): Chart[] {
  const out: (Chart | null)[] = [];
  const bt = latest(reports, "backtest");
  const cal = latest(reports, "calibration");
  const cmp = latest(reports, "model-comparison");
  const rec = latest(reports, "recovery");
  const res = latest(reports, "research");
  const agent = latest(reports, "agent-eval", (r) => r.model !== "stub");
  const audit = latest(reports, "action-audit");
  const byName: Record<string, () => Chart | null> = {
    "backtest-company-3m": () => (bt ? backtestCompany(bt) : null),
    coverage: () => (bt ? coverage(bt) : null),
    reliability: () => (cal ? reliability(cal) : null),
    "model-vs-trailing": () => (cmp ? modelVsTrailing(cmp) : null),
    recovery: () => (rec ? recovery(rec, latest(reports, "recovery-shock")) : null),
    research: () => (res ? research(res) : null),
    "dq-faults": () => dqFaults(runsOf(reports, "dq-faults")),
    "agent-eval": () => (agent ? agentEval(agent) : null),
    "action-audit": () => (audit ? actionAudit(audit) : null),
  };
  for (const f of FIGURES) out.push(byName[f.name]?.() ?? null);
  return out.filter((c): c is Chart => c !== null);
}

/** Every figure file, light and dark, keyed by its path from the repository root. */
export function renderFigures(reports: readonly Entry[]): Map<string, string> {
  const files = new Map<string, string>();
  for (const th of THEMES) {
    files.set(`docs/images/mark-${th.mode}.svg`, mark(th));
    files.set(`docs/images/demo-button-${th.mode}.svg`, demoButton(th));
    for (const c of chartsFor(reports)) files.set(`${FIGURE_DIR}/${c.name}-${th.mode}.svg`, card(resolveLegend(c, th), th));
  }
  return files;
}
