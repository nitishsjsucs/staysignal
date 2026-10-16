// Renders results/*.json and evals/results/*.json into the README headline and docs/RESULTS.md (pattern copied from
// PeopleLake scripts/lib/results.ts, MIT). Only numbers produced by this repository's scripts appear, each with its
// command and date. Every StaySignal result is computed on the synthetic world and says so.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

export interface StreamMeasure {
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  ttftMs: number;
  decodeTokPerS: number | null;
  prefillTokPerS: number | null;
}

export interface LlmMeasureReport {
  kind: "llm-measure";
  command: string;
  date: string;
  status: string;
  error?: string;
  model: string;
  w_gb_after_load: number | null;
  load_ms_to_health: number | null;
  warmup?: StreamMeasure;
  prefill_4k_cold?: StreamMeasure;
  prefill_4k_cached_prefix?: StreamMeasure;
  prefill_8k_cold?: StreamMeasure;
  decode_4k?: StreamMeasure;
  after_load?: { wiredDeltaBytes: number | null };
  tool_calls_sdk?: { question: string; tool_calls: { tool: string }[] }[];
  machine?: { stopped_by: string | null; before: { swapUsedBytes: number } | null; after: { swapUsedBytes: number } | null };
}

export interface OracleCoverageReport {
  kind: "oracle-coverage";
  command: string;
  date: string;
  profile: string;
  seed: number;
  level: number;
  band: [number, number];
  n_futures: number;
  origins: string[];
  cells: number;
  coverage: number;
  within_band: boolean;
  by_cause_horizon: Record<string, { cells: number; coverage: number }>;
  seconds: number;
}

export interface DemoResetReport {
  kind: "demo-reset";
  command: string;
  date: string;
  beat: number;
  seconds: number;
  target_seconds: number;
}

interface LevelRow {
  level: string;
  horizon_months: number;
  windows: number;
  origins: number;
  effective_windows: number;
  mae: number;
  skill_vs_hist: number;
  observed_over_expected: number;
  coverage80: number;
  coverage95: number;
  rps: number;
}

export interface BacktestEntry {
  origin: string;
  cohort: string;
  level: string;
  horizon_months: number;
  status: "mature" | "provisional" | "pending";
  actual: number;
  expected: number;
  hist_expected: number;
  i80: [number, number];
  i95: [number, number];
}

export interface BacktestReport {
  kind: "backtest";
  command: string;
  date: string;
  levels: Record<string, LevelRow>;
  provisional_windows_excluded: number;
  entries?: BacktestEntry[];
}

export interface CalibrationReport {
  kind: "calibration";
  command: string;
  date: string;
  n: number;
  ici: number;
  e50: number;
  e90: number;
  reliability: { bin: number; n: number; predicted: number; observed: number; observed_i80: [number, number] }[];
}

export interface ModelComparisonReport {
  kind: "model-comparison";
  command: string;
  date: string;
  origins: string[];
  models: string[];
  summary: Record<string, { level: string; horizon_months: number; windows: number } & Record<string, unknown>>;
}

export interface AgentEvalReport {
  kind: "agent-eval";
  command: string;
  date: string;
  model: string;
  items: number;
  metrics: {
    routing_accuracy: number | null;
    grounding_pass_rate: number | null;
    refusal_accuracy: number | null;
    injection_successes: number;
    multi_turn_accuracy: number | null;
    infrastructure_errors?: number;
    latency_ms_p50: number | null;
    latency_ms_p95: number | null;
    refusal_by_code?: Record<string, { gold: number; refused_with_code: number; precision: number | null; recall: number | null }>;
  };
  results?: { category: string; ok: boolean }[];
}

export interface EffectsReport {
  kind: "effects";
  command: string;
  date: string;
  population: number;
  effects: Record<string, { label: string; points: { x: number; cif: number; lo: number; hi: number }[] }>;
}

export interface ActionAuditReport {
  kind: "action-audit";
  command: string;
  date: string;
  reviews: number;
  review_window: [string, string];
  units: number;
  screens: Record<string, { kind: string; rows: { group: string; people: number; rate: number | null; ratio: number | null; four_fifths_flag: boolean; fisher_p: number | null; too_small: boolean }[] }>;
  proxy_strength: { tenure_band_auc: number | null; level_band_auc: number | null } | null;
}

export interface RecoveryReport {
  kind: "recovery";
  command: string;
  date: string;
  profile: string;
  seed: number;
  baseline_headcount: number;
  months: number;
  rows: number;
  events: { voluntary: number; involuntary: number; retirement: number };
  clusters: number;
  wald: { statistic: number; df: number; p_value: number; alpha: number };
  coverage_95: { inside: number; slopes: number; share: number };
  signs: { checked: number; correct: number };
  passed: { wald: boolean; coverage: boolean; signs: boolean };
  slopes?: { cause: string; column: string; truth: number; estimate: number; se: number; inside_95: boolean }[];
}

export interface ChallengerReport {
  kind: "challenger";
  command: string;
  date: string;
  n_iter: number;
  row_cap: number;
  origins: string[];
  models: string[];
  fits: { origin: string; rows: number; eligible_person_landmarks: number; survivalboost_fit_seconds: number }[];
  summary: ModelComparisonReport["summary"];
}

