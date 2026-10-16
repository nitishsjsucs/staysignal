// The README's four diagrams (docs/images/diagrams/*.svg, light and dark), drawn as static cards so they read at any
// width and nothing covers them: the architecture, the path from sources to a published forecast, the hold and repair
// of a bad payroll file, and the review approval states. Pure functions in the app's design tokens, like the charts
// in scripts/lib/figures.ts: the same code gives the same bytes, so a test compares the committed files with a fresh
// render (npm run docs:figures). Each diagram names the code it describes in its footer.
import { card, centered, type Chart, FULL, type Geom, line, rect, resolveLegend, text, THEMES, type Theme, textWidth, wrap, fx } from "./figures.ts";

export const DIAGRAM_DIR = "docs/images/diagrams";

type Tone = "plain" | "accent" | "critical" | "warning" | "dashed" | "person";

interface NodeSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  shape?: "box" | "store" | "diamond";
  tone?: Tone;
}

interface EdgeOpts {
  dashed?: boolean;
  both?: boolean;
  accent?: boolean;
  label?: string;
  /** Label position: the center of its first line. */
  at?: [number, number];
  anchor?: "start" | "middle" | "end";
}

const TITLE = 15;
const SUB = 12.5;
const LABEL = 12.5;

/** A drawing surface in the card body's local coordinates (0, 0 is the body's top-left corner). */
class Canvas {
  private out: string[] = [];
  private readonly g: Geom;
  readonly th: Theme;
  private readonly id: string;
  constructor(g: Geom, th: Theme, id: string) {
    this.g = g;
    this.th = th;
    this.id = id;
    const marker = (name: string, color: string) =>
      `<marker id="${id}-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="${color}"/></marker>`;
    this.out.push(`<defs>${marker("arrow", th.ink3)}${marker("accent", th.vol)}</defs>`);
  }

  X = (v: number) => this.g.x0 + v;
  Y = (v: number) => this.g.y0 + v;

  /** A labeled frame behind a group of nodes. */
  /** A labeled frame behind a group of nodes; `tx` places the title clear of the lines that enter the frame. */
  frame(x: number, y: number, w: number, h: number, title: string, tx = 14): void {
    const { th } = this;
    this.out.push(`<rect x="${fx(this.X(x))}" y="${fx(this.Y(y))}" width="${fx(w)}" height="${fx(h)}" rx="10" fill="${th.sunk}" stroke="${th.border}"/>`);
    this.out.push(text(this.X(x + tx), this.Y(y + 22), title, { size: 13, weight: 600, fill: th.ink2 }));
  }

  node(n: NodeSpec): void {
    const { th } = this;
    const x = this.X(n.x);
    const y = this.Y(n.y);
    const tone = n.tone ?? "plain";
    const stroke = tone === "accent" || tone === "person" ? th.vol : tone === "critical" ? th.critical : tone === "warning" ? th.warning : th.ink3;
    const fill = tone === "accent" || tone === "person" ? th.band95 : th.surface;
    const width = tone === "plain" || tone === "dashed" ? 1.25 : 2;
    const dash = tone === "dashed" ? ` stroke-dasharray="5 4"` : "";
    const paint = `fill="${fill}" stroke="${stroke}" stroke-width="${width}"${dash}`;
    if (n.shape === "store") {
      const e = 7;
      const r = n.w / 2;
      this.out.push(`<path d="M${fx(x)} ${fx(y + e)}A${fx(r)} ${e} 0 0 1 ${fx(x + n.w)} ${fx(y + e)}V${fx(y + n.h - e)}A${fx(r)} ${e} 0 0 1 ${fx(x)} ${fx(y + n.h - e)}Z" ${paint}/>`);
      this.out.push(`<path d="M${fx(x)} ${fx(y + e)}A${fx(r)} ${e} 0 0 0 ${fx(x + n.w)} ${fx(y + e)}" fill="none" stroke="${stroke}" stroke-width="${width}"/>`);
    } else if (n.shape === "diamond") {
      const cx = x + n.w / 2;
      const cy = y + n.h / 2;
      this.out.push(`<path d="M${fx(cx)} ${fx(y)}L${fx(x + n.w)} ${fx(cy)}L${fx(cx)} ${fx(y + n.h)}L${fx(x)} ${fx(cy)}Z" stroke-linejoin="round" ${paint}/>`);
    } else {
      this.out.push(`<rect x="${fx(x)}" y="${fx(y)}" width="${fx(n.w)}" height="${fx(n.h)}" rx="8" ${paint}/>`);
    }
    const room = n.shape === "diamond" ? n.w * 0.62 : n.w - 20;
    const titles = wrap(n.title, room, TITLE, 600);
    const subs = n.sub ? wrap(n.sub, room, SUB) : [];
    const block = titles.length * 19 + (subs.length ? 3 + subs.length * 16 : 0);
    let cy = y + n.h / 2 - block / 2 + (n.shape === "store" ? 4 : 0);
    const cx = x + n.w / 2;
    for (const t of titles) {
      this.out.push(centered(cx, cy + 9.5, t, { size: TITLE, weight: 600, fill: th.ink, anchor: "middle" }));
      cy += 19;
    }
    cy += 3;
    for (const s of subs) {
      this.out.push(centered(cx, cy + 8, s, { size: SUB, fill: th.ink2, anchor: "middle" }));
      cy += 16;
    }
  }

