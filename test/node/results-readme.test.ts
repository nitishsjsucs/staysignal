import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadReports, RESULTS_PAGE } from "../../scripts/results-to-readme.ts";
import { type ActionAuditReport, type AgentEvalReport, type BacktestReport, END, type Entry, latest, type ModelComparisonReport, type OracleCoverageReport, type ChallengerReport, type DqFaultsReport, partitionCurrent, type RecoveryReport, type ResearchReport, renderActionAudit, renderBacktest, renderChallenger, renderDqFaults, renderHeadline, renderModelComparison, renderOracleCoverage, renderRecovery, renderResearch, renderResultsPage, replaceSection, START } from "../../scripts/lib/results.ts";

const between = (md: string) => md.slice(md.indexOf(START) + START.length + 1, md.indexOf(END) - 1);

function dq(date: string, detected: number): Entry {
  const report: DqFaultsReport = { kind: "dq-faults", command: "uv run --project engine staysignal eval dq-faults", date, seeds: [1, 2, 3, 4, 5], summary: { pay_basis: { seeds: 5, detected: 5, held: 5, checks: ["C01"], root_top1: 5, root_found: 5, mean_abs_impact: 0.1, max_abs_impact: 0.2 }, duplicates: { seeds: 5, detected, held: 0, checks: ["U01"], root_top1: detected, root_found: detected, mean_abs_impact: 0, max_abs_impact: 0 } } };
  return { file: `results/dq-faults-${date}.json`, report };
}