export interface ResearchReport {
  kind: "research";
  command: string;
  date: string;
  prereg_sha256: string;
  seeds: number[];
  horizon_months?: number;
  origins: string[];
  cells: { factor: string; level: string; handling: string; oe: number; oe_lo90: number; oe_hi90: number; oe_equivalent: boolean; cov80: number; cov80_lo90?: number; cov80_hi90?: number; cov80_equivalent: boolean; team_pit_ks: number | null }[];
  hypotheses: Record<string, { verdict: string }>;
}

export interface DqFaultsReport {
  kind: "dq-faults";
  command: string;
  date: string;
  seeds: number[];
  design?: string;
  summary: Record<string, { seeds: number; detected: number; held: number; checks: string[]; root_top1: number; root_found: number; mean_abs_impact: number | null; max_abs_impact: number | null }>;
}

export interface RecoveryShockReport extends Omit<RecoveryReport, "kind"> {
  kind: "recovery-shock";
  sigma_team: number;
  targets: { file: string; seed: number; baseline_headcount: number; rows: number };
}

export type Report = LlmMeasureReport | OracleCoverageReport | DemoResetReport | BacktestReport | CalibrationReport | ModelComparisonReport | AgentEvalReport | EffectsReport | ActionAuditReport | RecoveryReport | RecoveryShockReport | ChallengerReport | ResearchReport | DqFaultsReport;
export const REPORT_KINDS: readonly string[] = ["llm-measure", "oracle-coverage", "demo-reset", "backtest", "calibration", "model-comparison", "agent-eval", "effects", "action-audit", "recovery", "recovery-shock", "challenger", "research", "dq-faults"];

/** A Markdown link to a repository file; `base` is the path from the page to the repository root ("" or "../"). */
const link = (file: string, base: string) => `[${file}](${base}${file})`;

const gb = (b: number | null | undefined) => (b === null || b === undefined ? "n/a" : `${(b / 1e9).toFixed(2)} GB`);
const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const n = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "n/a" : `${v.toLocaleString("en-US")}${unit}`);

function probeRow(name: string, m: StreamMeasure | undefined): string {
  if (!m) return `| ${name} | not reached | | | |`;
  return `| ${name} | ${n(m.promptTokens)} (${n(m.cachedTokens)} cached) | ${s(m.ttftMs)} | ${n(m.prefillTokPerS, " tok/s")} | ${n(m.decodeTokPerS, " tok/s")} |`;
}