  /** A text label on a chip of the card's surface, so a line under it never cuts through the words. */
  label(x: number, y: number, s: string, anchor: "start" | "middle" | "end" = "middle", fill = this.th.ink2): void {
    const lines = s.split("\n");
    lines.forEach((l, i) => {
      const w = textWidth(l, LABEL);
      const lx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
      const cy = y + i * 16;
      this.out.push(rect(this.X(lx - 4), this.Y(cy - 9), w + 8, 18, this.th.surface, 4));
      this.out.push(centered(this.X(x), this.Y(cy), l, { size: LABEL, fill, anchor }));
    });
  }

  edge(pts: [number, number][], o: EdgeOpts = {}): void {
    const { th } = this;
    const color = o.accent ? th.vol : th.ink3;
    const marker = `url(#${this.id}-${o.accent ? "accent" : "arrow"})`;
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${fx(this.X(x))} ${fx(this.Y(y))}`).join("");
    this.out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.accent ? 2 : 1.5}" stroke-linejoin="round"${o.dashed ? ` stroke-dasharray="6 4"` : ""} marker-end="${marker}"${o.both ? ` marker-start="${marker}"` : ""}/>`);
    if (o.label && o.at) this.label(o.at[0], o.at[1], o.label, o.anchor);
  }

  raw(s: string): void {
    this.out.push(s);
  }

  toString(): string {
    return this.out.join("\n");
  }
}

interface Diagram {
  name: string;
  title: string;
  subtitle: string;
  footer: string;
  legend?: Chart["legend"];
  height: number;
  draw: (c: Canvas, th: Theme) => void;
}

