// Hygiene rules (SPEC 22.6). Pure functions over text so they are unit-tested (test/node/hygiene.test.ts).
//
// Public tier (committed, runs in CI and in the pre-commit hook):
//   - every tracked text file: no em or en dashes;
//   - pinned and hashed paths: no git SHA (the operator's publisher rewrites working SHAs in committed text);
//   - generated text (decompressed Lab recordings, demo recordings, evals, memory seeds, fixtures): a generic list
//     of monitoring and special-category terms, and a personal-name heuristic;
//   - prose: the personal-name heuristic outside citation context;
//   - every tracked file: private keys with key material and access tokens.
// Private tier (pre-commit hook only): terms from a deny-list kept outside the repository, read from the path in
// SS_PRIVATE_DENYLIST. The list itself is never committed.

export interface HygieneHit {
  file: string;
  line: number;
  rule: "dash" | "git-sha" | "monitoring-term" | "person-name" | "secret" | "private-term";
  excerpt: string;
}

/** Generic workplace-monitoring and special-category terms that must never appear in generated text. */
export const MONITORING_TERMS: readonly string[] = [
  "keystroke",
  "keylogging",
  "key logging",
  "screen monitoring",
  "screen recording of employees",
  "screenshot monitoring",
  "location tracking",
  "gps tracking",
  "webcam monitoring",
  "mouse movement",
  "idle time tracking",
  "email surveillance",
  "email monitoring",
  "social media monitoring",
  "productivity monitoring",
  "medical condition",
  "health condition",
  "diagnosis",
  "pregnancy",
  "pregnant",
  "trade-union membership",
  "trade union membership",
  "union membership",
  "religious belief",
  "sexual orientation",
  "genetic data",
  "biometric",
];

/**
 * Common given names used by the personal-name heuristic. A hit is a listed given name followed by a capitalized
 * word. Words that are also everyday English (Will, May, Mark, Grace, Hope) are left out to keep false positives low.
 */
export const GIVEN_NAMES: readonly string[] = [
  "James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Christopher",
  "Daniel", "Matthew", "Anthony", "Donald", "Steven", "Paul", "Andrew", "Joshua", "Kenneth", "Kevin", "Brian",
  "George", "Timothy", "Ronald", "Edward", "Jason", "Jeffrey", "Ryan", "Jacob", "Gary", "Nicholas", "Eric",
  "Jonathan", "Stephen", "Larry", "Justin", "Scott", "Brandon", "Benjamin", "Samuel", "Gregory", "Alexander",
  "Patrick", "Raymond", "Jack", "Dennis", "Jerry", "Tyler", "Aaron", "Jose", "Adam", "Nathan", "Henry", "Zachary",
  "Douglas", "Peter", "Kyle", "Noah", "Ethan", "Jeremy", "Walter", "Christian", "Keith", "Roger", "Terry",
  "Sean", "Gerald", "Carl", "Harold", "Dylan", "Arthur", "Lawrence", "Jordan", "Jesse", "Bryan", "Billy", "Bruce",
  "Gabriel", "Logan", "Alan", "Juan", "Albert", "Willie", "Elijah", "Wayne", "Randy", "Vincent", "Liam", "Mason",
  "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen", "Lisa",
  "Nancy", "Betty", "Sandra", "Margaret", "Ashley", "Kimberly", "Emily", "Donna", "Michelle", "Carol", "Amanda",
  "Melissa", "Deborah", "Stephanie", "Rebecca", "Sharon", "Laura", "Cynthia", "Dorothy", "Amy", "Kathleen",
  "Angela", "Shirley", "Emma", "Brenda", "Pamela", "Nicole", "Anna", "Samantha", "Katherine", "Christine",
  "Debra", "Rachel", "Carolyn", "Janet", "Maria", "Olivia", "Heather", "Helen", "Catherine", "Diane", "Julie",
  "Victoria", "Joyce", "Lauren", "Kelly", "Christina", "Ruth", "Joan", "Virginia", "Judith", "Evelyn", "Hannah",
  "Andrea", "Megan", "Cheryl", "Jacqueline", "Madison", "Teresa", "Abigail", "Sophia", "Martha", "Sara", "Gloria",
  "Janice", "Kathryn", "Ann", "Isabella", "Judy", "Charlotte", "Julia", "Alice", "Diana", "Natalie", "Ava",
  "Priya", "Rahul", "Arjun", "Ananya", "Rohan", "Aisha", "Wei", "Mei", "Hiroshi", "Yuki", "Mohammed", "Fatima",
  "Carlos", "Sofia", "Lucas", "Mateo", "Elena", "Ivan", "Olga", "Ahmed", "Omar", "Leila", "Chen", "Jin", "Sanjay",
];

// The repository owner's name appears in LICENSE and NOTICE only.
export const NAME_ALLOWLIST: readonly string[] = ["Nitish Chowdary"];

const NAME_RE = new RegExp(`\\b(?:${GIVEN_NAMES.join("|")})\\s+[A-Z][a-z]{2,}\\b`, "g");
// Capitalized words that commonly follow a given name in prose without forming a person's name.
const NAME_FALSE_FOLLOWERS = new Set(["The", "And", "For", "With", "From", "Engineering", "Sales", "Systems"]);
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const GIT_SHA_RE = /\b[0-9a-f]{40}\b/g;
const PEM_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:\s|\\n|\\r)*([A-Za-z0-9+/=]{64,})/g;
const TOKEN_RE = /ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{32,}/g;

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function excerptAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 120);
}

