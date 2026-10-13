// npm run setup:prod -- --phase A|B (SPEC 23.2): prints the production setup plan for the owner, step by step, from
// the committed grant plan and read-only probes (the doctor's allowlist: lists and describes only). A step whose
// result already exists is shown as done; phase B is blocked while billing is disabled. This script changes nothing,
// locally or in either cloud: the owner runs the printed commands (README, Production setup).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { billingEnabled, type Exec, realExec } from "./doctor.ts";
import type { ProdState } from "./lib/prod-state.ts";
import { format, type GrantPlan, type Observed, planA, planB } from "./lib/setup-plan.ts";

const ROOT = process.cwd();

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Read-only observations; anything that cannot be read is unknown (null) and its step stays to do. */
export function observe(exec: Exec, state: ProdState | null): Observed {
  const project = exec(["gcloud", "config", "get-value", "project"]);
  const projectId = project.ok ? (lines(project.out)[0] ?? null) : null;
  const bill = projectId ? exec(["gcloud", "billing", "projects", "describe", projectId, "--format=json"]) : { ok: false, out: "" };
  const ds = projectId ? exec(["bq", "ls", "--format=json", `--project_id=${projectId}`]) : { ok: false, out: "" };
  const sas = projectId ? exec(["gcloud", "iam", "service-accounts", "list", `--project=${projectId}`, "--format=value(email)"]) : { ok: false, out: "" };
  const roles = projectId ? exec(["gcloud", "projects", "get-iam-policy", projectId, "--format=json"]) : { ok: false, out: "" };
  const buckets = exec(["npx", "wrangler", "r2", "bucket", "list"]);
  const secrets = exec(["npx", "wrangler", "secret", "list"]);
  let datasets: string[] | null = null;
  try {
    datasets = ds.ok ? (JSON.parse(ds.out || "[]") as { datasetReference: { datasetId: string } }[]).map((d) => d.datasetReference.datasetId) : null;
  } catch {
    datasets = null;
  }
  let projectRoles: Observed["projectRoles"] = null;
  try {
    projectRoles = roles.ok ? (JSON.parse(roles.out) as { bindings?: { role: string; members: string[] }[] }).bindings?.flatMap((b) => b.members.map((m) => ({ member: m, role: b.role }))) ?? [] : null;
  } catch {
    projectRoles = null;
  }
  let workerSecrets: string[] | null = null;
  try {
    workerSecrets = secrets.ok ? (JSON.parse(secrets.out) as { name: string }[]).map((s) => s.name) : null;
  } catch {
    workerSecrets = null;
  }
  return {
    projectId,
    billingEnabled: bill.ok ? billingEnabled(bill.out) : null,
    datasets,
    serviceAccounts: sas.ok ? lines(sas.out).map((e) => e.split("@")[0]!) : null,
    projectRoles,
    r2Buckets: buckets.ok ? lines(buckets.out).filter((l) => l.startsWith("name:")).map((l) => l.slice(5).trim()) : null,
    workerSecrets,
    aiGateway: Boolean(state?.ai_gateway?.id),
    access: Boolean(state?.access?.team_domain && state?.access?.aud),
    serviceTokens: false,
  };
}

function main(): void {
  const phaseFlag = process.argv.indexOf("--phase");
  const phase = phaseFlag > 0 ? process.argv[phaseFlag + 1] : undefined;
  if (phase !== "A" && phase !== "B") {
    console.error("usage: npm run setup:prod -- --phase A|B   (prints the plan; changes nothing)");
    process.exit(2);
  }
  const statePath = join(ROOT, ".prod", "state.json");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as ProdState) : null;
  const grants = JSON.parse(readFileSync(join(ROOT, "infra", "gcp", "grants.json"), "utf8")) as GrantPlan;
  const o = observe(realExec, state);
  const steps = phase === "A" ? planA(o) : planB(grants, o);
  console.log(`setup:prod phase ${phase}: ${steps.filter((s) => s.status === "done").length} of ${steps.length} steps done; nothing below was run`);
  for (const l of format(steps)) console.log(l);
  if (phase === "B" && !o.billingEnabled) console.log("\nPhase B is blocked until billing is enabled on the project (README, Production setup).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