/** D1: one Worker, two agents, the API and the workflow; the engine and the job runners locally. */
const architecture: Diagram = {
  name: "architecture",
  title: "Architecture",
  subtitle: "One Cloudflare Worker serves the React app, two agents (Durable Objects), a Workflow and the API. A Python engine builds the warehouse and fits the model locally; the public demo and CI serve fixtures exported from it, and in the public demo the WorkspaceAgent completes each engine job from its fixture as it is enqueued.",
  footer: "Code: src/worker (agents, app.ts, workflows, warehouse), scripts/fixture-runner.ts and engine/src/staysignal",
  legend: [
    { glyph: "line", color: "ink3", label: "Every mode" },
    { glyph: "dash", color: "ink3", label: "One mode, named on the line" },
  ],
  height: 600,
  draw: (c) => {
    c.node({ x: 316, y: 0, w: 280, h: 52, title: "React 19 app", sub: "in the browser" });
    c.frame(0, 92, 944, 252, "Cloudflare Worker", 172);
    c.node({ x: 20, y: 132, w: 270, h: 62, title: "AnalystAgent", sub: "chat" });
    c.node({ x: 322, y: 132, w: 268, h: 62, title: "WorkspaceAgent", sub: "runs, approvals, action log, job queue" });
    c.node({ x: 680, y: 132, w: 244, h: 62, title: "Hono API", sub: "app data and runner endpoints" });
    c.node({ x: 20, y: 262, w: 270, h: 62, title: "Governed tools", sub: "authorize, suppress, round" });
    c.node({ x: 322, y: 262, w: 268, h: 62, title: "RoutineWorkflow", sub: "hold, repair, publish" });

    c.frame(0, 384, 442, 216, "Data and model text", 132);
    c.node({ x: 20, y: 424, w: 190, h: 84, title: "Committed fixtures", sub: "data and job results", shape: "store" });
    c.node({ x: 234, y: 424, w: 190, h: 84, title: "Model text", sub: "recorded turns, local Qwen or stub" });
    c.frame(472, 384, 472, 216, "Local only");
    c.node({ x: 488, y: 424, w: 224, h: 62, title: "Fixture runner", sub: "fixtures mode", tone: "dashed" });
    c.node({ x: 736, y: 424, w: 188, h: 62, title: "Python runner", sub: "engine mode", tone: "dashed" });
    c.node({ x: 488, y: 516, w: 224, h: 70, title: "dbt on DuckDB", sub: "through a warehouse shim", shape: "store" });
    c.node({ x: 736, y: 516, w: 188, h: 62, title: "Competing-risks model" });

    // browser to the Worker
    c.edge([[316, 26], [155, 26], [155, 132]], { both: true, label: "WebSocket", at: [236, 26] });
    c.edge([[456, 52], [456, 132]], { both: true, label: "WebSocket", at: [462, 82], anchor: "start" });
    c.edge([[596, 26], [802, 26], [802, 132]], { label: "HTTP", at: [700, 26] });
    // inside the Worker
    c.edge([[155, 194], [155, 262]], { label: "tool calls", at: [161, 228], anchor: "start" });
    c.edge([[456, 194], [456, 262]], { both: true, label: "jobs, events", at: [462, 228], anchor: "start" });
    c.edge([[680, 180], [590, 180]], {});
    c.label(635, 146, "lease,\ncomplete");
    // to the model text and the data
    c.edge([[290, 163], [306, 163], [306, 424]], {});
    c.edge([[115, 324], [115, 424]], { dashed: true, label: "fixtures\nmode", at: [121, 360], anchor: "start" });
    c.edge([[250, 324], [250, 364], [457, 364], [457, 551], [488, 551]], { dashed: true, label: "engine mode", at: [380, 364] });
    // the runners lease jobs through the API
    c.edge([[700, 424], [700, 194]], { dashed: true, both: true });
    c.edge([[830, 424], [830, 194]], { dashed: true, both: true });
    c.label(765, 238, "lease,\nheartbeat,\ncomplete");
    c.edge([[830, 486], [830, 516]], {});
    c.edge([[760, 486], [760, 501], [600, 501], [600, 516]], {});
  },
};

/** D2: sources land once, the warehouse builds as of a cutoff, and the gate decides what publishes. */
const sourcesToPublished: Diagram = {
  name: "sources-to-published",
  title: "From sources to a published forecast",
  subtitle: "Each source lands once; the checks and the candidate run meet at the publication gate, which has three outcomes.",
  footer: "Code: engine/src/staysignal (ingest, features, model, quality), warehouse/ (dbt) and src/worker/workflows/routine-workflow.ts",
  height: 660,
  draw: (c) => {
    const o = 60;
    const n = (spec: NodeSpec) => c.node({ ...spec, x: spec.x + o });
    const e = (pts: [number, number][], opts: EdgeOpts = {}) => c.edge(pts.map(([x, y]) => [x + o, y] as [number, number]), opts.at ? { ...opts, at: [opts.at[0] + o, opts.at[1]] } : opts);
    n({ x: 0, y: 0, w: 210, h: 64, title: "Sources", sub: "HRIS, payroll, ATS, org" });
    n({ x: 262, y: 0, w: 210, h: 64, title: "Landing", sub: "content-addressed, read-only", shape: "store" });
    n({ x: 524, y: 0, w: 240, h: 64, title: "dbt staging", sub: "versioned mappings, as of a cutoff" });
    e([[210, 32], [262, 32]]);
    e([[472, 32], [524, 32]]);

    n({ x: 252, y: 124, w: 200, h: 60, title: "Checks", sub: "every source, every run" });
    n({ x: 524, y: 124, w: 240, h: 60, title: "Point-in-time features", sub: "as known at the cutoff" });
    n({ x: 524, y: 224, w: 240, h: 60, title: "Competing-risks model", sub: "80% and 95% ranges" });
    n({ x: 524, y: 324, w: 240, h: 60, title: "Candidate run" });
    e([[600, 64], [600, 94], [352, 94], [352, 124]]);
    e([[644, 64], [644, 124]]);
    e([[644, 184], [644, 224]]);
    e([[644, 284], [644, 324]]);

    n({ x: 398, y: 414, w: 196, h: 100, title: "Publication gate", shape: "diamond" });
    e([[352, 184], [352, 464], [398, 464]]);
    e([[644, 384], [644, 464], [594, 464]]);

    n({ x: 150, y: 590, w: 220, h: 64, title: "Published", sub: "a new version beside the old one", tone: "accent" });
    n({ x: 386, y: 590, w: 220, h: 64, title: "Held for review", sub: "the published forecast stays", tone: "critical" });
    n({ x: 622, y: 590, w: 220, h: 64, title: "Waits for approval", sub: "a person decides", tone: "warning" });
    e([[496, 514], [496, 548], [260, 548], [260, 590]], { accent: true, label: "checks pass, within tolerance", at: [378, 548] });
    e([[496, 548], [496, 590]], { label: "a check fails", at: [503, 570], anchor: "start" });
    e([[496, 548], [732, 548], [732, 590]], { label: "change beyond tolerance", at: [620, 548] });
  },
};