describe("README Results generation", () => {
  it("replaces only the marked section", () => {
    const md = `# T\n${START}\nold\n${END}\ntail`;
    expect(replaceSection(md, "new")).toBe(`# T\n${START}\nnew\n${END}\ntail`);
    expect(() => replaceSection("no markers", "x")).toThrow();
  });

  it("says so when nothing is recorded", () => {
    expect(renderHeadline([])).toBe("No recorded results yet.");
    expect(renderResultsPage([])).toContain("No recorded results yet.");
  });

  it("keeps the README headline in sync with the committed results", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(between(readme)).toBe(renderHeadline(loadReports(process.cwd())));
  });

  it("keeps docs/RESULTS.md in sync with the committed results", () => {
    expect(readFileSync(RESULTS_PAGE, "utf8")).toBe(renderResultsPage(loadReports(process.cwd())));
  });

  it("takes only the latest run of a kind for the headline, and keeps the earlier one on the page", () => {
    const reports = [dq("2026-10-12", 1), dq("2026-10-13", 5)];
    const md = renderHeadline(reports);
    expect(md).toContain("10 of 10 detected, root ranked first in 10; 5 held (duplicates only warn)");
    expect(md).toContain("[2026-10-13](results/dq-faults-2026-10-13.json)");
    expect(md).not.toContain("2026-10-12");
    expect(latest(reports, "dq-faults")?.report.date).toBe("2026-10-13");
    expect(partitionCurrent(reports).earlier.map((e) => e.file)).toEqual(["results/dq-faults-2026-10-12.json"]);
    const page = renderResultsPage(reports);
    expect(page.indexOf("## Earlier runs")).toBeLessThan(page.indexOf("results/dq-faults-2026-10-12.json"));
  });

  it("keeps an agent eval per model current, and never heads with the stub", () => {
    const agent = (model: string, date: string): Entry => ({ file: `evals/results/agent-${model}-${date}.json`, report: { kind: "agent-eval", command: `npm run eval:agent -- --model ${model}`, date, model, items: 2, metrics: { routing_accuracy: 0.5, grounding_pass_rate: 0.5, refusal_accuracy: 1, injection_successes: 0, multi_turn_accuracy: 0.4, latency_ms_p50: 6300, latency_ms_p95: 17000 }, results: [{ category: "injection", ok: true }, { category: "refusal", ok: true }] } satisfies AgentEvalReport });
    const reports = [agent("stub", "2026-10-14"), agent("llama", "2026-10-13")];
    expect(partitionCurrent(reports).earlier).toEqual([]);
    expect(renderHeadline(reports)).toContain("0 of 1 injections succeeded; 1 of 1 refusals correct; routing 50.0% | `npm run eval:agent -- --model llama` |");
  });

  it("writes a headline that reads at a glance: sourced, short, synthetic and dash-free", () => {
    const md = renderHeadline(loadReports(process.cwd()));
    expect(md.split("\n")[0]).toContain("Synthetic world");
    const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Question"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(8);
    for (const r of rows) {
      const cells = r.split(" | ").map((c) => c.replace(/^\| |\|$/g, "").trim());
      expect(cells[2]).toMatch(/^`[^`]+`/);
      expect(cells[3]).toMatch(/^\[\d{4}-\d{2}-\d{2}\]\((results|evals\/results)\/[^)]+\.json\)/);
      for (const c of cells) expect(c.replace(/\]\([^)]*\)/g, "]").replace(/[`[\]]/g, "").length).toBeLessThanOrEqual(100);
    }
    for (const l of md.split("\n")) expect(l.length).toBeLessThanOrEqual(400);
    expect(md).not.toMatch(/[\u2013\u2014\u2212]/);
    expect(md).not.toContain("40 or over");
  });

  it("links every file on docs/RESULTS.md relative to docs/", () => {
    const page = readFileSync(RESULTS_PAGE, "utf8");
    const targets = [...page.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g), ...page.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]!).filter((t) => !/^https?:/.test(t));
    expect(targets.length).toBeGreaterThan(10);
    for (const t of targets) expect(existsSync(join(dirname(RESULTS_PAGE), t)), t).toBe(true);
    expect(page).not.toMatch(/[\u2013\u2014\u2212]/);
  });

  it("renders the fault benchmark per fault", () => {
    const r: DqFaultsReport = { kind: "dq-faults", command: "uv run --project engine staysignal eval dq-faults", date: "2026-10-12", seeds: [1, 2], summary: { pay_basis: { seeds: 2, detected: 2, held: 2, checks: ["C01", "C04"], root_top1: 2, root_found: 2, mean_abs_impact: 0.161, max_abs_impact: 0.25 }, broken_manager: { seeds: 2, detected: 0, held: 0, checks: [], root_top1: 0, root_found: 0, mean_abs_impact: null, max_abs_impact: null } } };
    const md = renderDqFaults("results/dq.json", r);
    expect(md).toContain("| Pay-basis code with annual amounts | 2 of 2 | 2 of 2 | C01, C04 | 2 of 2 | 16.1%, 25.0% |");
    expect(md).toContain("| Broken manager references | 0 of 2 | 0 of 2 | none | 0 of 2 | n/a |");
  });

  it("renders the research benchmark with each verdict and every cell", () => {
    const r: ResearchReport = {
      kind: "research",
      command: "uv run --project engine staysignal research run --seeds 1-20",
      date: "2026-10-12",
      prereg_sha256: "abcdef0123456789",
      seeds: [1, 2],
      origins: ["2024-10-01"],
      cells: [{ factor: "A", level: "0.30", handling: "matured", oe: 1.0123, oe_lo90: 0.98, oe_hi90: 1.04, oe_equivalent: true, cov80: 0.8, cov80_equivalent: true, team_pit_ks: null }],
      hypotheses: { H1: { verdict: "consistent" }, H5: { verdict: "descriptive" } },
    };
    const md = renderResearch("results/research.json", r);
    expect(md).toContain("SHA-256 `abcdef012345`");
    expect(md).toContain("Verdicts by the registered rules: H1 consistent; H5 descriptive.");
    expect(md).toContain("| A | 0.30 | matured | 1.012 (0.980 to 1.040) | yes | 80.0% |  |");
  });

  it("renders the challenger with its row cap and the like-for-like model", () => {
    const r: ChallengerReport = {
      kind: "challenger",
      command: "uv run --project engine staysignal eval challenger",
      date: "2026-10-12",
      n_iter: 100,
      row_cap: 12000,
      origins: ["2024-10-01", "2025-01-01"],
      models: ["survivalboost", "survivalboost-shock", "dtcr-mnl-12k"],
      fits: [
        { origin: "2024-10-01", rows: 9800, eligible_person_landmarks: 9800, survivalboost_fit_seconds: 40.2 },
        { origin: "2025-01-01", rows: 12000, eligible_person_landmarks: 13500, survivalboost_fit_seconds: 51.7 },
      ],
      summary: { "company|3": { level: "company", horizon_months: 3, windows: 2, survivalboost: { mae: 4.25, observed_over_expected: 1.1, coverage80: 0.5, coverage95: 1 } } },
    };
    const md = renderChallenger("results/challenger.json", r);
    expect(md).toContain("fitted on 9,800 to 12,000 sampled person-landmarks per origin (cap 12,000; 40.2 to 51.7 s per fit)");
    expect(md).toContain("| company | 3 months | survivalboost | 4.3 | 1.10 | 50.0% | 100.0% |");
    expect(md).not.toContain("dtcr-mnl-12k |");
  });

  it("renders ground-truth recovery with the three checks and their rules", () => {
    const r: RecoveryReport = {
      kind: "recovery",
      command: "uv run --project engine staysignal eval recovery",
      date: "2026-10-12",
      profile: "recovery",
      seed: 1011,
      baseline_headcount: 40040,
      months: 42,
      rows: 1856314,
      events: { voluntary: 15080, involuntary: 3754, retirement: 1110 },
      clusters: 2400,
      wald: { statistic: 20.5, df: 29, p_value: 0.876, alpha: 0.01 },
      coverage_95: { inside: 33, slopes: 34, share: 0.9706 },
      signs: { checked: 28, correct: 28 },
      passed: { wald: true, coverage: true, signs: false },
    };
    const md = renderRecovery("results/recovery.json", r);
    expect(md).toContain("40,040 employees at the start, 42 months");
    expect(md).toContain("| Joint Wald test of the 29 voluntary slopes against the truth | p = 0.876 (passed) | p of at least 0.01 |");
    expect(md).toContain("| Slopes inside their 95% intervals | 33 of 34, 97.1% (passed) | at least 85% |");
    expect(md).toContain("28 of 28 (failed)");
    expect(md).toContain("Synthetic world");
  });

  it("renders oracle coverage with its command, date, target and per-cause table", () => {
    const r: OracleCoverageReport = {
      kind: "oracle-coverage",
      command: "uv run --project engine staysignal eval oracle-coverage --futures 2000",
      date: "2026-10-12",
      profile: "canonical",
      seed: 20261011,
      level: 0.9,
      band: [0.8, 0.97],
      n_futures: 2000,
      origins: ["2023-10-01", "2026-04-01"],
      cells: 18,
      coverage: 0.9123,
      within_band: true,
      by_cause_horizon: { "voluntary|3": { cells: 2, coverage: 1 } },
      seconds: 1,
    };
    const md = renderOracleCoverage("results/x.json", r);
    expect(md).toContain("91.2% of 18 cells (target 80.0% to 97.0%; met)");
    expect(md).toContain("2026-10-12");
    expect(md).toContain("| voluntary | n/a | 100.0% of 2 | n/a |");
    expect(md).not.toMatch(/[\u2013\u2014]/);
  });

  it("renders backtests and the model comparison with their commands and the synthetic sentence", () => {
    const bt: BacktestReport = {
      kind: "backtest",
      command: "uv run --project engine staysignal eval backtest",
      date: "2026-10-12",
      provisional_windows_excluded: 12,
      levels: { "company|3": { level: "company", horizon_months: 3, windows: 19, origins: 19, effective_windows: 6, mae: 7.25, skill_vs_hist: 0.2, observed_over_expected: 0.94, coverage80: 0.8421, coverage95: 1, rps: 3.1 } },
    };
    const md = renderBacktest("results/b.json", bt);
    expect(md).toContain("| company | 3 months | 19 (6) | 0.94 | 84.2% | 100.0% | 7.3 | 20% | 3.10 |");
    expect(md).toContain("not real-world accuracy");
    const cmp: ModelComparisonReport = {
      kind: "model-comparison",
      command: "uv run --project engine staysignal eval backtest --futures 2000",
      date: "2026-10-12",
      origins: ["2024-10-01", "2026-01-01"],
      models: ["dtcr-mnl", "hist"],
      summary: { "company|3": { level: "company", horizon_months: 3, windows: 6, "dtcr-mnl": { mae: 5, observed_over_expected: 1.02, coverage80: 0.8333, coverage95: 1 }, hist: { mae: 6.5, observed_over_expected: 0.9, coverage80: 0.5, coverage95: 0.6667 } } },
    };
    const md2 = renderModelComparison("results/c.json", cmp);
    expect(md2).toContain("| company | 3 months | hist | 6.5 | 0.90 | 50.0% | 66.7% |");
    expect(md2).toContain("the same 2 quarterly origins");
  });
  it("renders the action audit's proxy screens and never the audit-only age screen", () => {
    const r: ActionAuditReport = {
      kind: "action-audit",
      command: "uv run --project engine staysignal audit actions",
      date: "2026-10-12",
      reviews: 12,
      review_window: ["2025-10-14", "2026-09-08"],
      units: 23761,
      screens: {
        location: { kind: "proxy", rows: [{ group: "Vancouver", people: 408, rate: 0.046, ratio: 0.73, four_fifths_flag: true, fisher_p: 0.0001, too_small: false }] },
        age40: { kind: "audit_only", rows: [{ group: "40 or over", people: 997, rate: 0.06, ratio: 1, four_fifths_flag: false, fisher_p: 0.5, too_small: false }] },
      },
      proxy_strength: { tenure_band_auc: 0.62, level_band_auc: 0.567 },
    };
    const md = renderActionAudit("results/action-audit-2026-10-12.json", r);
    expect(md).toContain("| Location | Vancouver | 408 | 4.6% | 0.73 | < 0.001 | below |");
    expect(md).not.toContain("40 or over");
    expect(md).toContain("tenure band 0.62");
  });
});