export function renderLlmMeasure(file: string, r: LlmMeasureReport, base = ""): string {
  const lines: string[] = [];
  lines.push(`**Local model measurement: ${r.model}** (\`${r.command}${r.model.includes("1.7B") ? " -- --model 1.7b" : ""}\`, ${r.date}, ${link(file, base)}). Status: ${r.status}${r.error ? ` (${r.error.replace(/\{"error": "(.*)"\}/, "$1")})` : ""}. Agent-shaped prompts: the system prompt plus the 13 tool schemas, and prior tool-result digests (synthetic placeholders).`);
  lines.push("");
  lines.push("| Probe | Prompt tokens | Time to first token | Prefill rate (new tokens) | Decode rate |");
  lines.push("|---|---|---|---|---|");
  lines.push(probeRow("system prompt and 13 tools (cold)", r.warmup));
  lines.push(probeRow("prior exchanges with digests", r.prefill_4k_cold));
  lines.push(probeRow("same history, new question", r.prefill_4k_cached_prefix));
  lines.push(probeRow("longer history", r.prefill_8k_cold));
  lines.push(probeRow("history plus an answer of up to 200 tokens", r.decode_4k));
  lines.push("");
  const extras: string[] = [];
  if (r.after_load?.wiredDeltaBytes) extras.push(`wired memory added by the load: ${gb(r.after_load.wiredDeltaBytes)}`);
  if (r.machine?.before && r.machine.after) extras.push(`swap used before and after: ${gb(r.machine.before.swapUsedBytes)} and ${gb(r.machine.after.swapUsedBytes)}`);
  if (r.machine?.stopped_by) extras.push(`stopped by: ${r.machine.stopped_by}`);
  if (r.tool_calls_sdk?.length) {
    extras.push(`tool calls through \`@ai-sdk/openai-compatible\`: ${r.tool_calls_sdk.map((t) => t.tool_calls.map((c) => c.tool).join(", ") || "none").join("; ")}`);
  }
  if (extras.length) lines.push(`${extras.join("; ")}.`);
  return lines.join("\n");
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function renderOracleCoverage(file: string, r: OracleCoverageReport, base = ""): string {
  const lines: string[] = [];
  const first = r.origins[0] ?? "";
  const last = r.origins[r.origins.length - 1] ?? "";
  lines.push(
    `**Oracle coverage (C5)** (\`${r.command}\`, ${r.date}, ${link(file, base)}). Synthetic world (\`${r.profile}\`, seed ${r.seed}). The forward-simulation oracle's ${Math.round(r.level * 100)}% intervals (${r.n_futures.toLocaleString("en-US")} futures each) against the realized counts at ${r.origins.length} quarterly origins from ${first} to ${last}, for the company and each organization, by cause and horizon: ${pct(r.coverage)} of ${r.cells} cells (target ${pct(r.band[0])} to ${pct(r.band[1])}; ${r.within_band ? "met" : "not met"}).`,
  );
  lines.push("");
  lines.push("| Cause | 1 month | 3 months | 6 months |");
  lines.push("|---|---|---|---|");
  for (const cause of ["voluntary", "involuntary", "retirement"]) {
    const cell = (h: number) => {
      const c = r.by_cause_horizon[`${cause}|${h}`];
      return c ? `${pct(c.coverage)} of ${c.cells}` : "n/a";
    };
    lines.push(`| ${cause} | ${cell(1)} | ${cell(3)} | ${cell(6)} |`);
  }
  lines.push("");
  lines.push("Both the oracle and the realized counts come from the generator, so this checks that the oracle reproduces the world's own process; it says nothing about real-world accuracy. For small causes the counts are discrete, so an equal-tailed interval can cover more than its nominal level.");
  return lines.join("\n");
}

export function renderDemoReset(file: string, r: DemoResetReport, base = ""): string {
  return `**Demo reset** (\`${r.command}\`, ${r.date}, ${link(file, base)}): restoring the snapshot for the start of beat ${r.beat} and restarting the demo profile (wrangler dev and the local engine) took ${r.seconds.toFixed(1)} s, against a target of ${r.target_seconds} s. Synthetic demo state.`;
}

const SYNTHETIC = "Synthetic world: these numbers test the pipeline and the uncertainty method, not real-world accuracy.";

export function renderBacktest(file: string, r: BacktestReport, base = ""): string {
  const lines = [`**Monthly pseudo-real-time backtests** (\`${r.command}\`, ${r.date}, ${link(file, base)}). Model and data as known at each origin from 2024-10-01 to 2026-09-01, mature windows only (${r.provisional_windows_excluded} provisional windows left out), company and organizations of 50 or more, \`voluntary_departures@2\`. ${SYNTHETIC}`, ""];
  lines.push("| Level | Horizon | Windows (independent) | Observed over expected | 80% range held | 95% range held | MAE | Skill against the trailing rate | Mean RPS |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const l of Object.values(r.levels)) {
    lines.push(`| ${l.level} | ${l.horizon_months} month${l.horizon_months > 1 ? "s" : ""} | ${l.windows} (${l.effective_windows}) | ${l.observed_over_expected.toFixed(2)} | ${pct(l.coverage80)} | ${pct(l.coverage95)} | ${l.mae.toFixed(1)} | ${(l.skill_vs_hist * 100).toFixed(0)}% | ${l.rps.toFixed(2)} |`);
  }
  return lines.join("\n");
}

export function renderCalibration(file: string, r: CalibrationReport, base = ""): string {
  return `**Calibration of individual 3-month predictions** (\`${r.command}\`, ${r.date}, ${link(file, base)}): ${r.n.toLocaleString("en-US")} person-windows at mature monthly origins, compared in ${r.reliability.length} deciles of 10 or more (only deciles are ever stored): ICI ${pct(r.ici)}, E50 ${pct(r.e50)}, E90 ${pct(r.e90)}. ${SYNTHETIC}`;
}

export function renderModelComparison(file: string, r: ModelComparisonReport, base = ""): string {
  const lines = [`**Model comparison** (\`${r.command}\`, ${r.date}, ${link(file, base)}): the same ${r.origins.length} quarterly origins (${r.origins[0]} to ${r.origins[r.origins.length - 1]}) for every model, mature windows only; the oracle knows the latent propensities and the generator, which no model can. ${SYNTHETIC}`, ""];
  lines.push("| Level | Horizon | Model | MAE | Observed over expected | 80% range held | 95% range held |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const s of Object.values(r.summary)) {
    for (const m of r.models) {
      const v = s[m] as { mae: number; observed_over_expected: number; coverage80: number; coverage95: number } | undefined;
      if (!v) continue;
      lines.push(`| ${s.level} | ${s.horizon_months} month${s.horizon_months > 1 ? "s" : ""} | ${m} | ${v.mae.toFixed(1)} | ${v.observed_over_expected.toFixed(2)} | ${pct(v.coverage80)} | ${pct(v.coverage95)} |`);
    }
  }
  return lines.join("\n");
}

/** C15: the challenger and the like-for-like main model, on the model comparison's origins. */
export function renderChallenger(file: string, r: ChallengerReport, base = ""): string {
  const rows = r.fits.map((f) => f.rows);
  const secs = r.fits.map((f) => f.survivalboost_fit_seconds);
  const lines = [
    `**Challenger** (\`${r.command}\`, ${r.date}, ${link(file, base)}): \`hazardous\` SurvivalBoost (${r.n_iter} iterations) on the same ${r.origins.length} quarterly origins as the model comparison, fitted on ${Math.min(...rows).toLocaleString("en-US")} to ${Math.max(...rows).toLocaleString("en-US")} sampled person-landmarks per origin (cap ${r.row_cap.toLocaleString("en-US")}; ${Math.min(...secs)} to ${Math.max(...secs)} s per fit), with Poisson-binomial intervals and a shock-aware variant; \`dtcr-mnl-12k\` is the competing-risks model fitted on the same sampled people, so the row cap is a handicap both carry. ${SYNTHETIC}`,
    "",
    "| Level | Horizon | Model | MAE | Observed over expected | 80% range held | 95% range held |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const s of Object.values(r.summary)) {
    for (const m of r.models) {
      const v = s[m] as { mae: number; observed_over_expected: number; coverage80: number; coverage95: number } | undefined;
      if (!v) continue;
      lines.push(`| ${s.level} | ${s.horizon_months} month${s.horizon_months > 1 ? "s" : ""} | ${m} | ${v.mae.toFixed(1)} | ${v.observed_over_expected.toFixed(2)} | ${pct(v.coverage80)} | ${pct(v.coverage95)} |`);
    }
  }
  return lines.join("\n");
}

/** The pre-registered research benchmark: each hypothesis's verdict, then every cell. */
export function renderResearch(file: string, r: ResearchReport, base = ""): string {
  const lines = [
    `**Research benchmark** (\`${r.command}\`, ${r.date}, ${link(file, base)}; pre-registration ${link("research/PREREGISTRATION.md", base)}, SHA-256 \`${r.prereg_sha256.slice(0, 12)}\`): ${r.seeds.length} seeds, ${r.origins.length} quarterly origins, 3-month horizon, on synthetic research worlds with a known truth; equivalence by two one-sided tests on a seed bootstrap. ${SYNTHETIC}`,
    "",
    `Verdicts by the registered rules: ${Object.entries(r.hypotheses).map(([k, v]) => `${k} ${v.verdict}`).join("; ")}.`,
    "",
    "| Factor | Level | Handling | O/E (seed 90% interval) | O/E equivalent | 80% range held | Team PIT distance |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const c of r.cells) {
    lines.push(`| ${c.factor} | ${c.level} | ${c.handling.replace(/_/g, " ")} | ${c.oe.toFixed(3)} (${c.oe_lo90.toFixed(3)} to ${c.oe_hi90.toFixed(3)}) | ${c.oe_equivalent ? "yes" : "no"} | ${pct(c.cov80)} | ${c.team_pit_ks === null ? "" : c.team_pit_ks.toFixed(3)} |`);
  }
  return lines.join("\n");
}

const FAULT_NAMES: Record<string, string> = { pay_basis: "Pay-basis code with annual amounts", duplicates: "Duplicate HRIS records", late_terminations: "Late terminations", missing_extract: "Missing payroll extract", broken_manager: "Broken manager references" };

/** C53: which checks catch each planted fault, where the ranking puts its root, and its forecast impact. */
export function renderDqFaults(file: string, r: DqFaultsReport, base = ""): string {
  const n = r.seeds.length;
  // runs from 2026-10-13 also run the built phase-2 checks; the design text of each run says which suite it used
  const suite = r.design?.includes("phase-2") ? "the phase-1 checks and the built phase-2 checks (F04, R02, R04)" : "the phase-1 checks";
  const lines = [
    `**Data-quality fault benchmark** (\`${r.command}\`, ${r.date}, ${link(file, base)}): each fault injected into what the sources recorded for ${n} copies of the small world; detection by ${suite}, localization by the root-cause ranking, and the forecast's change had the run not been held. ${SYNTHETIC}`,
    "",
    "| Fault | Detected | Held | Checks that fired | Root ranked first | Forecast change (mean, max) |",
    "|---|---|---|---|---|---|",
  ];
  for (const [fault, x] of Object.entries(r.summary)) {
    const impact = x.mean_abs_impact === null ? "n/a" : `${pct(x.mean_abs_impact)}, ${pct(x.max_abs_impact ?? 0)}`;
    lines.push(`| ${FAULT_NAMES[fault] ?? fault} | ${x.detected} of ${x.seeds} | ${x.held} of ${x.seeds} | ${x.checks.join(", ") || "none"} | ${x.root_top1} of ${x.seeds} | ${impact} |`);
  }
  return lines.join("\n");
}

const MODEL_NAMES: Record<string, string> = { stub: "scripted stub", llama: "Qwen3-1.7B (local)", mlx: "Qwen3.6-27B (local)" };

export function renderAgentEval(file: string, r: AgentEvalReport, base = ""): string {
  const m = r.metrics;
  const p = (v: number | null) => (v === null ? "n/a" : pct(v));
  const ms = (v: number | null) => (v === null ? "n/a" : `${(v / 1000).toFixed(1)} s`);
  return [
    `**Agent eval, ${MODEL_NAMES[r.model] ?? r.model}** (\`${r.command}\`, ${r.date}, ${link(file, base)}): ${r.items} synthetic questions about the synthetic company through the same turn as the chat dock.`,
    "",
    "| Routing | Grounding | Refusals | Injection successes | Multi-turn | Infrastructure errors | Latency p50 | Latency p95 |",
    "|---|---|---|---|---|---|---|---|",
    `| ${p(m.routing_accuracy)} | ${p(m.grounding_pass_rate)} | ${p(m.refusal_accuracy)} | ${m.injection_successes} | ${p(m.multi_turn_accuracy)} | ${m.infrastructure_errors ?? 0} | ${ms(m.latency_ms_p50)} | ${ms(m.latency_ms_p95)} |`,
  ].join("\n");
}

export function renderEffects(file: string, r: EffectsReport, base = ""): string {
  const lines = [`**Feature effects** (\`${r.command}\`, ${r.date}, ${link(file, base)}): the mean predicted 3-month voluntary probability over the ${r.population.toLocaleString("en-US")} people of the 2026-10-01 population when one feature is set to each value; associational, not causal. ${SYNTHETIC}`, ""];
  lines.push("| Feature | Lowest value | Highest value |");
  lines.push("|---|---|---|");
  for (const f of Object.values(r.effects)) {
    const a = f.points[0]!;
    const b = f.points[f.points.length - 1]!;
    lines.push(`| ${f.label} | ${a.x}: ${(a.cif * 100).toFixed(1)}% | ${b.x}: ${(b.cif * 100).toFixed(1)}% |`);
  }
  return lines.join("\n");
}

const SCREEN_NAMES: Record<string, string> = { tenure_band: "Tenure band", location: "Location" };

/** The action audit's proxy screens (the audit-only age screen stays in the recorded file, for the auditor). */
export function renderActionAudit(file: string, r: ActionAuditReport, base = ""): string {
  const lines = [
    `**Action audit** (\`${r.command}\`, ${r.date}, ${link(file, base)}): ${r.reviews} seeded approved reviews (${r.review_window[0]} to ${r.review_window[1]}), ${r.units.toLocaleString("en-US")} person-review opportunities; each group's selection rate against the highest group's (the four-fifths rule of thumb) and Fisher's exact test. A screen of actions, not of the forecast. ${SYNTHETIC}`,
    "",
    "| Screen | Group | People | Selection rate | Impact ratio | Fisher p | Four-fifths |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [name, sc] of Object.entries(r.screens)) {
    if (sc.kind !== "proxy") continue;
    for (const g of sc.rows) {
      const p = g.fisher_p === null ? "n/a" : g.fisher_p < 0.001 ? "< 0.001" : g.fisher_p.toFixed(3);
      lines.push(`| ${SCREEN_NAMES[name] ?? name} | ${g.group} | ${g.people.toLocaleString("en-US")} | ${g.too_small || g.rate === null ? "too small" : pct(g.rate)} | ${g.ratio === null ? "n/a" : g.ratio.toFixed(2)} | ${p} | ${g.four_fifths_flag ? "below" : "above"} |`);
    }
  }
  if (r.proxy_strength) lines.push("", `Proxy strength for the audit-only age-40-or-over flag (AUC, 0.5 means none): tenure band ${r.proxy_strength.tenure_band_auc ?? "n/a"}, level band ${r.proxy_strength.level_band_auc ?? "n/a"}.`);
  return lines.join("\n");
}

/** C6: does the estimator recover a correctly specified truth? */
export function renderRecovery(file: string, r: RecoveryReport, base = ""): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const ok = (b: boolean) => (b ? "passed" : "failed");
  return [
    `**Ground-truth recovery (C6)** (\`${r.command}\`, ${r.date}, ${link(file, base)}). Synthetic world (\`${r.profile}\`, seed ${r.seed}): ${n(r.baseline_headcount)} employees at the start, ${r.months} months, with the latent propensity, the interaction, drift and shocks switched off, so the generator's hazards are exactly a multinomial logit. An unpenalized fit of the generator's own encodings on ${n(r.rows)} person-months (${n(r.events.voluntary)} voluntary, ${n(r.events.involuntary)} involuntary and ${n(r.events.retirement)} retirement exits), with standard errors clustered by ${n(r.clusters)} teams. ${SYNTHETIC}`,
    "",
    "| Check | Result | Rule |",
    "|---|---|---|",
    `| Joint Wald test of the ${r.wald.df} voluntary slopes against the truth | p = ${r.wald.p_value.toFixed(3)} (${ok(r.passed.wald)}) | p of at least ${r.wald.alpha} |`,
    `| Slopes inside their 95% intervals | ${r.coverage_95.inside} of ${r.coverage_95.slopes}, ${pct(r.coverage_95.share)} (${ok(r.passed.coverage)}) | at least 85% |`,
    `| Correct sign where the truth is at least 3 standard errors from zero | ${r.signs.correct} of ${r.signs.checked} (${ok(r.passed.signs)}) | all |`,
  ].join("\n");
}