interface Message {
  from: number;
  to: number;
  text: string;
  reply?: boolean;
  accent?: boolean;
}

const LANES = ["Payroll extract", "RoutineWorkflow", "Engine jobs", "Specialist agents", "Data Engineer"];
const MESSAGES: readonly Message[] = [
  { from: 0, to: 1, text: "arrives with a new pay-basis code" },
  { from: 1, to: 2, text: "ingest, run checks, score a candidate run" },
  { from: 2, to: 1, text: "pay checks fail", reply: true },
  { from: 1, to: 1, text: "gate holds the run; the published forecast does not move" },
  { from: 1, to: 3, text: "data-quality, model and composition reports" },
  { from: 3, to: 1, text: "one merged investigation", reply: true },
  { from: 1, to: 2, text: "propose a mapping fix from the evidence" },
  { from: 2, to: 1, text: "deterministic mapping proposal", reply: true },
  { from: 4, to: 1, text: "approves the fix (an agent cannot)", accent: true },
  { from: 1, to: 2, text: "rebuild under the new mapping, re-check, compare" },
  { from: 2, to: 1, text: "checks pass, change within tolerance", reply: true },
  { from: 1, to: 1, text: "publish a new version beside the old one" },
  { from: 1, to: 2, text: "replay in a fresh warehouse" },
  { from: 2, to: 1, text: "identical business-result hash", reply: true },
];

/** Lifeline positions: the workflow and the engine jobs, which carry most messages, sit furthest apart. */
const LANE_X = [75, 265, 520, 700, 869];
const laneX = (i: number) => LANE_X[i] ?? 0;

/** The height of each message row: one or two label lines. */
function messageLines(m: Message): string[] {
  const room = m.from === m.to ? 250 : Math.abs(laneX(m.to) - laneX(m.from)) - 24;
  return wrap(m.text, room, LABEL);
}

const rowHeight = (m: Message) => 34 + messageLines(m).length * 16 + (m.from === m.to ? 14 : 0);

/** D3: the routine that holds a bad payroll file, waits for a person and publishes the repair. */
const holdAndRepair: Diagram = {
  name: "hold-and-repair",
  title: "Holding and repairing a bad payroll file",
  subtitle: "The routine behind the public demo's data-health beat. In the public demo the engine's job results were recorded from the engine; the workflow, its gates, the approval and the audit run live in each visitor's sandbox.",
  footer: "Code: src/worker/workflows/routine-workflow.ts and gates.ts, src/worker/agents/investigation",
  legend: [
    { glyph: "line", color: "ink3", label: "Request" },
    { glyph: "dash", color: "ink3", label: "Result" },
    { glyph: "line", color: "vol", label: "A person's approval" },
  ],
  height: 64 + MESSAGES.reduce((a, m) => a + rowHeight(m), 0) + 16,
  draw: (c, th) => {
    const top = 52;
    const bottom = 64 + MESSAGES.reduce((a, m) => a + rowHeight(m), 0) + 10;
    LANES.forEach((name, i) => {
      const x = laneX(i);
      c.raw(line(c.X(x), c.Y(top), c.X(x), c.Y(bottom), th.axis, 1.5, "4 4"));
      c.node({ x: x - 75, y: 0, w: 150, h: top, title: name, tone: i === 4 ? "person" : "plain", sub: i === 4 ? "a person" : undefined });
    });
    let y = 64;
    MESSAGES.forEach((m, k) => {
      const lines = messageLines(m);
      const h = rowHeight(m);
      const ay = y + 20 + lines.length * 16;
      const x1 = laneX(m.from);
      const x2 = laneX(m.to);
      if (m.from === m.to) {
        c.edge([[x1, ay - 7], [x1 + 36, ay - 7], [x1 + 36, ay + 7], [x1 + 4, ay + 7]], {});
        lines.forEach((l, i) => c.label(x1 + 44, ay - 7 - (lines.length - i) * 16 + 8, l, "start"));
      } else {
        c.edge([[x1, ay], [x2 + (x2 > x1 ? -2 : 2), ay]], { dashed: m.reply, accent: m.accent });
        const mid = (x1 + x2) / 2;
        lines.forEach((l, i) => c.label(mid, ay - 16 - (lines.length - 1 - i) * 16, l, "middle", m.accent ? th.ink : th.ink2));
      }
      // the step number, at the start of the arrow
      const nx = x1 + (m.from === m.to ? 0 : x2 > x1 ? 14 : -14);
      c.raw(`<circle cx="${fx(c.X(nx))}" cy="${fx(c.Y(ay))}" r="9" fill="${th.vol}"/>`);
      c.raw(centered(c.X(nx), c.Y(ay), String(k + 1), { size: 11, weight: 600, fill: th.surface, anchor: "middle" }));
      y += h;
    });
  },
};

