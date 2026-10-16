// The README's charts (scripts/lib/figures.ts) and diagrams (scripts/lib/diagrams.ts): committed exactly as rendered
// from the committed results and code, colored only with the app's design tokens, labeled for screen readers, the
// charts synthetic and sourced, the diagrams naming the code they describe, and free of the characters and screens the
// hygiene rules keep out.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DIAGRAM_DIR, DIAGRAMS } from "../../scripts/lib/diagrams.ts";
import { fx, THEMES, TOKEN_OF, textWidth, wrap } from "../../scripts/lib/figures.ts";
import { FIGURES, latest, loadReports } from "../../scripts/lib/results.ts";
import { renderFigureFiles, staleFigures } from "../../scripts/render-figures.ts";

function block(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const out = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

const files = renderFigureFiles(process.cwd());
const charts = [...files].filter(([p]) => p.includes("/figures/"));

describe("README figures", () => {
  it("commits every figure exactly as a fresh render draws it", () => {
    expect(staleFigures(process.cwd(), files)).toEqual([]);
    for (const f of FIGURES) for (const mode of ["light", "dark"]) expect(files.has(`docs/images/figures/${f.name}-${mode}.svg`), f.name).toBe(true);
  });

  it("takes every color from the design tokens, in both modes", () => {
    const css = readFileSync("src/web/design/tokens.css", "utf8");
    const light = block(css, ":root {");
    const dark = block(css, ':root[data-theme="dark"] {');
    for (const th of THEMES) {
      for (const [slot, token] of Object.entries(TOKEN_OF)) {
        const want = th.mode === "light" ? light.get(token) : (dark.get(token) ?? light.get(token));
        expect(th[slot as keyof typeof TOKEN_OF], `${th.mode} ${slot}`).toBe(want);
      }
    }
    for (const [path, svg] of files) {
      const th = THEMES.find((t) => path.endsWith(`-${t.mode}.svg`))!;
      const palette = new Set(Object.keys(TOKEN_OF).map((k) => th[k as keyof typeof TOKEN_OF]));
      for (const m of svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)) expect(palette.has(m[1]!) || m[1] === "none", `${path}: ${m[1]}`).toBe(true);
    }
  });

  it("labels every chart for screen readers and says its data is synthetic, with command, date and file", () => {
    for (const [path, svg] of files) {
      expect(svg, path).toMatch(/^<svg [^>]*role="img"/);
      expect(svg, path).toMatch(/<title id="[^"]+">[^<]+<\/title>/);
      if (path.includes("/figures/")) {
        expect(svg, path).toMatch(/<desc id="[^"]+">[^<]+<\/desc>/);
        expect(svg, path).toContain("Synthetic data (fictional Larkspur Systems)");
        expect(svg, path).toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(svg, path).toMatch(/(results|evals\/results)\/[\w.-]+\.json/);
      }
    }
  });

  it("never writes a dash, a minus sign, NaN or undefined, and stays small", () => {
    for (const [path, svg] of files) {
      expect(svg, path).not.toMatch(/[\u2013\u2014\u2212]/);
      expect(svg, path).not.toMatch(/NaN|undefined|Infinity/);
      expect(Buffer.byteLength(svg), path).toBeLessThan(150_000);
    }
  });

  it("draws the action audit's proxy screens only, never the audit-only one", () => {
    for (const [path, svg] of charts.filter(([p]) => p.includes("action-audit"))) {
      expect(svg, path).not.toContain("40 or over");
      expect(svg, path).not.toMatch(/\bage\b/i);
    }
  });

  it("agrees with the recorded summary it is drawn from", () => {
    const reports = loadReports(process.cwd());
    const bt = latest(reports, "backtest")!.report;
    const level = bt.levels["company|3"]!;
    const svg = files.get("docs/images/figures/backtest-company-3m-light.svg")!;
    expect(svg).toContain(`held in ${Math.round(level.coverage80 * level.windows)} of ${level.windows} mature windows (${level.effective_windows} independent)`);
    expect(svg).toContain(`the 95% range in ${Math.round(level.coverage95 * level.windows)}.`);
    const research = files.get("docs/images/figures/research-light.svg")!;
    const r = latest(reports, "research")!.report;
    expect(research).toContain(`${r.seeds.length} seeds, ${r.origins.length} quarterly origins`);
  });

  it("draws every diagram in both modes, labeled, naming code that exists", () => {
    for (const d of DIAGRAMS) {
      for (const mode of ["light", "dark"]) {
        const svg = files.get(`${DIAGRAM_DIR}/${d.name}-${mode}.svg`);
        expect(svg, d.name).toBeDefined();
        expect(svg).toMatch(/<desc id="[^"]+">Code: |<desc id="[^"]+">[^<]+ Code: /);
        expect(svg).toContain(`marker-end="url(#${d.name}-${mode}-`);
      }
      const paths = [...d.footer.matchAll(/((?:src|scripts|engine|warehouse)\/[\w./-]+)/g)].map((m) => m[1]!.replace(/[.,]$/, ""));
      expect(paths.length, d.name).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(p), `${d.name}: ${p}`).toBe(true);
    }
  });

  it("formats numbers without negative zero and wraps text inside its width", () => {
    expect(fx(-0.04)).toBe("0.0");
    expect(fx(-1.25, 1)).toBe("-1.3");
    const lines = wrap("Each dot is one of the competing-risks model's slopes, fitted on a world whose hazards have its form", 300, 15);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(textWidth(l, 15)).toBeLessThanOrEqual(300);
  });
});