/** C6, shock-world variant: the fit on a world with team shocks against simulated marginal targets. */
export function renderRecoveryShock(file: string, r: RecoveryShockReport, base = ""): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const ok = (b: boolean) => (b ? "passed" : "failed");
  return [
    `**Ground-truth recovery with team shocks (C6)** (\`${r.command}\`, ${r.date}, ${link(file, base)}). Synthetic world (\`${r.profile}\`, seed ${r.seed}): the recovery world with lognormal mean-one team shocks per quarter (sigma ${r.sigma_team}) that the model omits, so its slopes estimate marginal effects. They are compared with marginal targets, the same fit on a separate ${n(r.targets.baseline_headcount)}-person world from the same truth (seed ${r.targets.seed}, ${link(r.targets.file, base)}), with the targets' covariance added to the fit's. ${n(r.rows)} person-months, standard errors clustered by ${n(r.clusters)} teams. ${SYNTHETIC}`,
    "",
    "| Check | Result | Rule |",
    "|---|---|---|",
    `| Joint Wald test of the ${r.wald.df} voluntary slopes against the targets | p = ${r.wald.p_value.toFixed(3)} (${ok(r.passed.wald)}) | p of at least ${r.wald.alpha} |`,
    `| Slopes inside their 95% intervals around the targets | ${r.coverage_95.inside} of ${r.coverage_95.slopes}, ${pct(r.coverage_95.share)} (${ok(r.passed.coverage)}) | at least 85% |`,
    `| Correct sign where the target is at least 3 standard errors from zero | ${r.signs.correct} of ${r.signs.checked} (${ok(r.passed.signs)}) | all |`,
  ].join("\n");
}

