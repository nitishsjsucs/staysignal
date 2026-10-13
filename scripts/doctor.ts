// npm run doctor [-- --local-only] (SPEC 23.3): read-only checks of everything the demo and the production paths need,
// in four groups (local, cloudflare, gcp, secrets). Each check is PASS, FAIL, MISSING, WARN, SKIP or INFO with the exact
// fix; a summary groups what is not passing by its fix. Never prints a secret value or an account identifier.
//
// Read only: every command goes through an allowlist of read commands (versions, whoami, lists, describes), and the
// doctor creates, changes and deletes nothing, locally or in either cloud. Pattern from PeopleLake scripts/doctor.ts
// (MIT): the status vocabulary, the summary grouped by fix and the read-only guard.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS } from "./lib/pids.ts";

export type Status = "PASS" | "FAIL" | "MISSING" | "WARN" | "SKIP" | "INFO";
export interface Check {
  group: "local" | "cloudflare" | "gcp" | "secrets";
  name: string;
  status: Status;
  detail?: string;
  fix?: string;
}

/** The commands the doctor may run (prefixes of the argument list); everything else is refused before it runs. */
export const READ_ONLY: readonly (readonly string[])[] = [
  ["npm", "--version"],
  ["uv", "--version"],
  ["uv", "python", "find"],
  ["uv", "run", "--project", "engine", "python", "--version"],
  ["docker", "version"],
  ["docker", "info"],
  ["git", "rev-parse", "--abbrev-ref", "HEAD"],
  ["npx", "wrangler", "--version"],
  ["npx", "wrangler", "whoami"],
  ["npx", "wrangler", "ai", "models", "list"],
  ["gcloud", "--version"],
  ["gcloud", "config", "get-value"],
  ["gcloud", "billing", "projects", "describe"],
  ["gcloud", "services", "list"],
  ["bq", "ls"],
  // read by setup:prod to show which planned steps are already done (lists and describes only)
  ["gcloud", "iam", "service-accounts", "list"],
  ["gcloud", "projects", "get-iam-policy"],
  ["npx", "wrangler", "r2", "bucket", "list"],
  ["npx", "wrangler", "secret", "list"],
  ["df", "-k"],
  ["sysctl", "vm.swapusage"],
];

export function allowed(argv: readonly string[]): boolean {
  return READ_ONLY.some((p) => p.every((x, i) => argv[i] === x));
}

export type Exec = (argv: string[]) => { ok: boolean; out: string };

export const realExec: Exec = (argv) => {
  if (!allowed(argv)) throw new Error(`doctor: refused a command outside the read-only allowlist: ${argv.join(" ")}`);
  try {
    return { ok: true, out: execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.replace(/^v/, "").split(".").map((x) => Number.parseInt(x, 10));
  const b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

/** Free kilobytes from the data line of `df -k <path>`. */
export function dfFreeKb(out: string): number | null {
  const line = out.trim().split("\n").pop() ?? "";
  const cols = line.split(/\s+/);
  const n = Number(cols[3]);
  return Number.isFinite(n) ? n : null;
}

/** `wrangler whoami` output: logged in when it names an account and does not say "not authenticated". */
export function whoamiLoggedIn(out: string): boolean {
  return !/not authenticated|You are not logged in/i.test(out) && /account/i.test(out);
}

export function billingEnabled(json: string): boolean | null {
  try {
    return Boolean((JSON.parse(json) as { billingEnabled?: boolean }).billingEnabled);
  } catch {
    return null;
  }
}

export const REQUIRED_SECRETS = ["CF_SETUP_TOKEN", "SS_AIG_TOKEN", "SS_HMAC_MASTER_KEY", "SS_ROLE_BINDINGS"] as const;
export const DATASETS = ["staysignal_raw", "staysignal_staging", "staysignal_restricted", "staysignal_published", "staysignal_semantic", "staysignal_lab", "staysignal_audit"] as const;
export const PRODUCTION_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

function envKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => l.slice(0, l.indexOf("=")).replace(/^export\s+/, "").trim()),
  );
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(true));
  });
}

