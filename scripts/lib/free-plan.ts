// Workers Free plan rules for a deployment config (SPEC 1, 14.11, C42). Pattern from PeopleLake scripts/lib/free-plan.ts
// (MIT), adapted for StaySignal: what `npm run deploy` and `npm run doctor` refuse because it needs Workers Paid or a
// paid Workers AI model, or because it breaks a StaySignal rule for deployments.
import { parseJsonc } from "./jsonc.ts";

export interface DeployConfig {
  name?: string;
  vars?: Record<string, string>;
  durable_objects?: { bindings?: { name: string; class_name: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[] }[];
  workflows?: { name: string; binding: string; class_name: string }[];
  ai?: { binding: string };
  pipelines?: unknown;
  tail_consumers?: unknown;
  logpush?: unknown;
  limits?: unknown;
  artifacts?: unknown;
  queues?: unknown;
  [k: string]: unknown;
}

/** Workers AI models that need a paid billing method or that StaySignal never uses in production (SPEC 14.11). */
export const PAID_OR_EXCLUDED_MODELS = ["@cf/qwen/qwen3.8-27b"] as const;
export const PRODUCTION_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";

/** Every reason a config would need Workers Paid or break a deployment rule. Empty when it is fine. */
export function freePlanProblems(configText: string): string[] {
  const c = parseJsonc<DeployConfig>(configText);
  const problems: string[] = [];
  if (c.pipelines !== undefined) problems.push("pipelines (Basin Pipelines) need Workers Paid");
  if (c.tail_consumers !== undefined) problems.push("tail_consumers need Workers Paid");
  if (c.logpush !== undefined) problems.push("logpush needs Workers Paid");
  if (c.limits !== undefined) problems.push("limits (cpu_ms) is a Workers Paid setting");
  if (c.artifacts !== undefined) problems.push("Cloudflare Artifacts is Workers Paid only (memory stays in SQLite)");
  const sqlite = new Set((c.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []));
  for (const b of c.durable_objects?.bindings ?? []) {
    if (!sqlite.has(b.class_name)) problems.push(`Durable Object ${b.class_name} must be a SQLite class (the only backend on Free)`);
  }
  for (const m of c.migrations ?? []) {
    if ((m.new_classes ?? []).length > 0) problems.push(`migration ${m.tag}: key-value Durable Object classes need Workers Paid`);
  }
  const vars = c.vars ?? {};
  const demo = vars.SS_AUTH_MODE === "demo";
  if (vars.SS_AUTH_MODE !== "access" && !demo) problems.push("SS_AUTH_MODE must be access, or demo for the public demo, in a deployment (dev tokens are local only)");
  if (demo) problems.push(...publicDemoProblems(c));
  for (const w of c.workflows ?? []) {
    if (c.name && !w.name.startsWith(`${c.name}-`)) problems.push(`Workflow ${w.name}: Workflow names are account-wide, so each starts with its Worker's name (${c.name}-)`);
  }
  if (vars.SS_AUTH_MODE === "access" && (!vars.SS_ACCESS_TEAM_DOMAIN || !vars.SS_ACCESS_AUD)) problems.push("SS_ACCESS_TEAM_DOMAIN and SS_ACCESS_AUD are required with Access");
  if (vars.SS_LLM === "llama" || vars.SS_LLM === "mlx") problems.push(`SS_LLM ${vars.SS_LLM} is a local model server`);
  const model = vars.SS_AI_MODEL ?? "";
  if ((PAID_OR_EXCLUDED_MODELS as readonly string[]).includes(model)) problems.push(`SS_AI_MODEL ${model} is not the production model`);
  if (c.ai !== undefined && vars.SS_LLM !== "workers-ai") problems.push("an ai binding without SS_LLM=workers-ai bills Workers AI for nothing");
  if (vars.SS_DATA_MODE === "bigquery") {
    if (!vars.SS_GCP_PROJECT_ID) problems.push("SS_DATA_MODE=bigquery needs SS_GCP_PROJECT_ID");
    const secrets = ((c as { secrets?: { required?: string[] } }).secrets?.required ?? []) as string[];
    if (!secrets.includes("SS_GCP_SA_KEY")) problems.push("SS_DATA_MODE=bigquery needs the SS_GCP_SA_KEY secret declared in secrets.required");
    if (vars.SS_RUNNER === "inline") problems.push("SS_RUNNER=inline completes jobs from fixtures; the BigQuery path needs the runner");
  }
  if (vars.SS_LLM === "workers-ai") {
    if (!vars.SS_AIG_ACCOUNT_ID || !vars.SS_AIG_GATEWAY_ID) problems.push("SS_LLM=workers-ai needs SS_AIG_ACCOUNT_ID and SS_AIG_GATEWAY_ID (the AI Gateway)");
    const cap = Number(vars.SS_AI_DAILY_NEURON_CAP);
    if (!(cap > 0 && cap <= 10_000)) problems.push("SS_AI_DAILY_NEURON_CAP must be a positive cap within the account's 10,000 free neurons a day");
    const secrets = ((c as { secrets?: { required?: string[] } }).secrets?.required ?? []) as string[];
    if (!secrets.includes("SS_AIG_TOKEN")) problems.push("SS_LLM=workers-ai needs the SS_AIG_TOKEN secret declared in secrets.required");
  }
  for (const key of Object.keys(vars)) {
    if (/SECRET|TOKEN|PRIVATE|MASTER_KEY|SIGNING_KEY|JWK/.test(key)) problems.push(`${key} looks like a secret; set it with wrangler secret, never in vars`);
  }
  return problems;
}

/** The largest share of the public demo's invocations its Workers Logs may sample. */
export const MAX_DEMO_LOG_SAMPLING = 0.1;

/** The public demo's deployment rules (ADR 0018): a public workers.dev link with its own sign-in, the signing key as a
 * secret, the gate, the committed fixtures with inline jobs, and none of the real data paths. */
export function publicDemoProblems(c: DeployConfig): string[] {
  const vars = c.vars ?? {};
  const secrets = ((c as { secrets?: { required?: string[] } }).secrets?.required ?? []) as string[];
  const out: string[] = [];
  if (vars.SS_PUBLIC_DEMO !== "1") out.push("SS_AUTH_MODE=demo needs SS_PUBLIC_DEMO=1");
  if (!secrets.includes("SS_DEMO_SIGNING_KEY")) out.push("the public demo needs the SS_DEMO_SIGNING_KEY secret declared in secrets.required");
  if ((c as { workers_dev?: boolean }).workers_dev !== true) out.push("the public demo is served at its workers.dev link (workers_dev: true)");
  if (vars.SS_DATA_MODE !== "fixtures") out.push("the public demo serves the committed fixtures (SS_DATA_MODE=fixtures)");
  if (vars.SS_RUNNER !== "inline") out.push("the public demo has no runner (SS_RUNNER=inline)");
  if (c.ai !== undefined) out.push("the public demo never calls Workers AI (no ai binding)");
  if (vars.SS_LLM && vars.SS_LLM !== "recorded" && vars.SS_LLM !== "stub") out.push(`the public demo never calls a live model (SS_LLM=${vars.SS_LLM})`);
  for (const key of Object.keys(vars)) {
    if (/^SS_(AIG|AI_MODEL|AI_DAILY|GCP|BQ|ACCESS|ROLE_BINDINGS|RUNNER_TOKEN|MCP_TOKEN)/.test(key)) out.push(`the public demo never uses ${key}`);
  }
  for (const name of ["SS_AIG_TOKEN", "SS_GCP_SA_KEY", "SS_RUNNER_TOKEN", "SS_ROLE_BINDINGS", "SS_HMAC_MASTER_KEY"]) if (secrets.includes(name)) out.push(`the public demo never needs the secret ${name}`);
  // a public link draws traffic that is mostly refused; logging every invocation would spend the account's Workers
  // Logs on it (billed beyond the included events if the account were ever on Workers Paid)
  const sampling = (c as { observability?: { enabled?: boolean; head_sampling_rate?: number } }).observability;
  if (sampling?.enabled !== false && !((sampling?.head_sampling_rate ?? 1) <= MAX_DEMO_LOG_SAMPLING)) out.push(`the public demo logs at most ${MAX_DEMO_LOG_SAMPLING * 100}% of invocations (observability.head_sampling_rate <= ${MAX_DEMO_LOG_SAMPLING})`);
  const gate = c.durable_objects?.bindings?.find((b) => b.name === "DEMO_GATE");
  if (!gate || gate.class_name !== "DemoGate") out.push("the public demo needs the DEMO_GATE binding to DemoGate");
  return out;
}