export interface Entry {
  file: string;
  report: Report;
}

/** Every recorded result under results/ and evals/results/ whose kind this module renders. */
export function loadReports(root: string): Entry[] {
  const out: Entry[] = [];
  for (const dir of ["results", "evals/results"]) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir)).filter((x) => x.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const report = JSON.parse(readFileSync(join(root, dir, name), "utf8")) as Report;
      if (REPORT_KINDS.includes(report.kind)) out.push({ file: `${dir}/${name}`, report });
    }
  }
  return out;
}

type Of<K extends Report["kind"]> = Extract<Report, { kind: K }>;

const RENDERERS: { [K in Report["kind"]]: (file: string, r: Of<K>, base: string) => string } = {
  "llm-measure": renderLlmMeasure,
  "oracle-coverage": renderOracleCoverage,
  "demo-reset": renderDemoReset,
  backtest: renderBacktest,
  calibration: renderCalibration,
  "model-comparison": renderModelComparison,
  "agent-eval": renderAgentEval,
  effects: renderEffects,
  "action-audit": renderActionAudit,
  recovery: renderRecovery,
  "recovery-shock": renderRecoveryShock,
  challenger: renderChallenger,
  research: renderResearch,
  "dq-faults": renderDqFaults,
};

/** One result file as a Markdown block; `base` is the path from the page to the repository root. */
export function renderBlock(e: Entry, base = ""): string {
  const render = RENDERERS[e.report.kind] as (file: string, r: Report, base: string) => string;
  return render(e.file, e.report, base);
}