export async function localChecks(exec: Exec, root: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (c: Omit<Check, "group">) => out.push({ group: "local", ...c });
  add(versionAtLeast(process.version, "24.0.0") ? { name: "Node 24 or later", status: "PASS", detail: process.version } : { name: "Node 24 or later", status: "FAIL", detail: process.version, fix: "install Node 24 (.nvmrc)" });
  const npm = exec(["npm", "--version"]);
  add(npm.ok && versionAtLeast(npm.out.trim(), "11.0.0") ? { name: "npm 11", status: "PASS", detail: npm.out.trim() } : { name: "npm 11", status: "FAIL", fix: "install npm 11" });
  const uv = exec(["uv", "--version"]);
  add(uv.ok ? { name: "uv", status: "PASS", detail: uv.out.trim() } : { name: "uv", status: "MISSING", fix: "install uv (https://docs.astral.sh/uv/)" });
  const py = exec(["uv", "run", "--project", "engine", "python", "--version"]);
  add(py.ok && /3\.12\./.test(py.out) ? { name: "Python 3.12 (engine)", status: "PASS", detail: py.out.trim() } : { name: "Python 3.12 (engine)", status: "FAIL", fix: "uv sync --locked --project engine" });
  const py311 = exec(["uv", "python", "find", "3.11"]);
  add(py311.ok ? { name: "Python 3.11 (Scenario Lab)", status: "PASS" } : { name: "Python 3.11 (Scenario Lab)", status: "WARN", detail: "needed only for the Scenario Lab (sim/)", fix: "uv python install 3.11" });
  const wr = exec(["npx", "wrangler", "--version"]);
  const wv = /(\d+\.\d+\.\d+)/.exec(wr.out)?.[1] ?? "";
  add(wr.ok && versionAtLeast(wv, "4.149.0") ? { name: "wrangler 4.149", status: "PASS", detail: wv } : { name: "wrangler 4.149", status: "FAIL", fix: "npm ci" });
  const docker = exec(["docker", "version", "--format", "{{.Server.Version}}"]);
  add(docker.ok ? { name: "Docker", status: "PASS", detail: docker.out.trim() } : { name: "Docker", status: "WARN", detail: "needed only for the Playwright screenshot baselines", fix: "start Docker" });
  if (docker.ok) {
    add({ name: "amd64 Chromium for screenshot baselines", status: "WARN", detail: "under qemu emulation the Playwright image's Chromium crashes; baselines need Rosetta in the Docker VM or a native amd64 runner", fix: "enable Rosetta for the Docker VM (for Colima: colima start --vm-type vz --vz-rosetta), then npm run test:e2e -- --update" });
  }
  const branch = exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
  add(branch.ok && branch.out.trim() === "main" ? { name: "git branch main", status: "PASS" } : { name: "git branch main", status: "FAIL", detail: branch.out.trim(), fix: "the publisher syncs only main: git switch main" });
  const hook = join(root, ".git", "hooks", "pre-commit");
  add(existsSync(hook) && readFileSync(hook, "utf8").includes("StaySignal") ? { name: "pre-commit hook", status: "PASS" } : { name: "pre-commit hook", status: "MISSING", fix: "npm run hooks:install" });
  const deny = process.env.SS_PRIVATE_DENYLIST;
  add(deny && existsSync(deny) ? { name: "private hygiene deny-list", status: "PASS" } : { name: "private hygiene deny-list", status: "WARN", detail: "commits fail closed without it", fix: "export SS_PRIVATE_DENYLIST=<path of the deny-list kept outside the repository>" });
  const df = exec(["df", "-k", homedir()]);
  const freeGb = (dfFreeKb(df.out) ?? 0) / 1024 / 1024;
  add(freeGb >= 6 ? { name: "free disk at least 6 GB", status: "PASS", detail: `${freeGb.toFixed(1)} GB` } : { name: "free disk at least 6 GB", status: "FAIL", detail: `${freeGb.toFixed(1)} GB`, fix: "free disk space before any install or LLM run" });
  const swap = exec(["sysctl", "vm.swapusage"]);
  if (swap.ok) add({ name: "swap in use", status: "INFO", detail: swap.out.trim().replace(/^vm\.swapusage:\s*/, "") });
  const busy = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port as number))) busy.push(`${name} ${port}`);
  add(busy.length ? { name: "ports free", status: "WARN", detail: `in use: ${busy.join(", ")}`, fix: "npm run stop" } : { name: "ports free", status: "PASS" });
  return out;
}

export function cloudflareChecks(exec: Exec, root: string): Check[] {
  const out: Check[] = [];
  const add = (c: Omit<Check, "group">) => out.push({ group: "cloudflare", ...c });
  const who = exec(["npx", "wrangler", "whoami"]);
  const logged = who.ok && whoamiLoggedIn(who.out);
  add(logged ? { name: "wrangler logged in", status: "PASS", detail: "an account is available (identifier not printed)" } : { name: "wrangler logged in", status: "FAIL", fix: "npx wrangler login" });
  if (logged) {
    const models = exec(["npx", "wrangler", "ai", "models", "list", "--json"]);
    add(models.ok && models.out.includes(PRODUCTION_MODEL) ? { name: `Workers AI model ${PRODUCTION_MODEL}`, status: "PASS" } : { name: `Workers AI model ${PRODUCTION_MODEL}`, status: models.ok ? "FAIL" : "WARN", detail: models.ok ? "not in the catalog" : "could not list models", fix: "choose another function-calling model on Workers Free (SPEC 14.11)" });
  }
  const state = join(root, ".prod", "state.json");
  const st = existsSync(state) ? (JSON.parse(readFileSync(state, "utf8")) as { access?: { aud?: string; team_domain?: string } }) : null;
  add(st?.access?.aud && st.access.team_domain ? { name: "Access application recorded (.prod/state.json)", status: "PASS" } : { name: "Access application recorded (.prod/state.json)", status: "MISSING", fix: "README Production setup steps 1 and 2: the one-time PIN login method, then the Access application recorded in .prod/state.json" });
  add({ name: "one-time PIN login, AI Gateway, R2 bucket, service tokens", status: "SKIP", detail: "need the account API token; checked once npm run setup:secrets copies it", fix: "npm run setup:secrets (not built yet; SPEC 23.2 step 5)" });
  return out;
}

