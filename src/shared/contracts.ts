// Shared data contracts between the engine's published layer, the Worker API and the web app (SPEC 16.2).
// Everything here is cohort-level; no type carries a person. Values are disclosure-rounded before they leave the
// engine (SPEC 17.5) and the Worker's guard rounds them again (idempotent).

export type Horizon = 1 | 3 | 6;
export const HORIZONS: readonly Horizon[] = [1, 3, 6];

export type CohortKind = "company" | "organization" | "group" | "team" | "org_level" | "org_tenure";

export interface Rounding {
  step: number;
  band: "n>=200" | "50<=n<200" | "10<=n<50";
}

export interface HorizonForecast {
  expected: number;
  i80: [number, number];
  i95: [number, number];
  variance: { parameter: number; org_shock: number; team_shock: number; process: number };
  hist: { expected: number; annual_rate: number; i80: [number, number] };
  other?: { expected: number; i80: [number, number]; i95: [number, number] };
}

export interface CurvePoint {
  month: number;
  date: string;
  vol: number;
  vol_lo80: number;
  vol_hi80: number;
  vol_lo95: number;
  vol_hi95: number;
  other?: number;
}

export interface CohortForecast {
  cohort_id: string;
  kind: CohortKind;
  name: string;
  parent: string | null;
  n: number;
  rounding: Rounding;
  joiners?: number;
  leavers?: number;
  n_previous?: number;
  horizons: Record<string, HorizonForecast>;
  curve: CurvePoint[];
}

export type RunStatus = "candidate" | "held" | "published" | "superseded";

export interface RunBrief {
  run_id: string;
  version: number;
  status: RunStatus;
  label: "synthetic";
  cutoff: string;
  vintage: string;
  model: string;
  model_sha256: string;
  metric_def: string;
  mapping: string;
  run_key: string;
  result_hash: string;
  prediction_vector_sha256: string;
  population: number;
  mc_config: Record<string, unknown>;
  incident_id?: string;
  failing_checks?: string[];
}

export interface ForecastFixture {
  run: RunBrief;
  label: "synthetic";
  provisional?: string;
  cohorts: CohortForecast[];
}

export interface RunsIndex {
  label: "synthetic";
  published: string;
  runs: RunBrief[];
}

/** Every API response (SPEC 16.2). */
export interface ApiResult<T> {
  result_id: string;
  label: "synthetic";
  provenance: Provenance;
  rounding: Rounding | null;
  suppressed_cells: number;
  data: T;
}

export interface Provenance {
  run_id?: string;
  catalog_entry?: string;
  metric_def?: string;
  vintage?: string;
  cutoff?: string;
  lineage_nodes?: string[];
  computed_by: "warehouse" | "engine" | "workspace";
  tool: string;
  args: Record<string, unknown>;
  /** The output class the result was computed for (see `audienceOf`); set when the result is stored. */
  audience?: Audience;
}

/** What a role's tool outputs contain: analysts and leads see everything their tools publish, People Partners see
 * assigned groups of 50 or more without Other exits, aggregate roles see the company only. */
export type Audience = "all" | "assigned" | "aggregate" | "none";

export interface ForecastData {
  cohort: { id: string; name: string; kind: CohortKind; n: number };
  horizon: Horizon;
  expected: number;
  step: number;
  i80: [number, number];
  i95: [number, number];
  annual_rate: number;
  hist: { expected: number; annual_rate: number; i80: [number, number] };
  variance: { parameter: number; org_shock: number; team_shock: number; process: number };
  curve: CurvePoint[];
  other: { expected: number; i80: [number, number]; i95: [number, number]; label: string } | null;
  cutoff: string;
  vintage: string;
  run_id: string;
  run_status: RunStatus;
  metric_def: string;
}

export interface BreakdownRow {
  cohort_id: string;
  cohort: string;
  n: number;
  expected: number | null;
  i80: [number, number] | null;
  rate: number | null;
  suppressed: boolean;
}

export interface BreakdownData {
  parent: { id: string; name: string };
  by: string;
  horizon: Horizon;
  rows: BreakdownRow[];
  note: string | null;
}

// ---------- history, change decomposition, quality, lineage, profiles (published fixtures) ----------

export interface HistoryPoint {
  origin: string;
  expected: number;
  i80: [number, number];
  i95: [number, number];
  actual: number | null;
  actual_status: "mature" | "provisional" | "pending";
  published_run_id: string | null;
  omitted_reason: string | null;
  definition_break?: boolean;
  n?: number; // the cohort's size at the origin
}