const byDateThenFile = (a: Entry, b: Entry) => a.report.date.localeCompare(b.report.date) || a.file.localeCompare(b.file);
const byFile = (a: Entry, b: Entry) => a.file.localeCompare(b.file);

/** Every run of one kind, oldest first (by date, then file name). */
export function runsOf<K extends Report["kind"]>(reports: readonly Entry[], kind: K, filter?: (r: Of<K>) => boolean): { file: string; report: Of<K> }[] {
  return reports
    .filter((e): e is { file: string; report: Of<K> } => e.report.kind === kind && (!filter || filter(e.report as Of<K>)))
    .slice()
    .sort(byDateThenFile);
}

/** The latest run of one kind (by date, then file name), so a superseded run never feeds a headline or a chart. */
export function latest<K extends Report["kind"]>(reports: readonly Entry[], kind: K, filter?: (r: Of<K>) => boolean): { file: string; report: Of<K> } | null {
  const runs = runsOf(reports, kind, filter);
  return runs[runs.length - 1] ?? null;
}

const variant = (r: Report) => (r.kind === "agent-eval" || r.kind === "llm-measure" ? `${r.kind}|${r.model}` : r.kind);

/** Current runs are the latest per kind (per model for agent evals and local model measurements); the rest are earlier. */
export function partitionCurrent(reports: readonly Entry[]): { current: Entry[]; earlier: Entry[] } {
  const last = new Map<string, Entry>();
  for (const e of reports.slice().sort(byDateThenFile)) last.set(variant(e.report), e);
  const keep = new Set(last.values());
  return { current: reports.filter((e) => keep.has(e)).sort(byFile), earlier: reports.filter((e) => !keep.has(e)).sort(byFile) };
}

export const SYNTHETIC_LINE = "_Synthetic world: these numbers test the pipeline and the uncertainty method, not real-world accuracy._";

export const FAULT_SHORT: Record<string, string> = { pay_basis: "pay basis", duplicates: "duplicates", late_terminations: "late terminations", missing_extract: "missing extract", broken_manager: "broken manager references" };

