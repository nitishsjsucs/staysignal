// Production state (SPEC 23): account-level values the operator's setup records in .prod/state.json (gitignored).
// Committed files carry placeholders only; the deploy script renders them. Pattern from PeopleLake scripts/lib/prod-state.ts.
export interface ProdState {
  account_id?: string;
  workers_subdomain?: string;
  access?: { team_domain?: string; aud?: string };
  ai_gateway?: { id?: string };
  gcp?: { project_id?: string };
}

export const PLACEHOLDERS = ["__SS_ACCESS_TEAM_DOMAIN__", "__SS_ACCESS_AUD__", "__SS_AIG_ACCOUNT_ID__", "__SS_AIG_GATEWAY_ID__", "__SS_GCP_PROJECT_ID__"] as const;

/** Values for every placeholder; `dryRun` uses obvious stand-ins so a dry run never needs the operator's state. */
export function placeholderValues(state: ProdState | null, dryRun: boolean): Record<(typeof PLACEHOLDERS)[number], string> {
  if (dryRun) return { __SS_ACCESS_TEAM_DOMAIN__: "https://example-team.cloudflareaccess.com", __SS_ACCESS_AUD__: "dry-run-audience", __SS_AIG_ACCOUNT_ID__: "dry-run-account", __SS_AIG_GATEWAY_ID__: "staysignal", __SS_GCP_PROJECT_ID__: "dry-run-project" };
  const team = state?.access?.team_domain;
  const aud = state?.access?.aud;
  if (!team || !aud) throw new Error(".prod/state.json needs access.team_domain and access.aud (Production setup step 2, docs/runbooks/prod-setup.md)");
  const account = state?.account_id;
  const gateway = state?.ai_gateway?.id;
  if (!account || !gateway) throw new Error(".prod/state.json needs account_id and ai_gateway.id (Production setup step 3, docs/runbooks/prod-setup.md)");
  // the GCP project is needed only by the production template; a fixtures render never contains its placeholder
  return { __SS_ACCESS_TEAM_DOMAIN__: team, __SS_ACCESS_AUD__: aud, __SS_AIG_ACCOUNT_ID__: account, __SS_AIG_GATEWAY_ID__: gateway, __SS_GCP_PROJECT_ID__: state?.gcp?.project_id ?? "__SS_GCP_PROJECT_ID__" };
}

/** Replaces placeholders inside string values of a JSONC template (comments are kept). */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  if (/__SS_[A-Z_]+__/.test(out)) throw new Error(`unrendered placeholder: ${/__SS_[A-Z_]+__/.exec(out)?.[0]}`);
  return out;
}