export interface HistoryFixture {
  label: "synthetic";
  note: string;
  definition_change: string;
  series: Record<string, Record<string, HistoryPoint[]>>; // cohort_id -> horizon -> points
}

/** One pre-registered cell of the research benchmark (research/PREREGISTRATION.md, SPEC 11). */
export interface ResearchCell {
  factor: "A" | "B" | "C" | "D" | "AxC";
  level: string;
  handling: string;
  seeds: number;
  company_windows: number;
  oe: number;
  oe_lo90: number;
  oe_hi90: number;
  oe_tost_p: number;
  oe_equivalent: boolean;
  cov80: number;
  cov80_lo90: number;
  cov80_hi90: number;
  cov80_tost_p: number;
  cov80_equivalent: boolean;
  cov95: number | null;
  interval_score80: number | null;
  team_pit_ks: number | null;
  team_cov80: number | null;
  team_windows: number;
}

export interface ResearchDoc {
  kind: "research";
  label: "synthetic";
  command: string;
  date: string;
  prereg_sha256: string;
  seeds: number[];
  origins: string[];
  horizon_months: number;
  design: string;
  cells: ResearchCell[];
  hypotheses: Record<string, { rule: string; verdict: "consistent" | "counts against" | "descriptive" } & Record<string, unknown>>;
}

/** One cohort on the Workforce page's funnel plot (SPEC 16.2): a mature backtest window, groups and above, n >= 50. */
export interface FunnelPoint {
  cohort: string;
  name: string;
  level: "company" | "organization" | "group";
  n: number;
  expected: number;
  observed: number;
  oe: number;
}

export interface FunnelData {
  label: "synthetic";
  horizon: number;
  origin: string | null;
  design: string;
  points: FunnelPoint[];
}

/** Recorded evaluation on the synthetic world (results/backtest, calibration and model-comparison), SPEC 10. */
export interface EvaluationEntry {
  origin: string;
  cohort: string;
  level: "company" | "organization";
  n: number;
  horizon_months: number;
  status: "mature" | "provisional" | "pending";
  actual: number;
  expected: number;
  hist_expected: number;
  i80: [number, number];
  i95: [number, number];
}

export interface EvaluationLevel {
  level: string;
  horizon_months: number;
  windows: number;
  origins: number;
  effective_windows: number;
  mae: number;
  rmse: number;
  mae_hist: number;
  skill_vs_hist: number;
  observed_over_expected: number;
  coverage80: number;
  coverage95: number;
  coverage80_block_i80: [number, number];
  interval_score80: number;
  interval_score95: number;
  pit_histogram: number[];
  rps: number;
}

export interface ComparisonMetrics {
  mae: number;
  rmse: number;
  observed_over_expected: number;
  coverage80: number;
  coverage95: number;
  interval_score80: number;
}

export interface EvaluationFixture {
  label: string;
  date: string;
  commands: string[];
  world_sha256: string;
  backtest: { design: string; levels: Record<string, EvaluationLevel>; provisional_windows_excluded: number; entries: EvaluationEntry[] };
  calibration: { design: string; n: number; ici: number; e50: number; e90: number; reliability: { bin: number; n: number; predicted: number; observed: number; observed_i80: [number, number] }[] } | null;
  comparison: { design: string; origins: string[]; models: string[]; summary: Record<string, { level: string; horizon_months: number; windows: number } & Record<string, ComparisonMetrics | string | number>> };
  effects?: { design: string; population: number; effects: Record<string, { label: string; points: { x: number; cif: number; lo: number; hi: number }[] }> } | null;
}

export type ChangeFactor = "calendar" | "composition" | "input_data" | "model" | "definition";

export interface FactorBar {
  factor: ChangeFactor | "time_and_population";
  label: string;
  phi: number;
  merged_from: ChangeFactor[];
  changed_people: number | null;
}

export interface ChangeEntry {
  cohort_id: string;
  horizon: number;
  from_value: number;
  to_value: number;
  delta: number;
  interval80_width: number;
  factors: FactorBar[];
  evaluations: { key: string; value: number }[];
  step: number;
}

export interface ChangesFixture {
  label: "synthetic";
  from: string;
  to: string;
  entries: ChangeEntry[];
}

export interface CheckResult {
  check_id: string;
  name: string;
  date: string;
  status: "pass" | "fail" | "warn";
  severity: "error" | "warn";
  failing_rows: number;
  node: string;
  source: string;
}

export interface QualityFixture {
  label: "synthetic";
  checks: { check_id: string; name: string; severity: "error" | "warn"; node: string; columns: string[]; source: string; phase: number; category: string }[];
  results: CheckResult[];
}

