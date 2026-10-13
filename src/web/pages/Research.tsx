// Research page (SPEC 11, 16.1): what breaks the calibration of departure forecasts, and what fixes it? A
// pre-registered simulation study on synthetic research worlds (not Larkspur's cohorts): each factor's cells with
// their seed-bootstrap intervals against the equivalence band, coverage by shock size, and each hypothesis judged by
// its registered rule.
import type { ResearchCell, ResearchDoc } from "../../shared/contracts";
import { type Me, useQuery } from "../api";
import { ArmDots, CoverageBySigma, HANDLING_LABEL } from "../charts/research";
import { ChartCard } from "../components/ChartCard";
import { EmptyState, ErrorState, Skeleton, StatusPill } from "../components/ui";
import { PageHead } from "./Forecast";

const FACTORS: { id: ResearchCell["factor"]; title: string; question: string }[] = [
  { id: "A", title: "A. Late reporting of terminations", question: "Does waiting for late records (matured) keep forecasts calibrated as reporting delays grow?" },
  { id: "B", title: "B. A missing extract", question: "Is a missing termination extract better treated as censored than as a month with no events?" },
  { id: "D", title: "D. Duplicate departure records", question: "Does counting a duplicated departure twice make forecasts run high?" },
  { id: "AxC", title: "A x C. Late reporting and shared shocks together", question: "Are both handling choices needed together? (exploratory)" },
];

const HYPOTHESIS_TITLE: Record<string, string> = {
  H1: "H1. Late reporting: matured stays calibrated, naive drifts",
  H2: "H2. Missing extract: censored stays calibrated, no events does not",
  H3a: "H3a. Shared shocks, company and organizations: shock-aware ranges keep their coverage",
  H3b: "H3b. Shared shocks, teams: shock-aware predictive distributions are calibrated",
  H4: "H4. Duplicates: deduplicated stays calibrated, not deduplicated runs high",
  H5: "H5. Interaction (exploratory)",
};

function CellTable({ cells }: { cells: ResearchCell[] }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Level</th>
          <th>Handling</th>
          <th className="num">O/E</th>
          <th className="num">90% interval</th>
          <th className="num">TOST p</th>
          <th className="num">80% held</th>
          <th className="num">95% held</th>
          <th className="num">Interval score</th>
        </tr>
      </thead>
      <tbody>
        {cells.map((c) => (
          <tr key={`${c.level}-${c.handling}`}>
            <td>{c.level}</td>
            <td>{HANDLING_LABEL[c.handling] ?? c.handling}</td>
            <td className="num">{c.oe.toFixed(3)}</td>
            <td className="num">
              {c.oe_lo90.toFixed(3)} to {c.oe_hi90.toFixed(3)}
            </td>
            <td className="num">{c.oe_tost_p.toFixed(3)}</td>
            <td className="num">{(c.cov80 * 100).toFixed(1)}%</td>
            <td className="num">{c.cov95 === null ? "n/a" : `${(c.cov95 * 100).toFixed(1)}%`}</td>
            <td className="num">{c.interval_score80 === null ? "n/a" : c.interval_score80.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ResearchPage(_: { me: Me }) {
  const q = useQuery<ResearchDoc>("/api/research");
  const head = (
    <PageHead
      title="Research"
      sub="What breaks the calibration of departure forecasts, and what fixes it? A pre-registered simulation study: late HR records, a missing extract, shared team shocks and duplicate records, each crossed with a handling choice, on synthetic research worlds with a known truth. It tests methods, not any real workforce."
    />
  );
  if (q.error) return <ErrorState error={q.error} />;
  if (q.loading && !q.data) return <Skeleton height={320} />;
  const d = q.data;
  if (!d || !("cells" in d)) {
    return (
      <>
        {head}
        <EmptyState>No research run is recorded yet (npm run research:run).</EmptyState>
      </>
    );
  }
  const shocks = d.cells.filter((c) => c.factor === "C");
  return (
    <>
      {head}
      <section className="card" data-testid="research-hypotheses">
        <div className="card-head">
          <div>
            <h2 className="card-title">What did the pre-registered tests find?</h2>
            <div className="card-sub">
              {d.seeds.length} seeds, {d.origins.length} quarterly origins, {d.horizon_months}-month horizon; equivalence by two one-sided tests on a seed bootstrap; pre-registration <span className="mono">{d.prereg_sha256.slice(0, 12)}</span>
            </div>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Hypothesis</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(d.hypotheses).map(([id, h]) => (
                <tr key={id}>
                  <td style={{ whiteSpace: "normal" }}>
                    {HYPOTHESIS_TITLE[id] ?? id}
                    <div className="card-sub">Registered rule: {h.rule}</div>
                  </td>
                  <td>
                    <StatusPill status={h.verdict === "consistent" ? "good" : h.verdict === "counts against" ? "warning" : "info"}>{h.verdict}</StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="grid" style={{ marginTop: 16 }}>
        {FACTORS.map((f) => {
          const cells = d.cells.filter((c) => c.factor === f.id);
          return (
            <ChartCard key={f.id} id={`arm-${f.id}`} className="span-6" title={f.title} subtitle={`${f.question} Mean observed over expected at company level, seed-bootstrap 90% interval; the shaded band is 0.95 to 1.05; a filled dot means equivalence was shown.`} table={<CellTable cells={cells} />} height={cells.length * 24 + 44}>
              <ArmDots cells={cells} metric="oe" band={[0.95, 1.05]} title="Observed over expected" />
            </ChartCard>
          );
        })}
        <ChartCard id="coverage-sigma" className="span-6" title="C. Do ranges keep their coverage as shared shocks grow?" subtitle="80% ranges held, company and organizations, by the generator's team shock (organization shock half of it); the shaded band is 75% to 85%. Independence ranges leave the shocks out." table={<CellTable cells={shocks} />} height={220}>
          <CoverageBySigma cells={shocks} metric="cov80" title="Company and organizations" />
        </ChartCard>
        <ChartCard id="coverage-sigma-teams" className="span-6" title="C. And for teams?" subtitle="80% ranges held for teams of 10 or more; H3b judges teams by the randomized PIT (distance in the tooltip). Teams are research-world teams, never Larkspur's." height={220}>
          <CoverageBySigma cells={shocks} metric="team_cov80" title="Teams" />
        </ChartCard>
      </div>
      <p className="card-sub" style={{ marginTop: 12 }}>
        Design: {d.design}. Results file: <span className="mono">{d.command}</span>, {d.date}. Synthetic worlds only.
      </p>
    </>
  );
}
