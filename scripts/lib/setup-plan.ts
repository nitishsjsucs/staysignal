// The production setup plan (SPEC 23.2): what `npm run setup:prod` prints for the owner, phase by phase, from the
// committed grant plan (infra/gcp/grants.json, compiled from policy/access.yaml) and what read-only probes observed.
// Idempotent by construction: a step whose result already exists is listed as done and never repeated. Builders never
// run these steps; the script prints them and changes nothing.

export interface GrantPlan {
  location: string;
  datasets: { dataset: string; description: string }[];
  service_accounts: { account: string; description: string }[];
  dataset_grants: { dataset: string; member: string; role: string }[];
  project_roles: { member: string; role: string }[];
  authorized_views: { dataset: string; view: string; reader: string }[];
  jobs: Record<string, { maximum_bytes_billed: number; labels: Record<string, string> }>;
}

export interface Observed {
  projectId: string | null;
  billingEnabled: boolean | null;
  datasets: string[] | null;
  serviceAccounts: string[] | null; // account IDs (the part before @)
  projectRoles: { member: string; role: string }[] | null;
  r2Buckets: string[] | null;
  workerSecrets: string[] | null;
  aiGateway: boolean;
  access: boolean;
  serviceTokens: boolean;
}

export interface Step {
  phase: "A" | "B";
  id: string;
  what: string;
  how: string; // a command to run, or where to click
  status: "done" | "todo" | "blocked";
}

export const LANDING_BUCKET = "staysignal-landing";
// SS_RUNNER_TOKEN_ID and SS_MCP_TOKEN_ID are the service tokens' client IDs: Access sets a service token JWT's
// common_name to its client ID, and the Worker binds svc:<client ID> to the runner and the MCP roles
export const WORKER_SECRETS = ["SS_HMAC_MASTER_KEY", "SS_ROLE_BINDINGS", "SS_AIG_TOKEN", "SS_RUNNER_TOKEN_ID", "SS_MCP_TOKEN_ID"] as const;
const APIS = ["iam.googleapis.com", "iamcredentials.googleapis.com", "cloudresourcemanager.googleapis.com", "cloudbilling.googleapis.com"];

const has = (xs: string[] | null, x: string) => Boolean(xs?.includes(x));

export function planA(o: Observed): Step[] {
  const steps: Step[] = [
    { phase: "A", id: "r2-bucket", what: `R2 bucket ${LANDING_BUCKET} for landed extracts`, how: `npx wrangler r2 bucket create ${LANDING_BUCKET}`, status: has(o.r2Buckets, LANDING_BUCKET) ? "done" : "todo" },
    { phase: "A", id: "ai-gateway", what: "AI Gateway `staysignal` with authentication on (payload logging is skipped per request by header)", how: "Cloudflare dashboard: AI > AI Gateway > Create; then record its ID in .prod/state.json as ai_gateway.id", status: o.aiGateway ? "done" : "todo" },
    { phase: "A", id: "access-app", what: "Access application for the Worker's workers.dev hostname, allowing the demo principals' addresses", how: "Cloudflare dashboard: Zero Trust > Access > Applications; then record team_domain and aud in .prod/state.json", status: o.access ? "done" : "todo" },
    { phase: "A", id: "service-tokens", what: "Access service tokens staysignal-runner and staysignal-mcp", how: "Cloudflare dashboard: Zero Trust > Access > Service Auth > Create", status: o.serviceTokens ? "done" : "todo" },
  ];
  for (const s of WORKER_SECRETS) steps.push({ phase: "A", id: `secret-${s}`, what: `Worker secret ${s}`, how: `npx wrangler secret put ${s} (value from .secrets/staysignal.env; never printed)`, status: has(o.workerSecrets, s) ? "done" : "todo" });
  return steps;
}

/** Phase B creates only what is missing and refuses while billing is disabled (the sandbox rejects DML). */
export function planB(g: GrantPlan, o: Observed): Step[] {
  const p = o.projectId ?? "<PROJECT_ID>";
  const gate: Step["status"] = o.billingEnabled ? "todo" : "blocked";
  const steps: Step[] = [
    { phase: "B", id: "billing", what: "billing enabled on the shared project, with a $5 budget filtered to app=staysignal", how: "Google Cloud console: Billing (Production setup step 6, path B, docs/runbooks/prod-setup.md)", status: o.billingEnabled ? "done" : "todo" },
    { phase: "B", id: "apis", what: `APIs ${APIS.join(", ")}`, how: `gcloud services enable ${APIS.join(" ")} --project ${p}`, status: gate },
  ];
  for (const sa of g.service_accounts) {
    steps.push({ phase: "B", id: `sa-${sa.account}`, what: `service account ${sa.account} (${sa.description})`, how: `gcloud iam service-accounts create ${sa.account} --project ${p} --display-name "${sa.account}"`, status: has(o.serviceAccounts, sa.account) ? "done" : gate });
  }
  for (const d of g.datasets) {
    steps.push({ phase: "B", id: `dataset-${d.dataset}`, what: `dataset ${d.dataset} (${d.description}), no default expiration`, how: `bq --location=${g.location} mk --dataset --description "${d.description}" ${p}:${d.dataset}`, status: has(o.datasets, d.dataset) ? "done" : gate });
  }
  for (const r of g.project_roles) {
    const m = r.member.replace("<PROJECT_ID>", p);
    const done = Boolean(o.projectRoles?.some((x) => x.member === m && x.role === r.role));
    steps.push({ phase: "B", id: `project-role-${r.member.split(":")[1]!.split("@")[0]}`, what: `${r.role} on the project, the only project-level role`, how: `gcloud projects add-iam-policy-binding ${p} --member=${m} --role=${r.role} --condition=None`, status: done ? "done" : gate });
  }
  for (const gr of g.dataset_grants) {
    const m = gr.member.replace("<PROJECT_ID>", p);
    const access = gr.role === "roles/bigquery.dataEditor" ? "WRITER" : "READER";
    steps.push({ phase: "B", id: `grant-${gr.dataset}-${m.split(":")[1]!.split("@")[0]}`, what: `${gr.role} on ${gr.dataset} for ${m.split(":")[1]!.split("@")[0]}`, how: `bq show --format=prettyjson ${p}:${gr.dataset} > ds.json; add {"role": "${access}", "userByEmail": "${m.split(":")[1]}"} to "access"; bq update --source ds.json ${p}:${gr.dataset}`, status: gate });
  }
  for (const v of g.authorized_views) {
    const reader = v.reader.replace("<PROJECT_ID>", p);
    steps.push({ phase: "B", id: `view-${v.dataset}.${v.view}`, what: `authorized view ${v.dataset}.${v.view}: the Worker reads the aggregates, never the table behind them`, how: `after prod:load creates the view: bq show --format=prettyjson ${p}:${v.dataset} > ds.json; add {"view": {"projectId": "${p}", "datasetId": "${v.dataset}", "tableId": "${v.view}"}} to "access"; bq update --source ds.json ${p}:${v.dataset}; then bq add-iam-policy-binding --member=${reader} --role=roles/bigquery.dataViewer ${p}:${v.dataset}.${v.view}`, status: gate });
  }
  return steps;
}

export function format(steps: Step[]): string[] {
  const mark = { done: "done   ", todo: "todo   ", blocked: "blocked" } as const;
  return steps.map((s) => `[${s.phase}] ${mark[s.status]} ${s.what}\n            ${s.how}`);
}
