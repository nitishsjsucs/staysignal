// Input schemas of the governed tools (SPEC 14.3). One registry feeds the agents, the MCP server and the eval
// harness; these zod schemas are its argument contracts. Every output is cohort-level; no tool takes or returns a
// person. Descriptions are written for the model: they say what the tool answers and what it never does.
import { z } from "zod";

export const HORIZONS = [1, 3, 6] as const;
export type HorizonMonths = (typeof HORIZONS)[number];

const cohort = z
  .string()
  .min(1)
  .max(80)
  .describe('Cohort name: "Larkspur" (whole company), an organization ("Engineering"), a group ("Platform Engineering") or, for analysts, a team. Never a person.');
const horizonMonths = z
  .number()
  .int()
  .optional()
  .describe("Forecast horizon in calendar months: 1, 3 or 6. A question in days resolves to the nearest (30, 90, 180 days).");
const horizonDays = z.number().int().optional().describe("Horizon in days, if the user gave days; resolved to 1, 3 or 6 months.");
const runId = z.string().regex(/^R-\d{4}-\d{2}-\d{2}#\d+$/).optional().describe("Forecast run id such as R-2026-10-01#1; default the published run.");

export const toolInputs = {
  forecast_departures: z.object({
    cohort,
    horizon_months: horizonMonths,
    horizon_days: horizonDays,
    cause: z.enum(["voluntary", "other"]).optional().describe("voluntary (default) or other exits (company and organization level only)."),
    run: runId,
  }),
  forecast_breakdown: z.object({
    cohort,
    by: z.enum(["group", "team", "job_family", "level_band", "tenure_band"]).describe("Dimension to break the cohort down by; rows are sorted by name, never ranked by risk."),
    horizon_months: horizonMonths,
    horizon_days: horizonDays,
  }),
  forecast_history: z.object({ cohort, horizon_months: horizonMonths, horizon_days: horizonDays }),
  explain_change: z.object({
    cohort,
    horizon_months: horizonMonths,
    horizon_days: horizonDays,
    from_run: runId.describe("Earlier run; default the previous published run."),
    to_run: runId.describe("Later run; default the current published run."),
  }),
  backtest_summary: z.object({
    level: z.enum(["company", "organization", "group"]).optional(),
    horizon_months: horizonMonths,
    horizon_days: horizonDays,
    model: z.enum(["dtcr-mnl", "hist", "aj", "oracle", "survivalboost", "survivalboost-shock", "dtcr-mnl-12k"]).optional(),
  }),
  data_quality_status: z.object({
    source: z.enum(["hris", "payroll", "ats", "all"]).optional(),
    since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  trace_lineage: z.object({
    check_id: z.string().regex(/^[A-Z]\d{2}$/).optional().describe("Check id such as C01."),
    node: z.string().max(120).optional().describe("Warehouse node or column, such as stg_payroll__lines.pay_basis_code."),
  }),
  cohort_profile: z.object({ cohort }),
  workforce_flows: z.object({
    cohort,
    from: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  }),
  prepare_review: z.object({ cohort: cohort.describe("Group level or above."), horizon_months: horizonMonths, horizon_days: horizonDays }),
  investigate: z.object({ run_id: runId, incident_id: z.string().regex(/^INC-[A-Za-z0-9-]+$/).optional() }),
  search_memory: z.object({ query: z.string().min(2).max(200) }),
  lab_runs: z.object({ proposal_id: z.string().max(80).optional() }),
} as const;

export type ToolName = keyof typeof toolInputs;
export const TOOL_NAMES = Object.keys(toolInputs) as ToolName[];

export const toolDescriptions: Record<ToolName, string> = {
  forecast_departures:
    "Expected voluntary departures for a cohort over 1, 3 or 6 months, with 80% and 95% ranges, the cumulative curve, the variance decomposition, the trailing-rate status quo, the data cutoff and the run. Cohort-level only.",
  forecast_breakdown: "Expected departures for the parts of a cohort (groups, job families, level or tenure bands; teams for analysts only), sorted by name. Never a ranking.",
  forecast_history: "Quarterly pseudo-real-time backtests for a cohort of 50 or more: what forecasts made the same way said and what happened.",
  explain_change: "Why a forecast differs from an earlier one: exact contributions of calendar, composition, input data, model and metric definition. Cohorts of 50 or more.",
  backtest_summary: "Backtest accuracy: count error, skill against the trailing rate, observed over expected and interval coverage with the effective number of windows.",
  data_quality_status: "Data-quality check results and open incidents for a source.",
  trace_lineage: "Lineage path from a failing check or warehouse column to the forecast, with the root-cause ranking.",
  cohort_profile: "Cohort facts: share paid below band midpoint, median months since promotion, 12-month promotion rate, open backfill and growth requisitions, backfill coverage.",
  workforce_flows: "Hires, transfers and exits by type for a cohort between two months (links under 10 people merged).",
  prepare_review: "Drafts a People Partner review for a group-level cohort: three checks with evidence. A draft only; a human submits it and another human approves it.",
  investigate: "Investigates a held run or an incident: data quality, model and workforce composition findings with evidence.",
  search_memory: "Searches StaySignal's memory of past decisions, investigations and timeline notes.",
  lab_runs: "Recorded Scenario Lab runs for a proposal (hypothesis generation with synthetic personas; not a forecast).",
};

/** Nearest supported horizon for a number of months or days (SPEC 6.1: a question in days resolves to the nearest). */
export function resolveHorizon(args: { horizon_months?: number | undefined; horizon_days?: number | undefined }): HorizonMonths {
  const months = args.horizon_months ?? (args.horizon_days !== undefined ? args.horizon_days / 30.4375 : 3);
  let best: HorizonMonths = 3;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const h of HORIZONS) {
    const d = Math.abs(h - months);
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}
