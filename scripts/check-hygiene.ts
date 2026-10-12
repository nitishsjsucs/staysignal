// Two-tier hygiene gate (SPEC 22.6). Usage:
//   node scripts/check-hygiene.ts                 public tier over every tracked file (CI)
//   node scripts/check-hygiene.ts --staged        public tier over staged files, read from the index (hook)
//   node scripts/check-hygiene.ts --private ...   adds the private tier; fails closed unless SS_PRIVATE_DENYLIST
//                                                 names a readable file outside the repository
// Gzipped files under generated paths (Lab recordings) are decompressed before scanning.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { checkFile, type HygieneHit, isGenerated, parseDenylist } from "./lib/hygiene.ts";

function git(args: string[], root: string): Buffer {
  return execFileSync("git", args, { cwd: root, maxBuffer: 1 << 30 });
}

export function decode(path: string, buf: Buffer): string | null {
  let data = buf;
  if (path.endsWith(".gz")) {
    if (!isGenerated(path)) return null;
    try {
      data = gunzipSync(buf);
    } catch {
      return null;
    }
  }
  if (data.includes(0)) return null; // binary
  return data.toString("utf8");
}

export function loadPrivateTerms(root: string, env: NodeJS.ProcessEnv = process.env): { terms: string[] } | { error: string } {
  const p = env.SS_PRIVATE_DENYLIST;
  if (!p) return { error: "SS_PRIVATE_DENYLIST is not set; the private tier fails closed (SPEC 22.6)" };
  const abs = resolve(p);
  if (!isAbsolute(p) && !existsSync(abs)) return { error: `SS_PRIVATE_DENYLIST=${p} does not exist` };
  const rel = relative(root, abs);
  if (!rel.startsWith("..")) return { error: "the private deny-list must live outside the repository" };
  if (!existsSync(abs)) return { error: `SS_PRIVATE_DENYLIST points at a missing file` };
  const terms = parseDenylist(readFileSync(abs, "utf8"));
  if (terms.length === 0) return { error: "the private deny-list is empty" };
  return { terms };
}

export function run(root: string, argv: string[]): { hits: HygieneHit[]; files: number; error?: string } {
  const staged = argv.includes("--staged");
  let privateTerms: string[] | null = null;
  if (argv.includes("--private")) {
    const loaded = loadPrivateTerms(root);
    if ("error" in loaded) return { hits: [], files: 0, error: loaded.error };
    privateTerms = loaded.terms;
  }
  const paths = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).toString("utf8").split("\0").filter(Boolean)
    : git(["ls-files", "-z"], root).toString("utf8").split("\0").filter(Boolean);
  const hits: HygieneHit[] = [];
  let files = 0;
  for (const path of paths) {
    let buf: Buffer;
    try {
      buf = staged ? git(["show", `:${path}`], root) : readFileSync(resolve(root, path));
    } catch {
      continue; // deleted in the working tree but still listed
    }
    const text = decode(path, buf);
    if (text === null) continue;
    files++;
    hits.push(...checkFile({ path, text }, privateTerms));
  }
  return { hits, files };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const { hits, files, error } = run(root, process.argv.slice(2));
  if (error) {
    console.error(`check-hygiene: ${error}`);
    process.exit(2);
  }
  for (const h of hits) console.error(`${h.file}:${h.line} ${h.rule}: ${h.excerpt}`);
  if (hits.length > 0) {
    console.error(`check-hygiene: ${hits.length} hit(s) in ${files} file(s)`);
    process.exit(1);
  }
  console.log(`check-hygiene: ${files} file(s) clean${process.argv.includes("--private") ? " (public and private tiers)" : " (public tier)"}`);
}
