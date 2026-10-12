// Memory search over an exported memory (SPEC 14.10): the fixtures mode's equivalent of the engine's `git grep -n -i`
// search (engine/src/staysignal/memory/search.py), used where git is not available (CI, the fixtures deployment). It
// returns the same hits for the same files: terms of three or more characters minus stop words, alias expansion from
// the alias table and front-matter aliases, case-insensitive substring matches per line, ranked by hits then recency.
// A vitest test checks it against the Python results exported with the fixture.

export interface MemoryFileText {
  text: string;
  commit: string;
  date: string;
}

export interface MemoryHit {
  path: string;
  line: number;
  snippet: string;
  hits: number;
  commit: string;
  date: string;
}

const STOP = new Set(
  "the and for did was were what when why how who with about last time our that this have has are from into decide decided decision any there use used uses does happened should would could tell remind show please".split(
    " ",
  ),
);

export function terms(query: string): string[] {
  const out = new Set<string>();
  for (const m of query.toLowerCase().matchAll(/[A-Za-z0-9@#_.-]{3,}/g)) {
    const w = m[0].replace(/^[.-]+|[.-]+$/g, "");
    if (w.length >= 3 && !STOP.has(w)) out.add(w);
  }
  return [...out].sort();
}

function frontMatter(text: string): { id?: string; aliases: string[] } {
  if (!text.startsWith("---\n")) return { aliases: [] };
  const end = text.indexOf("\n---\n", 4);
  const meta = text.slice(4, end);
  const id = /^id: (.+)$/m.exec(meta)?.[1]?.trim();
  const al = /^aliases: \[(.*)\]$/m.exec(meta)?.[1] ?? "";
  const aliases = al
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  return { ...(id ? { id } : {}), aliases };
}

export function expansions(files: Record<string, MemoryFileText>, aliases: Record<string, string[]>, query: string): string[] {
  const q = query.toLowerCase();
  const out = new Set<string>();
  for (const [phrase, extra] of Object.entries(aliases)) if (q.includes(phrase.toLowerCase())) for (const e of extra) out.add(String(e).toLowerCase());
  for (const [path, f] of Object.entries(files)) {
    if (!path.endsWith(".md")) continue;
    const fm = frontMatter(f.text);
    if (fm.id && fm.aliases.some((a) => q.includes(a.toLowerCase()))) out.add(fm.id.toLowerCase());
  }
  return [...out].sort();
}

function count(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function searchMemory(files: Record<string, MemoryFileText>, aliases: Record<string, string[]>, query: string, limit = 5): MemoryHit[] {
  const ts = [...new Set([...terms(query), ...expansions(files, aliases, query)])].sort();
  if (!ts.length) return [];
  const hits: MemoryHit[] = [];
  for (const path of Object.keys(files).sort()) {
    if (path.startsWith("index/")) continue;
    const f = files[path]!;
    const lines = f.text.replace(/\n$/, "").split("\n");
    const matched: { num: number; text: string; n: number }[] = [];
    lines.forEach((text, i) => {
      const low = text.toLowerCase();
      if (ts.some((t) => low.includes(t))) matched.push({ num: i + 1, text, n: ts.reduce((s, t) => s + count(low, t), 0) });
    });
    if (!matched.length) continue;
    const score = matched.reduce((s, m) => s + m.n, 0);
    // the best-matching dated bullet, else the matching title, else (a front-matter match only) the note's title
    const bullets = matched.filter((m) => m.text.startsWith("- "));
    const titles = matched.filter((m) => m.text.startsWith("# "));
    const body = bullets.length ? bullets : titles;
    const titleAt = lines.findIndex((l) => l.startsWith("# "));
    const best = body.length
      ? body.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.num < a.num) ? b : a))
      : titleAt >= 0
        ? { num: titleAt + 1, text: lines[titleAt]!, n: 0 }
        : { num: 1, text: path, n: 0 };
    hits.push({ path, line: best.num, snippet: best.text.trim(), hits: score, commit: f.commit, date: f.date });
  }
  hits.sort((a, b) => b.hits - a.hits || Date.parse(b.date) - Date.parse(a.date) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return hits.slice(0, limit);
}

function flowList(meta: string, key: string): string[] {
  const raw = new RegExp(`^${key}: \\[(.*)\\]$`, "m").exec(meta)?.[1] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

/** Front matter (id, type, aliases, links), title and dated bullets of a memory note (memory/notes.py). */
export function parseNote(text: string): { meta: Record<string, unknown>; title: string; bullets: { date: string; text: string }[] } {
  let body = text;
  const meta: Record<string, unknown> = {};
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    const fm = text.slice(4, end);
    body = text.slice(end + 5);
    for (const key of ["id", "type"]) {
      const v = new RegExp(`^${key}: (.+)$`, "m").exec(fm)?.[1]?.trim();
      if (v) meta[key] = v;
    }
    meta.aliases = flowList(fm, "aliases");
    meta.links = flowList(fm, "links");
  }
  let title = "";
  const bullets: { date: string; text: string }[] = [];
  for (const line of body.split("\n")) {
    if (!title && line.startsWith("# ")) title = line.slice(2).trim();
    const m = /^- (\d{4}-\d{2}-\d{2}): (.+)$/.exec(line.trim());
    if (m) bullets.push({ date: m[1]!, text: m[2]!.trim() });
  }
  return { meta, title, bullets };
}
