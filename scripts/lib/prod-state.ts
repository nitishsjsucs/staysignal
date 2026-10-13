// Production state (SPEC 23): account-level values the operator's setup records in .prod/state.json (gitignored).
// Committed files carry placeholders only; the deploy script renders them. Pattern from PeopleLake scripts/lib/prod-state.ts.
export interface ProdState {
  account_id?: string;
  workers_subdomain?: string;
  access?: { team_domain?: string; aud?: string };
}

export const PLACEHOLDERS = ["__SS_ACCESS_TEAM_DOMAIN__", "__SS_ACCESS_AUD__"] as const;

/** Values for every placeholder; `dryRun` uses obvious stand-ins so a dry run never needs the operator's state. */
export function placeholderValues(state: ProdState | null, dryRun: boolean): Record<(typeof PLACEHOLDERS)[number], string> {
  if (dryRun) return { __SS_ACCESS_TEAM_DOMAIN__: "https://example-team.cloudflareaccess.com", __SS_ACCESS_AUD__: "dry-run-audience" };
  const team = state?.access?.team_domain;
  const aud = state?.access?.aud;
  if (!team || !aud) throw new Error(".prod/state.json needs access.team_domain and access.aud (run npm run setup:prod -- --phase A first)");
  return { __SS_ACCESS_TEAM_DOMAIN__: team, __SS_ACCESS_AUD__: aud };
}

/** Replaces placeholders inside string values of a JSONC template (comments are kept). */
export function renderTemplate(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(k).join(v);
  if (/__SS_[A-Z_]+__/.test(out)) throw new Error(`unrendered placeholder: ${/__SS_[A-Z_]+__/.exec(out)?.[0]}`);
  return out;
}
