// The governed tool registry (SPEC 14.3). One registry feeds the AnalystAgent's AI SDK tools, the MCP server and
// the eval harness. Every tool is read-only or drafts only; every result is cohort-level, authorized, suppressed,
// rounded and stored under a content-addressed result ID. The model sees a result only through its digest.
import type { z } from "zod";
import type {
  BreakdownData,
  BreakdownRow,
  ChangesFixture,
  CohortForecast,
  CohortProfile,
  ForecastData,
  ForecastFixture,
  HistoryFixture,
  Horizon,
  ProfilesFixture,
  Provenance,
  QualityFixture,
  Rounding,
  RunsIndex,
} from "../contracts";
import { authorizeCohort, type CohortMeta, canUseTool, MIN_COMPARISON } from "../policy/authorize";
import { isRefusal, type Refusal, refuse } from "../policy/refusals";
import { hasScope, type Principal } from "../policy/roles";
import { roundingFor, roundInterval, roundToStep } from "../guard/disclosure";
import { comparisonServable } from "../guard/population";
import { hiddenSumSuppress } from "../guard/suppression";
import { resolveHorizon, type ToolName, toolDescriptions, toolInputs } from "./schemas";

export interface LineageFixture {
  label: "synthetic";
  nodes: { id: string; kind: string; label: string; columns?: string[] }[];
  edges: { from: string; to: string; columns?: [string, string][] }[];
  failing: Record<string, { path: string[]; ranking: { node: string; score: number; parts: Record<string, number> }[] }>;
}

/** Read access to the published layer. Fixtures in fixtures mode and CI; the engine shim locally; BigQuery in production. */
export interface WarehouseClient {
  mode: "fixtures" | "engine" | "bigquery";
  runs(): Promise<RunsIndex>;
  forecast(runId: string): Promise<ForecastFixture | null>;
  history(): Promise<HistoryFixture | null>;
  changes(fromRun: string, toRun: string): Promise<ChangesFixture | null>;
  quality(): Promise<QualityFixture | null>;
  lineage(): Promise<LineageFixture | null>;
  profiles(runId: string): Promise<ProfilesFixture | null>;
}

export interface ReviewDraft {
  draft_id: string;
  cohort_id: string;
  cohort: string;
  horizon: Horizon;
  run_id: string;
  label: "synthetic";
  checks: { category: "compensation" | "career" | "hiring"; title: string; question: string; evidence: string[]; facts: Record<string, number | string> }[];
  blocking_items: string[];
  lab_evidence: false;
}

export interface WorkspacePort {
  storeResult(result: ToolResult<unknown>, owner: string): Promise<void>;
  saveDraft?(draft: ReviewDraft, owner: string): Promise<void>;
  publishedRunId?(): Promise<string | null>;
}

export interface ToolContext {
  principal: Principal;
  warehouse: WarehouseClient;
  workspace: WorkspacePort | null;
  sha256: (text: string) => Promise<string>;
  canonical: (v: unknown) => string;
  /** The published run according to the WorkspaceAgent pointer (falls back to the warehouse index). */
  publishedRunId?: string | null;
}

export interface ToolResult<T> {
  result_id: string;
  tool: string;
  label: "synthetic";
  computed_by: "warehouse" | "engine" | "workspace";
  provenance: Provenance;
  suppressed_cells: number;
  rounding: Rounding | null;
  values: T;
}

export interface ModelDigest {
  alias: string;
  tool: string;
  label: "synthetic";
  [k: string]: unknown;
}

