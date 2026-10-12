// Deterministic answers rendered from tool results (SPEC 14.4): the stub provider's text, and the fallback when a
// model's narration fails grounding twice. Pattern from DataTrust packages/rca/src/summary/template.ts (MIT).
// Templates write placeholders like the model does, so the same renderer and links apply.
import { REFUSAL_MESSAGES, type RefusalCode } from "../policy/refusals";

export interface TemplateInput {
  alias: string;
  tool: string;
  values: unknown;
}

type V = Record<string, unknown>;

function forecastText(a: string, v: V): string {
  const c = v.cohort as V;
  const h = v.horizon as number;
  const status = v.run_status === "held" ? " This run is held for review and is not published." : "";
  return `For ${String(c.name)} (synthetic data, cutoff ${String(v.cutoff)}), StaySignal expects {{${a}.expected}} voluntary departures over the next ${h} months, with an 80% range of {{${a}.i80|range}} and a 95% range of {{${a}.i95|range}}. The trailing-rate status quo would say {{${a}.hist.expected}}.${status}`;
}

function changeText(a: string, v: V): string {
  const c = v.cohort as V;
  const factors = (v.factors as V[]) ?? [];
  const order = factors.map((f, i) => ({ i, label: String(f.label), abs: Math.abs(Number(f.phi)) })).sort((x, y) => y.abs - x.abs);
  const top = order[0];
  const parts = factors.map((f, i) => `${String(f.label)} {{${a}.factors.${i}.phi|1dp}}`).join(", ");
  const lead = top ? ` The largest contribution is ${top.label}.` : "";
  return `Between ${String(v.from)} and ${String(v.to)}, expected voluntary departures for ${String(c.name)} over ${String(v.horizon)} months moved from {{${a}.from_value}} to {{${a}.to_value}}, a change of {{${a}.delta|1dp}} against an 80% interval about {{${a}.interval80_width|1dp}} wide. By factor: ${parts}.${lead}`;
}

function qualityText(a: string, v: V): string {
  const failing = (v.failing as string[]) ?? [];
  const warnings = (v.warnings as string[]) ?? [];
  if (!failing.length && !warnings.length) return `All {{${a}.checks}} checks on ${String(v.source)} sources pass (synthetic data).`;
  return `Failing checks: ${failing.join(", ") || "none"}. Warnings: ${warnings.join(", ") || "none"}. {{${a}.passing}} of {{${a}.checks}} checks pass.`;
}

function lineageText(_a: string, v: V): string {
  const path = (v.path as string[]) ?? [];
  const top = ((v.ranking as V[]) ?? [])[0];
  return `${String(v.target)} traces through ${path.join(" > ") || "no recorded path"}.${top ? ` The top-ranked root cause is ${String(top.node)}.` : ""}`;
}

function breakdownText(a: string, v: V): string {
  const p = v.parent as V;
  const rows = (v.rows as V[]) ?? [];
  return `The breakdown of ${String(p.name)} by ${String(v.by).replace("_", " ")} over ${String(v.horizon)} months has ${rows.length} rows, sorted by name (not a ranking)${rows.some((r) => r.suppressed) ? "; some rows are suppressed to protect small groups" : ""}. The first is ${String(rows[0]?.cohort ?? "none")} with {{${a}.rows.0.expected}}.`;
}

function historyText(a: string, v: V): string {
  const c = v.cohort as V;
  const cov = v.coverage80 as V | null;
  return cov
    ? `In quarterly pseudo-real-time backtests for ${String(c.name)} (model and data as known at each cutoff, synthetic world), the 80% range held {{${a}.coverage80.held}} of {{${a}.coverage80.windows}} mature windows.`
    : `No mature backtest windows are available for ${String(c.name)} yet.`;
}

function backtestText(a: string, v: V): string {
  const lead = v.model === "dtcr-mnl" ? "The forecast model's" : `The ${String(v.model)} baseline's`;
  const eff = v.effective_windows !== null && v.effective_windows !== undefined ? ` (about {{${a}.effective_windows|int}} independent windows)` : "";
  return `${lead} ${String(v.horizon)}-month backtest at ${String(v.level)} level, over ${String(v.basis)}: the 80% range held {{${a}.coverage80|pct}} of the time${eff}, the 95% range {{${a}.coverage95|pct}}, and observed over expected was {{${a}.observed_over_expected}}. Synthetic world, model and data as known at each cutoff.`;
}

function profileText(a: string, v: V): string {
  return `In ${String(v.name)}, {{${a}.share_below_midpoint|pct}} are paid below their band midpoint, the median time since promotion is {{${a}.median_months_since_promotion|int}} months, and {{${a}.open_backfill_reqs|int}} backfill requisitions are open (synthetic data).`;
}

function flowsText(a: string, v: V): string {
  const c = v.cohort as V;
  const end = v.headcount_end === null ? "" : `, and {{${a}.headcount_end|int}} at the end`;
  const moves =
    v.joined !== null && v.left !== null
      ? ` Over the window {{${a}.joined|int}} people arrived (hires and moves in) and {{${a}.left|int}} left or moved out.`
      : " Some of its flows are too small to show and are withheld.";
  return `From {{${a}.from}} to {{${a}.to}}, ${String(c.name)} had {{${a}.headcount_start|int}} people at the start${end}.${moves} Small links are merged to protect individuals (synthetic data).`;
}

function memoryText(a: string, v: V): string {
  const hits = (v.hits as V[]) ?? [];
  if (!hits.length) return "I found nothing in StaySignal's memory about that.";
  const more = hits.length > 1 ? ` Other notes: ${hits.slice(1).map((_, i) => `{{${a}.hits.${i + 1}.path}}`).join(", ")}.` : "";
  return `From StaySignal's memory (synthetic records): {{${a}.hits.0.snippet}} (in {{${a}.hits.0.path}}).${more}`;
}

function reviewText(_a: string, v: V): string {
  const checks = (v.checks as V[]) ?? [];
  return `I drafted a People Partner review for ${String(v.cohort)} with three group-level checks: ${checks.map((c) => String(c.title).toLowerCase()).join("; ")}. It is a draft: you submit it, and a different lead approves it. Pay-equity review by Compensation is a blocking item before any cohort pay change.`;
}

const TEMPLATES: Record<string, (a: string, v: V) => string> = {
  forecast_departures: forecastText,
  explain_change: changeText,
  data_quality_status: qualityText,
  trace_lineage: lineageText,
  forecast_breakdown: breakdownText,
  forecast_history: historyText,
  backtest_summary: backtestText,
  cohort_profile: profileText,
  workforce_flows: flowsText,
  search_memory: memoryText,
  prepare_review: reviewText,
};

export function templateAnswer(results: readonly TemplateInput[]): string {
  if (results.length === 0) return "I could not find a tool result to answer that from. Try asking about a cohort's forecast, what changed, data quality or a review.";
  return results.map((r) => (TEMPLATES[r.tool] ?? (() => `Result ${r.alias} from ${r.tool} is attached.`))(r.alias, r.values as V)).join("\n\n");
}

export function refusalAnswer(code: RefusalCode): string {
  return REFUSAL_MESSAGES[code];
}