/** "a", "a and b", "a, b and c" */
export function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function span(values: readonly number[], fmt: (v: number) => string): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return fmt(lo) === fmt(hi) ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`;
}

const signedPct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** The README headline: one question per row, answered from the latest recorded run, with its command and date. */
export function renderHeadline(reports: readonly Entry[]): string {
  const rows: string[] = [];
  const recorded = (...es: Entry[]) => es.map((e) => `[${e.report.date}](${e.file})`).join(", ");
  const row = (question: string, result: string, command: string, ...es: Entry[]) => rows.push(`| ${question} | ${result} | ${command} | ${recorded(...es)} |`);

  const dq = latest(reports, "dq-faults");
  if (dq) {
    const xs = Object.entries(dq.report.summary);
    const sum = (f: (x: DqFaultsReport["summary"][string]) => number) => xs.reduce((a, [, x]) => a + f(x), 0);
    const warnOnly = xs.filter(([, x]) => x.detected === x.seeds && x.held === 0).map(([k]) => FAULT_SHORT[k] ?? k);
    const result = `${sum((x) => x.detected)} of ${sum((x) => x.seeds)} detected, root ranked first in ${sum((x) => x.root_top1)}; ${sum((x) => x.held)} held${warnOnly.length ? ` (${listing(warnOnly)} only warn)` : ""}`;
    row("Are planted data faults caught before they publish?", result, `\`${dq.report.command}\``, dq);
  }

  const bt = latest(reports, "backtest");
  if (bt) {
    const at = (level: string) => Object.values(bt.report.levels).filter((l) => l.level === level);
    const org = at("organization");
    const company = at("company");
    if (org.length && company.length) {
      const beats = (ls: typeof org, word: string) => {
        const skill = ls.map((l) => l.skill_vs_hist);
        return `${skill.every((v) => v > 0) ? "yes" : skill.every((v) => v < 0) ? "no" : "about even"}, ${word}${span(skill, signedPct)}`;
      };
      row("Do the 80% ranges hold?", `organizations ${span(org.map((l) => l.coverage80), pct)}, company ${span(company.map((l) => l.coverage80), pct)} of mature windows (nominal 80%)`, `\`${bt.report.command}\``, bt);
      row("Does it beat the trailing rate?", `company: ${beats(company, "skill ")}; organizations: ${beats(org, "")}`, `\`${bt.report.command}\``, bt);
    }
  }

  const rec = latest(reports, "recovery");
  if (rec) {
    const shock = latest(reports, "recovery-shock");
    const c = rec.report.coverage_95;
    let result = `${c.inside} of ${c.slopes} slopes inside their 95% intervals (Wald p = ${rec.report.wald.p_value.toFixed(3)})`;
    let command = `\`${rec.report.command}\``;
    if (shock) {
      const s = shock.report.coverage_95;
      result += `; with team shocks ${s.inside} of ${s.slopes} (p = ${shock.report.wald.p_value.toFixed(3)})`;
      command += ` and \`${shock.report.command.split(" ").pop() ?? ""}\``;
    }
    row("Does the estimator recover a known truth?", result, command, rec, ...(shock ? [shock] : []));
  }

  const research = latest(reports, "research");
  if (research) row("Which pre-registered hypotheses held?", verdictLine(research.report), `\`${research.report.command}\``, research);

  const agent = latest(reports, "agent-eval", (r) => r.model !== "stub");
  if (agent) {
    const m = agent.report.metrics;
    const items = (cat: string) => (agent.report.results ?? []).filter((x) => x.category === cat);
    const inj = items("injection");
    const refusals = items("refusal");
    const parts = [
      inj.length ? `${m.injection_successes} of ${inj.length} injections succeeded` : `${m.injection_successes} injection successes`,
      refusals.length ? `${refusals.filter((x) => x.ok).length} of ${refusals.length} refusals correct` : `refusals ${m.refusal_accuracy === null ? "n/a" : pct(m.refusal_accuracy)}`,
      `routing ${m.routing_accuracy === null ? "n/a" : pct(m.routing_accuracy)}`,
    ];
    row(`Do the guardrails hold on a small local model (${(MODEL_NAMES[agent.report.model] ?? agent.report.model).replace(/ \(local\)$/, "")})?`, parts.join("; "), `\`${agent.report.command}\``, agent);
  }

  if (rows.length === 0) return "No recorded results yet.";
  return [SYNTHETIC_LINE, "", "| Question | Result | Command | Recorded |", "|---|---|---|---|", ...rows].join("\n");
}

/** "H3a and H3b consistent; H1, H2 and H4 count against; H5 descriptive", in the order the verdicts first appear. */
export function verdictLine(r: ResearchReport): string {
  const groups = new Map<string, string[]>();
  for (const [h, v] of Object.entries(r.hypotheses)) groups.set(v.verdict, [...(groups.get(v.verdict) ?? []), h]);
  const order = ["consistent", "counts against", "descriptive"];
  return [...groups.entries()]
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)))
    .map(([verdict, hs]) => `${listing(hs)} ${hs.length > 1 ? verdict.replace(/^counts /, "count ") : verdict}`)
    .join("; ");
}

/** The charts written by scripts/render-figures.ts, each drawn from the latest run of one kind. */
export const FIGURES: readonly { name: string; kind: Report["kind"]; size: "full" | "half"; alt: string }[] = [
  { name: "backtest-company-3m", kind: "backtest", size: "full", alt: "Company 3-month forecast ranges, expected departures, the trailing rate and observed departures at each monthly origin" },
  { name: "coverage", kind: "backtest", size: "half", alt: "How often the 80% and 95% ranges held, for the company and for organizations at 1, 3 and 6 months, against nominal" },
  { name: "reliability", kind: "calibration", size: "half", alt: "Predicted against observed 3-month departure probability by decile, with 80% intervals and the diagonal" },
  { name: "model-vs-trailing", kind: "model-comparison", size: "half", alt: "Count error of the model, the trailing rate and the oracle by horizon, for the company and for organizations" },
  { name: "recovery", kind: "recovery", size: "full", alt: "Estimated against true slopes with 95% intervals, without and with team shocks" },
  { name: "research", kind: "research", size: "full", alt: "Pre-registered study: observed over expected and 80% coverage with seed intervals against the equivalence bounds" },
  { name: "dq-faults", kind: "dq-faults", size: "half", alt: "Planted data faults detected before publishing, earlier and latest benchmark run" },
  { name: "agent-eval", kind: "agent-eval", size: "half", alt: "Share of agent eval questions handled correctly by category, on a small local model" },
  { name: "action-audit", kind: "action-audit", size: "half", alt: "Impact ratio by tenure band and location against the four-fifths line" },
];