/** D4: a review's states; the refusal and the rollback of a rollback included. */
const reviewStates: Diagram = {
  name: "review-states",
  title: "Approving a review",
  subtitle: "Every transition, refusals included, is a new entry in the hash-chained action log; nothing is edited or deleted.",
  footer: "Code: src/worker/agents/workspace-agent.ts (approve, reject, rollback)",
  height: 316,
  draw: (c, th) => {
    const y = 86;
    const h = 60;
    const mid = y + h / 2;
    c.raw(`<circle cx="${fx(c.X(16))}" cy="${fx(c.Y(mid))}" r="9" fill="${th.ink}"/>`);
    c.node({ x: 52, y, w: 170, h, title: "Draft", sub: "the chat prepares it" });
    c.node({ x: 318, y, w: 150, h, title: "Submitted", sub: "by a lead" });
    c.node({ x: 584, y, w: 150, h, title: "Approved", sub: "creates owned tasks", tone: "accent" });
    c.node({ x: 806, y, w: 138, h, title: "Rolled back", sub: "with a reason" });
    c.node({ x: 318, y: 232, w: 150, h: 56, title: "Rejected" });
    c.edge([[25, mid], [52, mid]]);
    c.edge([[222, mid], [318, mid]], { label: "submits", at: [270, mid - 14] });
    c.edge([[468, mid], [584, mid]], { accent: true, label: "a different\nlead approves", at: [526, mid - 30] });
    c.edge([[734, mid], [806, mid]], { label: "rolls back", at: [770, mid - 14] });
    c.edge([[875, y], [875, 44], [659, 44], [659, y]], { label: "rolls back the rollback, with a reason", at: [767, 24] });
    c.edge([[393, y + h], [393, 232]], { label: "rejected", at: [400, 189], anchor: "start" });
    // the refusal: a note on the approval step
    c.raw(`<rect x="${fx(c.X(584))}" y="${fx(c.Y(204))}" width="360" height="84" rx="8" fill="${th.sunk}" stroke="${th.critical}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
    const note = wrap("If the lead who submitted it tries to approve it, the attempt is refused with SELF_APPROVAL and logged; the review stays submitted.", 330, SUB);
    note.forEach((l, i) => c.raw(centered(c.X(600), c.Y(246 - ((note.length - 1) * 18) / 2 + i * 18), l, { size: SUB, fill: th.ink, anchor: "start" })));
    c.edge([[584, 246], [520, 246], [520, 128], [470, 128]], { dashed: true });
  },
};

export const DIAGRAMS: readonly Diagram[] = [architecture, sourcesToPublished, holdAndRepair, reviewStates];

function render(d: Diagram, th: Theme): string {
  const chart: Chart = {
    name: d.name,
    width: FULL,
    title: d.title,
    subtitle: d.subtitle,
    legend: d.legend ?? [],
    footer: d.footer,
    bodyHeight: d.height,
    body: (g, t) => {
      const c = new Canvas(g, t, `${d.name}-${t.mode}`);
      d.draw(c, t);
      return c.toString();
    },
  };
  return card(resolveLegend(chart, th), th);
}

/** Every diagram file, light and dark, keyed by its path from the repository root. */
export function renderDiagrams(): Map<string, string> {
  const files = new Map<string, string>();
  for (const th of THEMES) for (const d of DIAGRAMS) files.set(`${DIAGRAM_DIR}/${d.name}-${th.mode}.svg`, render(d, th));
  return files;
}
