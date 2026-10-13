// The agent's memory writes without git (SPEC 14.10, production): the same rules as the engine's
// `memory/store.py` `write_note`, over a map of Markdown files. A timeline bullet, or an investigation or decision note
// (`INV-`/`DEC-<date>-NN`, the next free number) with a timeline bullet pointing at it; same-day bullets keep the order
// they were written; a repeated write changes nothing; a note that names a person, or links outside memory, is refused.
// The WorkspaceAgent stores the result with git-style hashes (src/worker/memory/githash.ts).
import type { MemoryNoteInput } from "../contracts";

export interface NoteDoc {
  meta: { id: string; type: string; aliases: string[]; links: string[] };
  title: string;
  bullets: [string, string][]; // [YYYY-MM-DD, text]
}

const PERSON = /\bE\d{6}\b|\b(?:wk|er|an|sr)_[a-z2-7]{20,}\b|@(?!larkspur\.example)[a-z0-9.-]+\.[a-z]{2,}/i;
const LINK = /^[a-z0-9][a-z0-9/_.-]{0,120}$/;
const NOTE_ID = /^(INV|DEC)-\d{4}-\d{2}-\d{2}-\d{2}$/;
const BULLET = /^- (\d{4}-\d{2}-\d{2}): (.+)$/;
const KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "~"]);

export class NoteRejected extends Error {}

function scalar(v: string): string {
  if (/^[A-Za-z][A-Za-z0-9 _./@#()+-]*$/.test(v) && !v.endsWith(" ") && !KEYWORDS.has(v.toLowerCase())) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

function unscalar(v: string): string {
  const s = v.trim();
  return s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s.replace(/^"|"$/g, "");
}

function list(fm: string, key: string): string[] {
  const m = new RegExp(`^${key}: \\[(.*)\\]$`, "m").exec(fm);
  if (!m || !m[1]!.trim()) return [];
  return m[1]!.split(",").map(unscalar).filter(Boolean);
}

export function parseDoc(text: string): NoteDoc {
  let body = text;
  let fm = "";
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    fm = text.slice(4, end);
    body = text.slice(end + 5);
  }
  const get = (k: string) => unscalar(new RegExp(`^${k}: (.+)$`, "m").exec(fm)?.[1] ?? "");
  let title = "";
  const bullets: [string, string][] = [];
  for (const line of body.split("\n")) {
    if (!title && line.startsWith("# ")) title = line.slice(2).trim();
    const b = BULLET.exec(line.trim());
    if (b) bullets.push([b[1]!, b[2]!.trim()]);
  }
  return { meta: { id: get("id"), type: get("type"), aliases: list(fm, "aliases"), links: list(fm, "links") }, title, bullets };
}

/** The engine's format: sorted front-matter keys, flow lists, the title, a blank line, dated bullets. */
export function renderDoc(n: NoteDoc): string {
  const flow = (xs: string[]) => `[${xs.map(scalar).join(", ")}]`;
  const meta = [`aliases: ${flow(n.meta.aliases)}`, `id: ${scalar(n.meta.id)}`, `links: ${flow(n.meta.links)}`, `type: ${scalar(n.meta.type)}`];
  return ["---", ...meta, "---", `# ${n.title}`, "", ...n.bullets.map(([d, t]) => `- ${d}: ${t}`)].join("\n") + "\n";
}

function check(text: string): string {
  const t = text.split(/\s+/).filter(Boolean).join(" ");
  if (!t || t.length > 400) throw new NoteRejected("a bullet must hold 1 to 400 characters");
  if (PERSON.test(t)) throw new NoteRejected("a memory note never names a person (cohort-level content only)");
  return t;
}

/** Adds bullets not already present; a stable sort by date keeps same-day bullets in the order they were written. */
export function appendBullets(old: [string, string][], add: [string, string][]): [string, string][] {
  const out = [...old];
  const seen = new Set(old.map(([d, t]) => `${d}\u0000${t}`));
  for (const b of add) {
    const k = `${b[0]}\u0000${b[1]}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(b);
    }
  }
  return out.map((b, i) => ({ b, i })).sort((x, y) => (x.b[0] < y.b[0] ? -1 : x.b[0] > y.b[0] ? 1 : x.i - y.i)).map((x) => x.b);
}

function nextId(files: Record<string, string>, prefix: "INV" | "DEC", day: string): string {
  const folder = prefix === "INV" ? "investigations" : "decisions";
  const taken = new Set(Object.keys(files).filter((p) => p.startsWith(`${folder}/`)).map((p) => p.slice(folder.length + 1, -3)));
  let n = 1;
  while (taken.has(`${prefix}-${day}-${String(n).padStart(2, "0")}`)) n++;
  return `${prefix}-${day}-${String(n).padStart(2, "0")}`;
}

export interface WriteResult {
  id: string | null;
  changed: Record<string, string>; // path -> new text (only files whose text changed)
  message: string;
}

export function writeNote(files: Record<string, string>, note: MemoryNoteInput & { id?: string }, at: string): WriteResult {
  if (!["timeline", "investigation", "decision"].includes(note.kind)) throw new NoteRejected("kind must be timeline, investigation or decision");
  if (!Array.isArray(note.bullets) || note.bullets.length < 1 || note.bullets.length > 12) throw new NoteRejected("a note has 1 to 12 bullets");
  const day = at.slice(0, 10);
  const bullets: [string, string][] = note.bullets.map((b) => [day, check(String(b))]);
  const dailyPath = `timeline/daily/${day}.md`;
  const daily = files[dailyPath] !== undefined ? parseDoc(files[dailyPath]!) : { meta: { id: `TL-${day}`, type: "timeline_daily", aliases: [], links: [] }, title: `Timeline ${day}`, bullets: [] };
  const next: Record<string, string> = {};
  let id: string | null = null;
  if (note.kind === "timeline") {
    daily.bullets = appendBullets(daily.bullets, bullets);
  } else {
    const prefix = note.kind === "investigation" ? "INV" : "DEC";
    id = note.id ?? nextId(files, prefix, day);
    if (!NOTE_ID.test(id) || !id.startsWith(prefix)) throw new NoteRejected(`not a ${note.kind} ID: ${id}`);
    const title = check(note.title ?? id);
    const given = (note.links ?? []).map(String);
    if (given.length > 8 || given.some((l) => !LINK.test(l) || l.includes(".."))) throw new NoteRejected("links are at most 8 memory paths");
    const aliases = (note.aliases ?? []).map((a) => check(String(a)));
    if (aliases.length > 8 || aliases.some((a) => a.length > 40)) throw new NoteRejected("aliases are at most 8 short phrases");
    const path = `${prefix === "INV" ? "investigations" : "decisions"}/${id}.md`;
    const existing = files[path] !== undefined ? parseDoc(files[path]!) : null;
    const doc: NoteDoc = {
      meta: {
        id,
        type: note.kind,
        aliases: [...new Set([...aliases, ...(existing?.meta.aliases ?? [])])].sort(),
        links: [...new Set([...given, ...(existing?.meta.links ?? []), `timeline/daily/${day}`])].sort(),
      },
      title,
      bullets: appendBullets(existing?.bullets ?? [], bullets),
    };
    next[path] = renderDoc(doc);
    daily.bullets = appendBullets(daily.bullets, [[day, `${id}: ${title}`]]);
  }
  next[dailyPath] = renderDoc(daily);
  const changed = Object.fromEntries(Object.entries(next).filter(([p, t]) => files[p] !== t));
  return { id, changed, message: `memory: ${note.kind} ${id ?? day}` };
}