export function gcpChecks(exec: Exec): Check[] {
  const out: Check[] = [];
  const add = (c: Omit<Check, "group">) => out.push({ group: "gcp", ...c });
  const gc = exec(["gcloud", "--version"]);
  if (!gc.ok) {
    add({ name: "gcloud", status: "MISSING", fix: "install the Google Cloud CLI (needed only for production path B)" });
    return out;
  }
  const account = exec(["gcloud", "config", "get-value", "account"]);
  add(account.ok && account.out.trim() ? { name: "gcloud account", status: "PASS", detail: "set (not printed)" } : { name: "gcloud account", status: "MISSING", fix: "gcloud auth login" });
  const project = process.env.SS_GCP_PROJECT || exec(["gcloud", "config", "get-value", "project"]).out.trim();
  if (!project) {
    add({ name: "Google Cloud project", status: "MISSING", fix: "export SS_GCP_PROJECT=<the shared project ID>" });
    return out;
  }
  add({ name: "Google Cloud project", status: "PASS", detail: "set (not printed)" });
  const billing = exec(["gcloud", "billing", "projects", "describe", project, "--format=json"]);
  const enabled = billing.ok ? billingEnabled(billing.out) : null;
  add(enabled ? { name: "billing enabled", status: "PASS" } : { name: "billing enabled", status: enabled === false ? "FAIL" : "WARN", detail: enabled === false ? "billing is disabled; BigQuery runs as a sandbox that rejects DML and expires tables" : "could not read billing", fix: "README Production setup step 5: reopen the closed billing account or link an open one (path B only; path A needs no Google resource)" });
  const apis = exec(["gcloud", "services", "list", "--enabled", "--project", project, "--format=value(config.name)"]);
  add(apis.ok && apis.out.includes("bigquery.googleapis.com") ? { name: "BigQuery API enabled", status: "PASS" } : { name: "BigQuery API enabled", status: "MISSING", fix: "npm run setup:prod -- --phase B (not built yet)" });
  const ls = exec(["bq", "ls", "--project_id", project, "--format=json"]);
  let names: string[] = [];
  try {
    names = ls.ok && ls.out.trim() ? (JSON.parse(ls.out) as { datasetReference: { datasetId: string } }[]).map((d) => d.datasetReference.datasetId) : [];
  } catch {
    names = [];
  }
  const missing = DATASETS.filter((d) => !names.includes(d));
  add(missing.length === 0 ? { name: "staysignal_* datasets", status: "PASS" } : { name: "staysignal_* datasets", status: "MISSING", detail: `${missing.length} of ${DATASETS.length} missing`, fix: "npm run setup:prod -- --phase B (path B; not built yet)" });
  return out;
}

export function secretChecks(root: string): Check[] {
  const keys = envKeys(join(root, ".secrets", "staysignal.env"));
  return REQUIRED_SECRETS.map((k) =>
    keys.has(k) ? { group: "secrets" as const, name: k, status: "PASS" as const } : { group: "secrets" as const, name: k, status: "MISSING" as const, fix: "README Production setup step 3 (Worker secrets); npm run setup:secrets will copy them into .secrets/staysignal.env (not built yet)" },
  );
}

export function format(c: Check): string {
  let line = `${c.status.padEnd(8)} [${c.group}] ${c.name}${c.detail ? `: ${c.detail}` : ""}`;
  if (c.status !== "PASS" && c.status !== "INFO" && c.fix) line += `\n         fix: ${c.fix}`;
  return line;
}

export function summary(checks: Check[]): string[] {
  const counts = new Map<Status, number>();
  for (const c of checks) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  const order: Status[] = ["PASS", "FAIL", "MISSING", "WARN", "SKIP", "INFO"];
  const lines = [`${checks.length} checks: ${order.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${s.toLowerCase()}`).join(", ")}`];
  const groups = new Map<string, string[]>();
  for (const c of checks) {
    if (c.status === "PASS" || c.status === "INFO") continue;
    const key = c.fix ?? "(no fix recorded)";
    groups.set(key, [...(groups.get(key) ?? []), `${c.name} (${c.status})`]);
  }
  if (groups.size) {
    lines.push("Not passing, grouped by fix:");
    for (const [fix, names] of groups) lines.push(`  ${fix}`, ...names.map((n) => `    - ${n}`));
  }
  return lines;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const checks = await localChecks(realExec, root);
  if (!process.argv.includes("--local-only")) {
    checks.push(...cloudflareChecks(realExec, root), ...gcpChecks(realExec), ...secretChecks(root));
  }
  for (const c of checks) console.log(format(c));
  console.log("");
  for (const l of summary(checks)) console.log(l);
  process.exitCode = checks.some((c) => c.status === "FAIL") ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