function regexHits(text: string, file: string, re: RegExp, rule: HygieneHit["rule"]): HygieneHit[] {
  const out: HygieneHit[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    out.push({ file, line: lineOf(text, idx), rule, excerpt: excerptAt(text, idx) });
  }
  return out;
}

export function findDashes(text: string, file = "<input>"): HygieneHit[] {
  return regexHits(text, file, /[\u2013\u2014]/g, "dash");
}

export function findGitShas(text: string, file = "<input>"): HygieneHit[] {
  return regexHits(text, file, GIT_SHA_RE, "git-sha");
}

export function findSecrets(text: string, file = "<input>"): HygieneHit[] {
  return [...regexHits(text, file, PEM_RE, "secret"), ...regexHits(text, file, TOKEN_RE, "secret")];
}

function termRegex(terms: readonly string[]): RegExp | null {
  const cleaned = terms.map((t) => t.trim()).filter((t) => t.length > 0 && !t.startsWith("#"));
  if (cleaned.length === 0) return null;
  const escaped = cleaned.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`(?<![A-Za-z0-9])(?:${escaped.join("|")})(?![A-Za-z0-9])`, "gi");
}

const MONITORING_RE = termRegex(MONITORING_TERMS) as RegExp;

export function findMonitoringTerms(text: string, file = "<input>"): HygieneHit[] {
  return regexHits(text, file, MONITORING_RE, "monitoring-term");
}

/**
 * Personal-name heuristic: a listed given name followed by a capitalized word. With `citationContext`, lines that
 * carry a year (a citation such as "Card, Mas, Moretti and Saez 2012") are skipped: names are allowed only inside
 * citation and reference blocks.
 */
export function findPersonNames(text: string, file = "<input>", opts: { citationContext?: boolean } = {}): HygieneHit[] {
  const out: HygieneHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (opts.citationContext && YEAR_RE.test(line)) return;
    NAME_RE.lastIndex = 0;
    for (const m of line.matchAll(NAME_RE)) {
      const hit = m[0];
      const follower = hit.split(/\s+/)[1] ?? "";
      if (NAME_FALSE_FOLLOWERS.has(follower)) continue;
      if (NAME_ALLOWLIST.some((a) => hit.startsWith(a.split(" ")[0] ?? "\u0000") && line.includes(a))) continue;
      out.push({ file, line: i + 1, rule: "person-name", excerpt: line.trim().slice(0, 120) });
    }
  });
  return out;
}

/** Parses a private deny-list: one term per line, `#` comments and blank lines ignored. */
export function parseDenylist(contents: string): string[] {
  return contents
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

export function findPrivateTerms(text: string, terms: readonly string[], file = "<input>"): HygieneHit[] {
  const re = termRegex(terms);
  if (!re) return [];
  // Private-tier hits never print the matched term itself, only where it is.
  return regexHits(text, file, re, "private-term").map((h) => ({ ...h, excerpt: "(private term; excerpt withheld)" }));
}

/** Paths whose files are pinned or hashed: no git SHA may appear in them (ADR 0017). */
export const PINNED_PREFIXES: readonly string[] = ["data/", "models/", "lab/", "test/fixtures/", "research/"];

/** Paths that hold LLM-generated or generated data text. */
export const GENERATED_PREFIXES: readonly string[] = [
  "lab/recordings/",
  "demo/recordings/",
  "evals/",
  "engine/tests/fixtures/memory_seed/",
  "test/fixtures/",
];

export function isPinned(path: string): boolean {
  return PINNED_PREFIXES.some((p) => path.startsWith(p));
}

export function isGenerated(path: string): boolean {
  return GENERATED_PREFIXES.some((p) => path.startsWith(p));
}

/** Files whose dashes are allowed: lockfiles and third-party content. */
export function isDashExempt(path: string): boolean {
  return /(^|\/)(package-lock\.json|uv\.lock)$/.test(path) || path.startsWith("node_modules/") || path === "worker-configuration.d.ts";
}

export interface FileInput {
  path: string;
  text: string;
}

/** Runs the public tier (and the private tier when terms are given) over one file. */
export function checkFile(f: FileInput, privateTerms: readonly string[] | null = null): HygieneHit[] {
  const hits: HygieneHit[] = [];
  if (!isDashExempt(f.path)) hits.push(...findDashes(f.text, f.path));
  hits.push(...findSecrets(f.text, f.path));
  if (isPinned(f.path)) hits.push(...findGitShas(f.text, f.path));
  if (isGenerated(f.path)) {
    hits.push(...findMonitoringTerms(f.text, f.path));
    hits.push(...findPersonNames(f.text, f.path));
  } else if (f.path.endsWith(".md") && !/(^|\/)(LICENSE|NOTICE)$/.test(f.path)) {
    hits.push(...findPersonNames(f.text, f.path, { citationContext: true }));
  }
  if (privateTerms) hits.push(...findPrivateTerms(f.text, privateTerms, f.path));
  return hits;
}