export interface ToolDef<I extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: ToolName;
  description: string;
  input: I;
  scopes: string[];
  kind: "read" | "draft";
  available: boolean;
  run(ctx: ToolContext, args: z.infer<I>): Promise<ToolResult<O> | Refusal>;
  digest(result: ToolResult<O>, alias: string): ModelDigest;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function base32(hex: string): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < hex.length; i += 2) {
    value = (value << 8) | Number.parseInt(hex.slice(i, i + 2), 16);
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

/** Content-addressed result ID (ADR 0017): "res_" + 26 base32 characters of SHA-256(tool, args, run key, data version). */
export async function resultId(ctx: ToolContext, tool: string, args: unknown, runKey: string, dataVersion: string): Promise<string> {
  const hex = await ctx.sha256(ctx.canonical({ tool, args: normalizeArgs(args), run_key: runKey, data_version: dataVersion }));
  return `res_${base32(hex).slice(0, 26)}`;
}

function normalizeArgs(args: unknown): unknown {
  if (args === null || typeof args !== "object") return args;
  if (Array.isArray(args)) return args.map(normalizeArgs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = typeof v === "number" && !Number.isInteger(v) ? String(v) : normalizeArgs(v);
  }
  return out;
}

// ---------- cohort resolution ----------

const ALIASES: Record<string, string> = {
  platform: "Platform Engineering",
  "platform eng": "Platform Engineering",
  eng: "Engineering",
  engineering: "Engineering",
  infra: "Infrastructure",
  "data team": "Data",
  "product engineering": "Product Engineering",
  security: "Security Engineering",
  sales: "Sales",
  "customer success": "Customer Success",
  support: "Technical Support",
  "tech support": "Technical Support",
  cs: "Customer Success & Support",
  "customer success and support": "Customer Success & Support",
  marketing: "Marketing",
  finance: "Finance",
  people: "People",
  legal: "Legal",
  it: "IT & Operations",
  "it and operations": "IT & Operations",
  "product and design": "Product & Design",
  "product design": "Product & Design",
  company: "Larkspur",
  "the company": "Larkspur",
  "whole company": "Larkspur",
  larkspur: "Larkspur",
  "larkspur systems": "Larkspur",
  everyone: "Larkspur",
  all: "Larkspur",
};

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\b(the|org|organization|organisation|group|department|dept|team|cohort)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function resolveCohort(query: string, cohorts: readonly CohortForecast[]): CohortForecast | null {
  const q = query.trim();
  const byId = cohorts.find((c) => c.cohort_id === q || c.cohort_id === `team:${q}`);
  if (byId) return byId;
  const norm = normalizeName(q);
  const target = ALIASES[norm] ?? ALIASES[q.toLowerCase()] ?? null;
  const order = ["company", "organization", "group", "team", "org_level", "org_tenure"];
  const sorted = [...cohorts].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const name = (c: CohortForecast) => (c.kind === "company" ? "Larkspur" : c.name);
  if (target) {
    const hit = sorted.find((c) => name(c) === target);
    if (hit) return hit;
  }
  const exact = sorted.find((c) => normalizeName(name(c)) === norm);
  if (exact) return exact;
  const prefix = sorted.find((c) => c.kind !== "org_level" && c.kind !== "org_tenure" && normalizeName(name(c)).startsWith(norm) && norm.length >= 3);
  return prefix ?? null;
}

export function cohortMeta(c: CohortForecast, all: readonly CohortForecast[]): CohortMeta {
  let org: string | null = null;
  if (c.kind === "organization") org = c.name;
  else if (c.kind === "org_level" || c.kind === "org_tenure") org = c.cohort_id.split(":")[1]!.split("|")[0]!;
  else if (c.kind !== "company") {
    let p = c.parent ? all.find((x) => x.cohort_id === c.parent) : undefined;
    while (p && p.kind !== "organization") p = p.parent ? all.find((x) => x.cohort_id === p!.parent) : undefined;
    org = p?.name ?? null;
  }
  return { id: c.cohort_id, kind: c.kind, name: c.kind === "company" ? "Larkspur" : c.name, n: c.n, org };
}

// ---------- helpers ----------

async function publishedRun(ctx: ToolContext): Promise<string> {
  if (ctx.publishedRunId) return ctx.publishedRunId;
  const p = ctx.workspace?.publishedRunId ? await ctx.workspace.publishedRunId() : null;
  return p ?? (await ctx.warehouse.runs()).published;
}

async function loadRun(ctx: ToolContext, runArg: string | undefined): Promise<ForecastFixture | Refusal> {
  const runId = runArg ?? (await publishedRun(ctx));
  const fx = await ctx.warehouse.forecast(runId);
  if (!fx) return refuse("OUT_OF_SCOPE", `Run ${runId} is not available.`);
  if (fx.run.status === "held" && !hasScope(ctx.principal, "forecast:read:all") && !hasScope(ctx.principal, "quality:read")) {
    return refuse("NOT_PERMITTED", "Held runs are visible to analysts and data engineers only.");
  }
  return fx;
}

async function finish<T>(ctx: ToolContext, tool: string, args: unknown, runKey: string, dataVersion: string, partial: Omit<ToolResult<T>, "result_id" | "tool" | "label">): Promise<ToolResult<T>> {
  const result: ToolResult<T> = { result_id: await resultId(ctx, tool, args, runKey, dataVersion), tool, label: "synthetic", ...partial };
  if (ctx.workspace) await ctx.workspace.storeResult(result as ToolResult<unknown>, ctx.principal.id);
  return result;
}

function horizonOf(args: { horizon_months?: number | undefined; horizon_days?: number | undefined }): Horizon {
  return resolveHorizon(args) as Horizon;
}

function cohortName(c: CohortForecast): string {
  return c.kind === "company" ? "Larkspur (company)" : c.name;
}

// ---------- tools ----------

const forecastDepartures: ToolDef<typeof toolInputs.forecast_departures, ForecastData> = {
  name: "forecast_departures",
  description: toolDescriptions.forecast_departures,
  input: toolInputs.forecast_departures,
  scopes: ["forecast:read:*"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const fx = await loadRun(ctx, args.run);
    if (isRefusal(fx)) return fx;
    const c = resolveCohort(args.cohort, fx.cohorts);
    if (!c) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    const meta = cohortMeta(c, fx.cohorts);
    const cause = args.cause ?? "voluntary";
    const denied = authorizeCohort(ctx.principal, "forecast_departures", meta, { cause });
    if (denied) return denied;
    const h = horizonOf(args);
    const hz = c.horizons[String(h)];
    if (!hz) return refuse("OUT_OF_SCOPE");
    const rounding = roundingFor(c.n);
    const showOther = (meta.kind === "company" || meta.kind === "organization") && (hasScope(ctx.principal, "forecast:read:all") || hasScope(ctx.principal, "publish:approve"));
    const values: ForecastData = {
      cohort: { id: c.cohort_id, name: meta.name, kind: c.kind, n: c.n },
      horizon: h,
      expected: roundToStep(cause === "other" && hz.other ? hz.other.expected : hz.expected, rounding.step),
      step: rounding.step,
      i80: roundInterval(cause === "other" && hz.other ? hz.other.i80 : hz.i80),
      i95: roundInterval(cause === "other" && hz.other ? hz.other.i95 : hz.i95),
      annual_rate: Math.round(((roundToStep(hz.expected, rounding.step) / c.n) * (12 / h)) * 1000) / 1000,
      hist: { expected: roundToStep(hz.hist.expected, rounding.step), annual_rate: hz.hist.annual_rate, i80: roundInterval(hz.hist.i80) },
      variance: hz.variance,
      curve: c.curve.map((p) => {
        const { other, ...rest } = p;
        return { ...rest, vol: roundToStep(p.vol, rounding.step), ...(showOther && other !== undefined ? { other: roundToStep(other, rounding.step) } : {}) };
      }),
      other: showOther && hz.other ? { expected: roundToStep(hz.other.expected, rounding.step), i80: roundInterval(hz.other.i80), i95: roundInterval(hz.other.i95), label: "Other exits (modeled as competing events; not a forecast of decisions)" } : null,
      cutoff: fx.run.cutoff,
      vintage: fx.run.vintage,
      run_id: fx.run.run_id,
      run_status: fx.run.status,
      metric_def: fx.run.metric_def,
    };
    return finish(ctx, "forecast_departures", { ...args, cohort: c.cohort_id, horizon_months: h, cause }, fx.run.run_key, fx.run.result_hash, {
      computed_by: "warehouse",
      provenance: { run_id: fx.run.run_id, catalog_entry: "sem_forecast_cohort.by_cohort", metric_def: fx.run.metric_def, vintage: fx.run.vintage, cutoff: fx.run.cutoff, computed_by: "warehouse", tool: "forecast_departures", args: { cohort: c.cohort_id, horizon_months: h, cause } },
      suppressed_cells: 0,
      rounding,
      values,
    });
  },
  digest(r, alias) {
    const v = r.values;
    return {
      alias,
      tool: r.tool,
      label: "synthetic",
      cohort: v.cohort.name,
      n_band: r.rounding?.band,
      horizon_months: v.horizon,
      run_id: v.run_id,
      run_status: v.run_status,
      cutoff: v.cutoff,
      expected: v.expected,
      i80: v.i80,
      i95: v.i95,
      hist_expected: v.hist.expected,
      cite: [`{{${alias}.expected|1dp}}`, `{{${alias}.i80|range}}`, `{{${alias}.i95|range}}`, `{{${alias}.hist.expected|1dp}}`, `{{${alias}.annual_rate|pct}}`],
    };
  },
};

const BY_KIND: Record<string, string> = { group: "group", team: "team", level_band: "org_level", tenure_band: "org_tenure" };

const forecastBreakdown: ToolDef<typeof toolInputs.forecast_breakdown, BreakdownData> = {
  name: "forecast_breakdown",
  description: toolDescriptions.forecast_breakdown,
  input: toolInputs.forecast_breakdown,
  scopes: ["forecast:read:*"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const fx = await loadRun(ctx, undefined);
    if (isRefusal(fx)) return fx;
    const parent = resolveCohort(args.cohort, fx.cohorts);
    if (!parent) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    const pmeta = cohortMeta(parent, fx.cohorts);
    const denied = authorizeCohort(ctx.principal, "forecast_breakdown", pmeta);
    if (denied) return denied;
    const kind = BY_KIND[args.by];
    if (!kind) return refuse("NOT_PERMITTED", "That breakdown is not published.");
    if (kind === "team" && !hasScope(ctx.principal, "forecast:read:team")) return refuse("NOT_PERMITTED", "Team-level values are available to People Analysts only.");
    if ((kind === "org_level" || kind === "org_tenure") && parent.kind !== "organization") return refuse("NOT_PERMITTED", "Level and tenure bands are published within an organization.");
    const h = horizonOf(args);
    const childOf = (c: CohortForecast): boolean => {
      if (c.kind !== kind) return false;
      if (parent.kind === "company") return kind === "group";
      if (kind === "org_level" || kind === "org_tenure") return c.parent === parent.cohort_id;
      if (kind === "group") return c.parent === parent.cohort_id;
      // teams of a group, or of every group in an organization
      if (c.parent === parent.cohort_id) return true;
      const g = fx.cohorts.find((x) => x.cohort_id === c.parent);
      return Boolean(g && g.parent === parent.cohort_id);
    };
    const children = fx.cohorts.filter(childOf).sort((a, b) => a.name.localeCompare(b.name));
    const partnerView = !hasScope(ctx.principal, "forecast:read:all") && hasScope(ctx.principal, "forecast:read:assigned");
    const partitionN = parent.kind === "company" && kind === "group" ? parent.n : parent.n;
    const { suppressed } = hiddenSumSuppress(partitionN, children.map((c) => ({ key: c.cohort_id, n: c.n })));
    const rows: BreakdownRow[] = children.map((c) => {
      const hz = c.horizons[String(h)]!;
      const step = roundingFor(c.n).step;
      const hide = suppressed.has(c.cohort_id) || (partnerView && c.n < MIN_COMPARISON);
      return {
        cohort_id: c.cohort_id,
        cohort: c.kind === "org_level" || c.kind === "org_tenure" ? c.name.split(" / ")[1] ?? c.name : c.name,
        n: c.n,
        expected: hide ? null : roundToStep(hz.expected, step),
        i80: hide ? null : roundInterval(hz.i80),
        rate: hide ? null : Math.round((roundToStep(hz.expected, step) / c.n) * (12 / h) * 1000) / 1000,
        suppressed: hide,
      };
    });
    const values: BreakdownData = {
      parent: { id: parent.cohort_id, name: pmeta.name },
      by: args.by,
      horizon: h,
      rows,
      note: kind === "team" ? "Team-level values are for planning; not an evaluation of the team's manager." : null,
    };
    return finish(ctx, "forecast_breakdown", { cohort: parent.cohort_id, by: args.by, horizon_months: h }, fx.run.run_key, fx.run.result_hash, {
      computed_by: "warehouse",
      provenance: { run_id: fx.run.run_id, catalog_entry: `sem_forecast_cohort.breakdown_${args.by}`, metric_def: fx.run.metric_def, vintage: fx.run.vintage, cutoff: fx.run.cutoff, computed_by: "warehouse", tool: "forecast_breakdown", args: { cohort: parent.cohort_id, by: args.by, horizon_months: h } },
      suppressed_cells: rows.filter((r) => r.suppressed).length,
      rounding: null,
      values,
    });
  },
  digest(r, alias) {
    return {
      alias,
      tool: r.tool,
      label: "synthetic",
      parent: r.values.parent.name,
      by: r.values.by,
      horizon_months: r.values.horizon,
      rows: r.values.rows.length,
      suppressed: r.values.rows.filter((x) => x.suppressed).length,
      cite: [`{{${alias}.rows.0.expected|1dp}}`, `{{${alias}.rows.0.cohort}}`],
      note: "Rows are sorted by name and are never a ranking.",
    };
  },
};

export interface HistoryData {
  cohort: { id: string; name: string; n: number };
  horizon: Horizon;
  points: ForecastHistoryPoint[];
  note: string;
  definition_change: string;
  coverage80: { held: number; windows: number } | null;
}

type ForecastHistoryPoint = import("../contracts").HistoryPoint;

const forecastHistory: ToolDef<typeof toolInputs.forecast_history, HistoryData> = {
  name: "forecast_history",
  description: toolDescriptions.forecast_history,
  input: toolInputs.forecast_history,
  scopes: ["forecast:read:*"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const fx = await loadRun(ctx, undefined);
    if (isRefusal(fx)) return fx;
    const c = resolveCohort(args.cohort, fx.cohorts);
    if (!c) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    const meta = cohortMeta(c, fx.cohorts);
    const denied = authorizeCohort(ctx.principal, "forecast_history", meta);
    if (denied) return denied;
    const h = horizonOf(args);
    const hist = await ctx.warehouse.history();
    const pts = hist?.series[c.cohort_id]?.[String(h)] ?? [];
    const mature = pts.filter((p) => p.actual_status === "mature" && p.actual !== null && !p.omitted_reason);
    const held = mature.filter((p) => p.actual! >= p.i80[0] && p.actual! <= p.i80[1]).length;
    const values: HistoryData = {
      cohort: { id: c.cohort_id, name: meta.name, n: c.n },
      horizon: h,
      points: pts,
      note: hist?.note ?? "",
      definition_change: hist?.definition_change ?? "",
      coverage80: mature.length ? { held, windows: mature.length } : null,
    };
    return finish(ctx, "forecast_history", { cohort: c.cohort_id, horizon_months: h }, fx.run.run_key, `history:${fx.run.result_hash}`, {
      computed_by: "warehouse",
      provenance: { catalog_entry: "sem_backtest.quarterly", metric_def: fx.run.metric_def, computed_by: "warehouse", tool: "forecast_history", args: { cohort: c.cohort_id, horizon_months: h } },
      suppressed_cells: pts.filter((p) => p.omitted_reason).length,
      rounding: roundingFor(c.n),
      values,
    });
  },
  digest(r, alias) {
    const v = r.values;
    return { alias, tool: r.tool, label: "synthetic", cohort: v.cohort.name, horizon_months: v.horizon, windows: v.points.length, coverage80: v.coverage80, cite: [`{{${alias}.coverage80.held}}`, `{{${alias}.coverage80.windows}}`], note: v.note };
  },
};

export interface ChangeData {
  cohort: { id: string; name: string; n: number };
  horizon: Horizon;
  from: string;
  to: string;
  from_value: number;
  to_value: number;
  delta: number;
  interval80_width: number;
  factors: import("../contracts").FactorBar[];
  evaluations: { key: string; value: number }[];
  step: number;
  largest: string;
}

const explainChange: ToolDef<typeof toolInputs.explain_change, ChangeData> = {
  name: "explain_change",
  description: toolDescriptions.explain_change,
  input: toolInputs.explain_change,
  scopes: ["forecast:read:*"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const index = await ctx.warehouse.runs();
    const published = index.runs.filter((r) => r.status === "published" || r.status === "superseded").sort((a, b) => a.cutoff.localeCompare(b.cutoff) || a.version - b.version);
    const to = args.to_run ?? (await publishedRun(ctx));
    const prior = published.filter((r) => r.run_id !== to && r.cutoff < (index.runs.find((x) => x.run_id === to)?.cutoff ?? "9999"));
    const from = args.from_run ?? prior[prior.length - 1]?.run_id;
    if (!from) return refuse("OUT_OF_SCOPE", "There is no earlier run to compare with.");
    const fxTo = await ctx.warehouse.forecast(to);
    const fxFrom = await ctx.warehouse.forecast(from);
    const ch = await ctx.warehouse.changes(from, to);
    if (!fxTo || !fxFrom || !ch) return refuse("OUT_OF_SCOPE", `No decomposition is published for ${from} to ${to}.`);
    const c = resolveCohort(args.cohort, fxTo.cohorts);
    if (!c) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    const meta = cohortMeta(c, fxTo.cohorts);
    const denied = authorizeCohort(ctx.principal, "explain_change", meta);
    if (denied) return denied;
    const prev = fxFrom.cohorts.find((x) => x.cohort_id === c.cohort_id);
    if (!prev || prev.n < MIN_COMPARISON) return refuse("SMALL_COHORT", "Comparisons over time need a cohort of 50 or more in both runs.");
    const h = horizonOf(args);
    const entry = ch.entries.find((e) => e.cohort_id === c.cohort_id && e.horizon === h);
    if (!entry) return refuse("OUT_OF_SCOPE", "No decomposition is published for that cohort and horizon.");
    const largest = [...entry.factors].sort((a, b) => Math.abs(b.phi) - Math.abs(a.phi))[0]?.label ?? "";
    const values: ChangeData = { cohort: { id: c.cohort_id, name: meta.name, n: c.n }, horizon: h, from, to, from_value: entry.from_value, to_value: entry.to_value, delta: entry.delta, interval80_width: entry.interval80_width, factors: entry.factors, evaluations: entry.evaluations, step: entry.step, largest };
    void comparisonServable;
    return finish(ctx, "explain_change", { cohort: c.cohort_id, horizon_months: h, from_run: from, to_run: to }, fxTo.run.run_key, `${fxFrom.run.result_hash}:${fxTo.run.result_hash}`, {
      computed_by: "engine",
      provenance: { run_id: to, catalog_entry: "changes.shapley_5f", metric_def: fxTo.run.metric_def, computed_by: "engine", tool: "explain_change", args: { cohort: c.cohort_id, horizon_months: h, from_run: from, to_run: to } },
      suppressed_cells: entry.factors.filter((f) => f.merged_from.length > 1).length,
      rounding: roundingFor(c.n),
      values,
    });
  },
  digest(r, alias) {
    const v = r.values;
    const factors: Record<string, number> = {};
    v.factors.forEach((f) => {
      factors[f.factor] = f.phi;
    });
    return {
      alias,
      tool: r.tool,
      label: "synthetic",
      cohort: v.cohort.name,
      horizon_months: v.horizon,
      from_run: v.from,
      to_run: v.to,
      delta: v.delta,
      interval80_width: v.interval80_width,
      factors,
      largest_factor: v.largest,
      cite: [`{{${alias}.delta|1dp}}`, `{{${alias}.from_value|1dp}}`, `{{${alias}.to_value|1dp}}`, `{{${alias}.interval80_width|1dp}}`, ...v.factors.map((_, i) => `{{${alias}.factors.${i}.phi|1dp}} (${v.factors[i]!.label})`)],
    };
  },
};

export interface QualityData {
  source: string;
  latest: { check_id: string; name: string; status: string; severity: string; date: string; failing_rows: number; node: string }[];
  failing: string[];
  warnings: string[];
  passing: number;
  checks: number;
}

const dataQualityStatus: ToolDef<typeof toolInputs.data_quality_status, QualityData> = {
  name: "data_quality_status",
  description: toolDescriptions.data_quality_status,
  input: toolInputs.data_quality_status,
  scopes: ["quality:read"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const q = await ctx.warehouse.quality();
    if (!q) return refuse("OUT_OF_SCOPE", "No check results are published yet.");
    const source = args.source ?? "all";
    const defs = q.checks.filter((c) => source === "all" || c.source === source);
    const latest = defs.map((d) => {
      const rs = q.results.filter((r) => r.check_id === d.check_id && (!args.since || r.date >= args.since)).sort((a, b) => a.date.localeCompare(b.date));
      const last = rs[rs.length - 1];
      return { check_id: d.check_id, name: d.name, status: last?.status ?? "pass", severity: d.severity, date: last?.date ?? "", failing_rows: last?.failing_rows ?? 0, node: d.node };
    });
    const values: QualityData = { source, latest, failing: latest.filter((l) => l.status === "fail").map((l) => l.check_id), warnings: latest.filter((l) => l.status === "warn").map((l) => l.check_id), passing: latest.filter((l) => l.status === "pass").length, checks: latest.length };
    const version = q.results.length ? q.results.map((r) => `${r.check_id}${r.date}${r.status}`).join("|").length.toString() : "0";
    return finish(ctx, "data_quality_status", { source, since: args.since }, "quality", `${version}:${q.results[q.results.length - 1]?.date ?? ""}`, {
      computed_by: "warehouse",
      provenance: { catalog_entry: "rpt_check_results.latest", computed_by: "warehouse", tool: "data_quality_status", args: { source, since: args.since } },
      suppressed_cells: 0,
      rounding: null,
      values,
    });
  },
  digest(r, alias) {
    const v = r.values;
    return { alias, tool: r.tool, label: "synthetic", source: v.source, failing: v.failing, warnings: v.warnings, passing: v.passing, checks: v.checks, cite: [`{{${alias}.passing}}`, `{{${alias}.checks}}`] };
  },
};

export interface LineageData {
  target: string;
  path: string[];
  ranking: { node: string; score: number; parts: Record<string, number> }[];
  nodes: LineageFixture["nodes"];
  edges: LineageFixture["edges"];
}

const traceLineage: ToolDef<typeof toolInputs.trace_lineage, LineageData> = {
  name: "trace_lineage",
  description: toolDescriptions.trace_lineage,
  input: toolInputs.trace_lineage,
  scopes: ["lineage:read"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const lin = await ctx.warehouse.lineage();
    if (!lin) return refuse("OUT_OF_SCOPE", "No lineage is published yet.");
    const key = args.check_id ?? args.node ?? Object.keys(lin.failing)[0] ?? "";
    const hit = lin.failing[key] ?? Object.entries(lin.failing).find(([, f]) => f.path.includes(key))?.[1] ?? null;
    const values: LineageData = { target: key, path: hit?.path ?? [], ranking: hit?.ranking ?? [], nodes: lin.nodes, edges: lin.edges };
    return finish(ctx, "trace_lineage", { target: key }, "lineage", String(lin.nodes.length + lin.edges.length), {
      computed_by: "workspace",
      provenance: { lineage_nodes: values.path, computed_by: "workspace", tool: "trace_lineage", args: { target: key } },
      suppressed_cells: 0,
      rounding: null,
      values,
    });
  },
  digest(r, alias) {
    return { alias, tool: r.tool, label: "synthetic", target: r.values.target, path: r.values.path, top_ranked: r.values.ranking.slice(0, 3).map((x) => x.node) };
  },
};

const cohortProfile: ToolDef<typeof toolInputs.cohort_profile, CohortProfile & { name: string }> = {
  name: "cohort_profile",
  description: toolDescriptions.cohort_profile,
  input: toolInputs.cohort_profile,
  scopes: ["forecast:read:*"],
  kind: "read",
  available: true,
  async run(ctx, args) {
    const fx = await loadRun(ctx, undefined);
    if (isRefusal(fx)) return fx;
    const c = resolveCohort(args.cohort, fx.cohorts);
    if (!c) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    const meta = cohortMeta(c, fx.cohorts);
    const denied = authorizeCohort(ctx.principal, "cohort_profile", meta);
    if (denied) return denied;
    const pf = await ctx.warehouse.profiles(fx.run.run_id);
    const p = pf?.profiles.find((x) => x.cohort_id === c.cohort_id);
    if (!p) return refuse("OUT_OF_SCOPE", "No profile is published for that cohort.");
    return finish(ctx, "cohort_profile", { cohort: c.cohort_id }, fx.run.run_key, `profile:${fx.run.result_hash}`, {
      computed_by: "warehouse",
      provenance: { run_id: fx.run.run_id, catalog_entry: "sem_cohort_profile.by_cohort", computed_by: "warehouse", tool: "cohort_profile", args: { cohort: c.cohort_id } },
      suppressed_cells: 0,
      rounding: roundingFor(c.n),
      values: { ...p, name: meta.name },
    });
  },
  digest(r, alias) {
    const v = r.values;
    return {
      alias,
      tool: r.tool,
      label: "synthetic",
      cohort: v.name,
      share_below_midpoint: v.share_below_midpoint,
      median_months_since_promotion: v.median_months_since_promotion,
      promotion_rate_12m: v.promotion_rate_12m,
      open_backfill_reqs: v.open_backfill_reqs,
      company: v.company,
      cite: [`{{${alias}.share_below_midpoint|pct}}`, `{{${alias}.median_months_since_promotion|int}}`, `{{${alias}.promotion_rate_12m|pct}}`, `{{${alias}.open_backfill_reqs|int}}`],
    };
  },
};

const prepareReview: ToolDef<typeof toolInputs.prepare_review, ReviewDraft> = {
  name: "prepare_review",
  description: toolDescriptions.prepare_review,
  input: toolInputs.prepare_review,
  scopes: ["review:propose*"],
  kind: "draft",
  available: true,
  async run(ctx, args) {
    const fx = await loadRun(ctx, undefined);
    if (isRefusal(fx)) return fx;
    const c = resolveCohort(args.cohort, fx.cohorts);
    if (!c) return refuse("OUT_OF_SCOPE", `No published cohort matches "${args.cohort}".`);
    if (c.kind !== "group" && c.kind !== "organization" && c.kind !== "company") return refuse("NOT_PERMITTED", "Reviews are prepared for groups and above.");
    const meta = cohortMeta(c, fx.cohorts);
    const denied = authorizeCohort(ctx.principal, "prepare_review", meta);
    if (denied) return denied;
    const h = horizonOf(args);
    const forecast = await forecastDepartures.run(ctx, { cohort: c.cohort_id, horizon_months: h });
    const profile = await cohortProfile.run(ctx, { cohort: c.cohort_id });
    if (isRefusal(forecast)) return forecast;
    if (isRefusal(profile)) return profile;
    const f = forecast.values;
    const p = profile.values;
    const coverage = f.expected > 0 ? Math.round(((p.open_backfill_reqs + p.pending_backfill_offers) / f.expected) * 100) / 100 : 0;
    const draft: ReviewDraft = {
      draft_id: "",
      cohort_id: c.cohort_id,
      cohort: meta.name,
      horizon: h,
      run_id: fx.run.run_id,
      label: "synthetic",
      checks: [
        {
          category: "compensation",
          title: "Compensation position against band midpoints",
          question: `Is pay position in ${meta.name} contributing to departures? Compare the share paid below band midpoint with the company and review band placement as a group.`,
          evidence: [profile.result_id, forecast.result_id],
          facts: { share_below_midpoint: p.share_below_midpoint, company_share_below_midpoint: p.company.share_below_midpoint },
        },
        {
          category: "career",
          title: "Career progression",
          question: `Is time since promotion in ${meta.name} longer than elsewhere? Examine promotion criteria and cycle timing as a group.`,
          evidence: [profile.result_id],
          facts: { median_months_since_promotion: p.median_months_since_promotion, company_median_months_since_promotion: p.company.median_months_since_promotion, promotion_rate_12m: p.promotion_rate_12m },
        },
        {
          category: "hiring",
          title: "Hiring coverage",
          question: `Do open backfill requisitions cover the expected voluntary departures over ${h} months?`,
          evidence: [forecast.result_id, profile.result_id],
          facts: { open_backfill_reqs: p.open_backfill_reqs, pending_backfill_offers: p.pending_backfill_offers, expected_voluntary: f.expected, backfill_coverage_ratio: coverage, open_growth_reqs: p.open_growth_reqs },
        },
      ],
      blocking_items: ["Pay-equity check by Compensation before any cohort pay change"],
      lab_evidence: false,
    };
    const id = await resultId(ctx, "prepare_review", { cohort: c.cohort_id, horizon_months: h }, fx.run.run_key, `${forecast.result_id}:${profile.result_id}`);
    draft.draft_id = `drf_${id.slice(4, 20)}`;
    if (ctx.workspace?.saveDraft) await ctx.workspace.saveDraft(draft, ctx.principal.id);
    return finish(ctx, "prepare_review", { cohort: c.cohort_id, horizon_months: h }, fx.run.run_key, `${forecast.result_id}:${profile.result_id}`, {
      computed_by: "workspace",
      provenance: { run_id: fx.run.run_id, computed_by: "workspace", tool: "prepare_review", args: { cohort: c.cohort_id, horizon_months: h } },
      suppressed_cells: 0,
      rounding: roundingFor(c.n),
      values: draft,
    });
  },
  digest(r, alias) {
    const v = r.values;
    return { alias, tool: r.tool, label: "synthetic", draft_id: v.draft_id, cohort: v.cohort, horizon_months: v.horizon, checks: v.checks.map((c) => c.title), blocking_items: v.blocking_items, note: "A draft: a human submits it and a different human approves it." };
  },
};

export const TOOLS: ToolDef[] = [forecastDepartures, forecastBreakdown, forecastHistory, explainChange, dataQualityStatus, traceLineage, cohortProfile, prepareReview] as unknown as ToolDef[];

export function toolsFor(p: Principal): ToolDef[] {
  return TOOLS.filter((t) => t.available && canUseTool(p, t));
}

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Runs a tool by name with validated arguments: the single entry point for agents, MCP, API and evals. */
export async function runTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult<unknown> | Refusal> {
  const tool = getTool(name);
  if (!tool || !tool.available) return refuse("OUT_OF_SCOPE", `Unknown tool ${name}.`);
  if (!canUseTool(ctx.principal, tool)) return refuse("NOT_PERMITTED");
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) return refuse("OUT_OF_SCOPE", `Invalid arguments: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  return tool.run(ctx, parsed.data);
}

export { cohortName };
