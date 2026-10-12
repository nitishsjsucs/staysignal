// Governance page (SPEC 16.1, 16.2, 17): who can see what, how small groups are protected, and whether the reviews
// people approve land unevenly on any group (the action audit: a screen of actions, never of the forecast). The
// age screen and the proxy strength are for the auditor only. Synthetic company.
import type { ActionAuditDoc } from "../../shared/contracts";
import { ROLES, type Role } from "../../shared/policy/roles";
import disclosure from "../../../policy/disclosure.json";
import { isRefusal, type Me, type Refusal, useQuery } from "../api";
import { ImpactRatios, ImpactTable } from "../charts/ImpactRatios";
import { ChartCard } from "../components/ChartCard";
import { Chip, RefusalNote, Skeleton } from "../components/ui";
import { PageHead } from "./Forecast";

const HUMAN_ROLES: Role[] = ["people_analyst", "people_partner", "pa_lead", "data_engineer", "auditor"];

function ActionAudit() {
  const q = useQuery<(ActionAuditDoc & { audience: string }) | Refusal>("/api/audit/actions");
  if (!q.data) return <Skeleton height={260} />;
  if (isRefusal(q.data)) return <RefusalNote code={q.data.code} message={q.data.message} />;
  const d = q.data;
  return (
    <>
      <ChartCard
        id="action-audit"
        title="Are the reviews we approve landing unevenly on any group?"
        subtitle={`${d.reviews} approved reviews, ${d.review_window[0]} to ${d.review_window[1]} · selection rate divided by the highest group's · a screen, not a finding · synthetic`}
        table={<ImpactTable screens={d.screens} />}
        height={260}
      >
        <div className="impact-grid">
          {Object.entries(d.screens).map(([name, s]) => (
            <ImpactRatios key={name} name={name} rows={s.rows} />
          ))}
        </div>
        <p className="card-sub" style={{ marginTop: 8 }}>
          Each review is a selection opportunity for everyone employed on its date; a person received attention when their group then was the reviewed cohort. The four-fifths rule (29 CFR 1607.4(D)) is a rule of thumb and Fisher's exact test is approximate here because people recur across reviews; groups under 10 people are not screened. {d.audience === "lead" ? "The audit-only age screen is visible to the auditor only." : ""}
        </p>
      </ChartCard>
      {d.proxy_strength ? (
        <div className="stat-row" data-testid="proxy-strength">
          <div className="stat">
            <div className="stat-label">Tenure band as a proxy for age 40 or over (AUC)</div>
            <div className="stat-value">{d.proxy_strength.tenure_band_auc?.toFixed(2) ?? "n/a"}</div>
            <div className="stat-note">0.5 means no age information</div>
          </div>
          <div className="stat">
            <div className="stat-label">Level band as a proxy for age 40 or over (AUC)</div>
            <div className="stat-value">{d.proxy_strength.level_band_auc?.toFixed(2) ?? "n/a"}</div>
            <div className="stat-note">{d.proxy_strength.people.toLocaleString("en-US")} people on {d.proxy_strength.date}</div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function GovernancePage({ me }: { me: Me }) {
  return (
    <>
      <PageHead title="Governance" sub="Who can see what, how small groups are protected, and whether the actions people approve land unevenly on any group." />
      <ActionAudit />
      <section className="card" data-testid="roles" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2 className="card-title">Who can see and do what?</h2>
            <div className="card-sub">Scopes from policy/roles.json; checked on the server for every tool, API and MCP call. You act as {me.principal.display}.</div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Scopes</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {HUMAN_ROLES.map((r) => (
                <tr key={r} aria-current={me.principal.role === r ? "true" : undefined}>
                  <td>{ROLES[r].label}</td>
                  <td style={{ whiteSpace: "normal" }}>
                    {ROLES[r].scopes.map((s) => (
                      <Chip key={s}>{s}</Chip>
                    ))}
                  </td>
                  <td style={{ whiteSpace: "normal" }}>{ROLES[r].notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" data-testid="disclosure" style={{ marginTop: 16 }}>
        <div className="card-head">
          <div>
            <h2 className="card-title">How are small groups protected?</h2>
            <div className="card-sub">Disclosure rules from policy/disclosure.json (SPEC 17.5)</div>
          </div>
        </div>
        <ul className="governance-rules">
          <li>Every count, rate and expected value describes {disclosure.min_cell} people or more; smaller cells are suppressed, with complementary suppression so they cannot be recovered by subtraction.</li>
          <li>Comparisons over time (what changed, backtest series) are served only for cohorts of {disclosure.min_comparison_cohort} or more, and only when the people who joined or left number 0 or at least {disclosure.population_change.min_changed}.</li>
          <li>
            Expected departures are rounded by cohort size:{" "}
            {disclosure.expected_rounding.map((r) => `${r.band} to ${r.step}`).join(", ")}; interval bounds are {disclosure.interval_bounds}.
          </li>
          <li>Team-level values are shown to People Analysts only and labeled "{disclosure.team_label}"; nothing is ranked by risk.</li>
        </ul>
      </section>
    </>
  );
}