export interface CohortProfile {
  cohort_id: string;
  n: number;
  share_below_midpoint: number;
  median_months_since_promotion: number;
  promotion_rate_12m: number;
  open_backfill_reqs: number;
  open_growth_reqs: number;
  pending_backfill_offers: number;
  company: { share_below_midpoint: number; median_months_since_promotion: number; promotion_rate_12m: number };
}

export interface ProfilesFixture {
  label: "synthetic";
  run_id: string;
  profiles: CohortProfile[];
}

/** A request to a compiled semantic-catalog entry (SPEC 7.3): the server binds every value; the model never writes
 * SQL. Months are YYYY-MM; absent lists mean all; `scope` is the principal's organizations, set by the server. */
export interface CatalogRequest {
  start_month: string;
  end_month: string;
  organizations?: string[];
  groups?: string[];
  scope?: string[];
}

export interface CatalogResult {
  key: string;
  label: "synthetic";
  columns: string[];
  rows: (string | number | null)[][];
  sql_sha256: string;
}

/** One Sankey link of workforce flows over a window (SPEC 16.2, 17.5). Links under 10 people are merged into one
 * "Other" link per side; a merged link still under 10 is merged with the smallest shown link of its side, and a side
 * whose total is under 10 is one link with its value withheld (null). */
export interface FlowLink {
  source: string;
  target: string;
  value: number | null;
  merged_from?: string[];
}

export interface WorkforceFlowsData {
  cohort: { id: string; name: string; kind: CohortKind; n: number };
  level: "company" | "organization" | "group";
  from: string;
  to: string;
  headcount_start: number;
  /** null when a withheld side would make it reveal a count under 10 */
  headcount_end: number | null;
  joined: number | null;
  left: number | null;
  links: FlowLink[];
  catalog_entry: string;
  sql_sha256: string;
  note: string;
}

/** A memory file in a listing (SPEC 14.10). `commit` is the first 16 hex characters of the memory repository's commit
 * that last touched the file (never a SHA of this code repository). */
export interface MemoryFileInfo {
  path: string;
  id: string | null;
  type: string | null;
  title: string;
  bullets: number;
  commit: string;
  date: string;
}

/** The agent's memory write (SPEC 14.10): cohort-level bullets citing result IDs, runs or action sequence numbers. */
export interface MemoryNoteInput {
  kind: "timeline" | "investigation" | "decision";
  id?: string; // append to an existing investigation or decision note
  title?: string;
  bullets: string[];
  links?: string[];
  aliases?: string[];
}

export type MemoryWriteOutcome = { written: true; id: string | null; commit: string | null; files: string[] } | { written: false; reason: string };

export interface MemoryCommit {
  commit: string;
  date: string;
  message: string;
  files: string[];
}

export interface MemoryFileDoc {
  path: string;
  meta: Record<string, unknown>;
  title: string;
  bullets: { date: string; text: string }[];
  commit: string;
  date: string;
}

export interface MemorySearchData {
  query: string;
  hits: { path: string; line: number; snippet: string; commit: string; date: string }[];
  note: string;
}

/** One group of an action-audit screen (SPEC 17.7): selection units, rates and the adverse-impact screen. */
export interface AuditGroupRow {
  group: string;
  selected: number;
  n: number;
  people: number;
  too_small: boolean;
  rate: number | null;
  ratio: number | null;
  four_fifths_flag: boolean;
  fisher_p: number | null;
  warnings: string[];
  population_share: number | null;
  attention_share: number | null;
}

export interface ActionAuditDoc {
  kind: "action-audit";
  command: string;
  date: string;
  label: "synthetic";
  design: string;
  reviews: number;
  review_window: [string, string];
  units: number;
  selected_units: number;
  screens: Record<string, { kind: "proxy" | "audit_only"; rows: AuditGroupRow[] }>;
  proxy_strength: { date: string; people: number; tenure_band_auc: number | null; level_band_auc: number | null; note: string } | null;
  notes: string[];
}

/** The Scenario Lab (SPEC 15): hypothesis generation with synthetic personas; never a forecast or review evidence. */
export interface LabIndex {
  label: string | null;
  proposals: { id: string; session: string; placeholder: boolean }[];
}

export interface LabDoc {
  label: string;
  proposal: string;
  session: string;
  placeholder: boolean;
  provider: string;
  personas: { persona_id: string; handle: string; tenure_band: string }[];
  replicates: { run: string; card_variant: string; seed: number; rounds: number; calls: number; db_sha256: string }[];
  analysis: Record<string, unknown>;
  sanity: Record<string, unknown>;
}
