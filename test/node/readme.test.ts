// The README is a front page: one title, a handful of sections, short lines and tables, every link and image
// resolving, every chart and diagram switching with the theme and opening full size, the synthetic label up front, and
// the anchor the deployed public demo links to. Every Markdown page a reader can reach from it is checked for broken
// links and anchors too, with GitHub's own heading anchors and case-sensitive file names.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { DIAGRAMS } from "../../scripts/lib/diagrams.ts";

const README = readFileSync("README.md", "utf8");
/** The repository's files as git sees them (tracked, or new and not ignored), so a name's case must match exactly. */
const FILES = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
const FILE_SET = new Set(FILES);
const exists = (p: string) => FILE_SET.has(p) || FILES.some((f) => f.startsWith(`${p.replace(/\/$/, "")}/`));
const PAGES = ["README.md", "SPEC.md", "CONTEXT.md", "research/PREREGISTRATION.md", ...FILES.filter((f) => /^docs\/.*\.md$/.test(f))];

/** Lines outside fenced code blocks. */
function prose(md: string): string[] {
  let fence = false;
  return md.split("\n").filter((l) => {
    if (/^\s{0,3}```/.test(l)) {
      fence = !fence;
      return false;
    }
    return !fence;
  });
}

/** GitHub's heading anchors (github-slugger): lowercase, everything but letters, marks, numbers, connector
 * punctuation, spaces and hyphens dropped, spaces to hyphens, and a repeated anchor numbered -1, -2 and so on. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const l of prose(md)) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(l);
    if (!m) continue;
    const base = slug(m[1]!.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    let s = base;
    for (let k = 1; out.has(s); k++) s = `${base}-${k}`;
    out.add(s);
  }
  return out;
}

/** Every relative target of a Markdown link or an href, src or srcset attribute, outside code. */
function targets(md: string): string[] {
  const text = prose(md)
    .map((l) => l.replace(/`[^`]*`/g, ""))
    .join("\n");
  const found = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((m) => m[1]!);
  return found.filter((t) => !/^(https?:|mailto:)/.test(t));
}

describe("README", () => {
  const lines = README.split("\n");

  it("has one title and between 8 and 12 sections", () => {
    expect(README.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(prose(README).filter((l) => /^# /.test(l))).toEqual([]);
    const h2 = prose(README).filter((l) => /^## /.test(l));
    expect(h2.length).toBeGreaterThanOrEqual(8);
    expect(h2.length).toBeLessThanOrEqual(12);
  });

  it("keeps lines, code lines and tables short", () => {
    expect(lines.filter((l) => l.length > 400)).toEqual([]);
    expect(lines.filter((l) => l.startsWith("|")).length).toBeLessThanOrEqual(45);
    let fence = false;
    const code: string[] = [];
    for (const l of lines) {
      if (/^\s{0,3}```/.test(l)) fence = !fence;
      else if (fence) code.push(l);
    }
    expect(code.length).toBeGreaterThan(0);
    expect(code.filter((l) => l.length > 80)).toEqual([]);
  });

  it("keeps the heading the deployed public demo links to", () => {
    const demo = readFileSync("src/web/demo.ts", "utf8");
    const fragment = /WALKTHROUGH_URL = `\$\{SOURCE_URL\}#([\w-]+)`/.exec(demo)?.[1];
    expect(fragment).toBe("walkthrough-in-screenshots");
    expect(anchors(README).has(fragment!)).toBe(true);
  });

  it("gives every image a description and every chart and diagram its dark twin", () => {
    for (const img of README.match(/<img [^>]*>/g) ?? []) expect(img, img).toMatch(/alt="[^"]+"/);
    for (const m of README.matchAll(/src="([^"]+)-light\.svg"/g)) {
      expect(README).toMatch(new RegExp(`<source media="\\(prefers-color-scheme: dark\\)"\\s+srcset="${m[1]}-dark\\.svg">`));
    }
    for (const pic of README.match(/<picture>[\s\S]*?<\/picture>/g) ?? []) expect(pic).toMatch(/<source [^>]+>[\s\S]*<img /);
  });

  it("opens every chart and diagram full size, and every walkthrough detail on its full screen", () => {
    const pictures = [...README.matchAll(/<a href="([^"]+)"><picture>([\s\S]*?)<\/picture><\/a>/g)];
    const linked = pictures.filter(([, , body]) => /docs\/images\/(figures|diagrams)\//.test(body!));
    const all = README.match(/<picture>[\s\S]*?<\/picture>/g)?.filter((p) => /docs\/images\/(figures|diagrams)\//.test(p)) ?? [];
    expect(all.length).toBeGreaterThanOrEqual(8);
    expect(linked.length).toBe(all.length);
    for (const [, href, body] of linked) expect(body, href).toContain(`src="${href}"`);
    const details = [...README.matchAll(/<a href="(docs\/screenshots\/[^"]+)"><img src="(docs\/screenshots\/detail\/[^"]+)"/g)];
    expect(details.length).toBeGreaterThanOrEqual(8);
    for (const [, full, crop] of details) expect(full!.split("/").pop()).toBe(crop!.split("/").pop());
  });

  it("draws its diagrams as static images, never as Mermaid blocks a viewer's controls can cover", () => {
    expect(README).not.toContain("```mermaid");
    for (const d of DIAGRAMS) expect(README).toContain(`src="docs/images/diagrams/${d.name}-light.svg"`);
  });

  it("names the domain, what it is built with and the limits up front", () => {
    const hero = README.slice(0, README.indexOf("## What it does"));
    expect(hero).toMatch(/People Analytics/);
    expect(hero).toMatch(/attrition/);
    expect(hero).toMatch(/\*\*Built with\*\*/);
    expect(hero).toContain("<!-- proof:start -->");
    expect(hero).toContain('href="#limits"');
    expect(hero).toContain('href="#run-it-locally"');
    expect(hero).toContain('href="#status"');
    expect(README).toMatch(/^### Limits$/m);
  });

  it("says up front that everything is synthetic, in one important alert and at most two alerts", () => {
    expect(README.match(/\[!IMPORTANT\]/g)?.length).toBe(1);
    expect(README.match(/> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/g)?.length).toBeLessThanOrEqual(2);
    const alert = README.slice(README.indexOf("[!IMPORTANT]"), README.indexOf("## "));
    expect(alert).toMatch(/synthetic/i);
    expect(alert).toContain("Larkspur Systems");
    expect(README).toContain("Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.");
  });

  it("uses no forced diagram theme, script, frame or inline style, no dash and nothing from the audit-only screen", () => {
    expect(README).not.toMatch(/%%\{init|<script|<iframe|\sstyle="/);
    expect(README).not.toMatch(/[\u2013\u2014]/);
    expect(README).not.toContain("40 or over");
  });

  it("keeps the guided-tour animation and its still poster small", () => {
    expect(statSync("docs/images/tour.gif").size).toBeLessThanOrEqual(3_000_000);
    expect(statSync("docs/images/tour-poster.png").size).toBeLessThanOrEqual(400_000);
    expect(README).toContain('<source media="(prefers-reduced-motion: reduce)" srcset="docs/images/tour-poster.png">');
  });
});

describe("README and the docs pages it links", () => {
  for (const page of PAGES) {
    it(`${page}: every relative link, image and anchor resolves`, () => {
      const md = readFileSync(page, "utf8");
      for (const t of targets(md)) {
        const [path, hash] = t.split("#") as [string, string | undefined];
        const file = path ? normalize(join(dirname(page), decodeURIComponent(path))) : page;
        expect(exists(file), `${page} -> ${t}`).toBe(true);
        if (hash && file.endsWith(".md")) expect(anchors(readFileSync(file, "utf8")).has(hash), `${page} -> ${t}`).toBe(true);
      }
    });
  }
});