export const FIGURE_DIR = "docs/images/figures";

/** A chart that follows the viewer's light or dark theme; `prefix` is the path from the page to the figure folder. */
export function picture(name: string, alt: string, prefix: string, width: string): string {
  return `<picture><source media="(prefers-color-scheme: dark)" srcset="${prefix}${name}-dark.svg"><img alt="${alt}" src="${prefix}${name}-light.svg" width="${width}"></picture>`;
}

export const RESULTS_PAGE_NOTICE = "<!-- Generated by npm run results:readme from results/ and evals/results/. Do not edit. -->";

const PAGE_SECTIONS: readonly { title: string; intro: string; kinds: readonly Report["kind"][]; figures: readonly string[] }[] = [
  { title: "Forecast accuracy and calibration", intro: "Monthly pseudo-real-time backtests (model and data as known at each origin), calibration of individual predictions, a comparison with the baselines and the challenger on the same quarterly origins, feature effects, and the oracle's own coverage.", kinds: ["backtest", "calibration", "model-comparison", "challenger", "effects", "oracle-coverage"], figures: ["backtest-company-3m", "coverage", "reliability", "model-vs-trailing"] },
  { title: "Ground-truth recovery", intro: "Does the estimator recover a truth it is told? Worlds whose hazards are exactly the model's form, without and with team shocks the model omits.", kinds: ["recovery", "recovery-shock"], figures: ["recovery"] },
  { title: "Pre-registered research benchmark", intro: "What breaks calibration, and which handling restores it, decided by the rules registered before any run.", kinds: ["research"], figures: ["research"] },
  { title: "Data-quality fault benchmark", intro: "Planted faults in copies of the small world: which checks catch each, where the root-cause ranking puts its root, and how far the forecast would have moved had the run not been held.", kinds: ["dq-faults"], figures: ["dq-faults"] },
  { title: "Agent evals", intro: "Synthetic questions through the same turn as the chat dock, scored on routing, grounding, refusals, prompt injection and multi-turn.", kinds: ["agent-eval"], figures: ["agent-eval"] },
  { title: "Action audit", intro: "A screen of the actions taken on approved reviews, not of the forecast: a flag is a reason to look, not a finding.", kinds: ["action-audit"], figures: ["action-audit"] },
  { title: "Local model and operations", intro: "Measurements of the local models on the author's laptop (not StaySignal results), and the demo reset time.", kinds: ["llm-measure", "demo-reset"], figures: [] },
];

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

/** docs/RESULTS.md: every current run with its tables and charts, then the earlier runs they superseded. */
export function renderResultsPage(reports: readonly Entry[]): string {
  const base = "../";
  const out = [RESULTS_PAGE_NOTICE, "", "# Results", "", SYNTHETIC_LINE, ""];
  if (reports.length === 0) return [...out, "No recorded results yet.", ""].join("\n");
  const { current, earlier } = partitionCurrent(reports);
  const kinds = new Set(reports.map((e) => e.report.kind));
  out.push(
    "Every block names the command that wrote its result file, the date it ran and the file itself. This page, the README's [Results at a glance](../README.md#results-at-a-glance) and the charts are generated from `results/` and `evals/results/` by `npm run results:readme`; `npm run results:check` and `npm test` fail when any of them is stale. How to read these numbers, and their limits: the README's limits note and the [model card](model-card.md).",
    "",
  );
  const sections = PAGE_SECTIONS.filter((s) => s.kinds.some((k) => kinds.has(k)));
  out.push(...sections.map((s) => `- [${s.title}](#${slug(s.title)})`));
  if (earlier.length) out.push("- [Earlier runs](#earlier-runs)");
  out.push("");
  for (const s of sections) {
    out.push(`## ${s.title}`, "", s.intro, "");
    for (const name of s.figures) {
      const f = FIGURES.find((x) => x.name === name);
      if (!f || !kinds.has(f.kind)) continue;
      out.push("<p>", picture(f.name, f.alt, "images/figures/", f.size === "full" ? "100%" : "560"), "</p>", "");
    }
    for (const kind of s.kinds) for (const e of current.filter((x) => x.report.kind === kind)) out.push(renderBlock(e, base), "");
  }
  if (earlier.length) {
    out.push("## Earlier runs", "", "Runs a later run of the same kind superseded, kept because the before and after is part of the record.", "");
    for (const e of earlier) out.push(renderBlock(e, base), "");
  }
  return out.join("\n");
}

export function replaceSection(readme: string, body: string): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("README results markers not found");
  return `${readme.slice(0, a + START.length)}\n${body}\n${readme.slice(b)}`;
}
