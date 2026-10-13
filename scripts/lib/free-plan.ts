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
  if (vars.SS_AUTH_MODE !== "access") problems.push("SS_AUTH_MODE must be access in a deployment (dev tokens are local only)");
  if (vars.SS_AUTH_MODE === "access" && (!vars.SS_ACCESS_TEAM_DOMAIN || !vars.SS_ACCESS_AUD)) problems.push("SS_ACCESS_TEAM_DOMAIN and SS_ACCESS_AUD are required with Access");
  if (vars.SS_LLM === "llama" || vars.SS_LLM === "mlx") problems.push(`SS_LLM ${vars.SS_LLM} is a local model server`);
  const model = vars.SS_AI_MODEL ?? "";
  if ((PAID_OR_EXCLUDED_MODELS as readonly string[]).includes(model)) problems.push(`SS_AI_MODEL ${model} is not the production model`);
  if (c.ai !== undefined && vars.SS_LLM !== "workers-ai") problems.push("an ai binding without SS_LLM=workers-ai bills Workers AI for nothing");
  for (const key of Object.keys(vars)) {
    if (/SECRET|TOKEN|PRIVATE|MASTER_KEY|JWK/.test(key)) problems.push(`${key} looks like a secret; set it with wrangler secret, never in vars`);
  }
  return problems;
}
