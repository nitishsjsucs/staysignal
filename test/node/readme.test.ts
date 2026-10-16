// The README is a front page: one title, a handful of sections, short lines and tables, every link and image
// resolving, every chart switching with the theme, the synthetic label up front, and the anchor the deployed public
// demo links to. The docs pages it sends readers to are checked for broken links too.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const README = readFileSync("README.md", "utf8");
const PAGES = ["README.md", "docs/STATUS.md", "docs/PUBLIC-DEMO.md", "docs/DEVELOPMENT.md", "docs/REUSE.md", "docs/RESULTS.md", "docs/runbooks/prod-setup.md"];

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

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function anchors(md: string): Set<string> {
  const out = new Set<string>();
  for (const l of prose(md)) {
    const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(l);
    if (m) out.add(slug(m[1]!.replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")));
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

  it("keeps lines and tables short", () => {
    expect(lines.filter((l) => l.length > 400)).toEqual([]);
    expect(lines.filter((l) => l.startsWith("|")).length).toBeLessThanOrEqual(40);
  });

  it("keeps the heading the deployed public demo links to", () => {
    const demo = readFileSync("src/web/demo.ts", "utf8");
    const fragment = /WALKTHROUGH_URL = `\$\{SOURCE_URL\}#([\w-]+)`/.exec(demo)?.[1];
    expect(fragment).toBe("walkthrough-in-screenshots");
    expect(anchors(README).has(fragment!)).toBe(true);
  });

  it("gives every image a description and every chart its dark twin", () => {
    for (const img of README.match(/<img [^>]*>/g) ?? []) expect(img, img).toMatch(/alt="[^"]+"/);
    for (const m of README.matchAll(/src="([^"]+)-light\.svg"/g)) {
      expect(README).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${m[1]}-dark.svg">`);
    }
    for (const pic of README.match(/<picture>[\s\S]*?<\/picture>/g) ?? []) expect(pic).toMatch(/<source [^>]+>[\s\S]*<img /);
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
    expect(README.match(/```mermaid/g)?.length).toBeGreaterThanOrEqual(1);
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
        expect(existsSync(file), `${page} -> ${t}`).toBe(true);
        if (hash && file.endsWith(".md")) expect(anchors(readFileSync(file, "utf8")).has(hash), `${page} -> ${t}`).toBe(true);
      }
    });
  }
});
