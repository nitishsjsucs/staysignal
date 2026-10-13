// Model providers chosen by SS_LLM (SPEC 14.2): stub (scripted rules; CI), recorded (replays a recorded 27B turn's text
// and tool calls while the tools execute live; the demo default), llama (Qwen3-1.7B on 8187), mlx (Qwen3.6-27B on
// 8186; the model ID is always default_model so mlx_lm.server never loads another model).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { AliasMap } from "../../shared/grounding/aliases";
import { templateAnswer } from "../../shared/grounding/template";
import type { RecordedTurn } from "./recorded-provider";

export type ProviderName = "stub" | "recorded" | "llama" | "mlx" | "workers-ai";

function usage(input: number, output: number) {
  return { inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: output, text: output, reasoning: 0 } };
}

function result(content: LanguageModelV4Content[], finish: "stop" | "tool-calls"): LanguageModelV4GenerateResult {
  return { content, finishReason: { unified: finish, raw: finish }, usage: usage(0, 0), warnings: [] } as unknown as LanguageModelV4GenerateResult;
}

const COHORT_WORDS = [
  "Platform Engineering", "Product Engineering", "Security Engineering", "Infrastructure", "Engineering", "Product & Design", "Product Management", "Design",
  "Enterprise Sales", "Commercial Sales", "Sales Development", "Solutions Engineering", "Sales", "Customer Success & Support", "Customer Success", "Technical Support",
  "Marketing", "Finance", "People", "Legal", "IT & Operations", "Data",
];

export function stubPlan(question: string): { tool: string; args: Record<string, unknown> } | null {
  const q = question.toLowerCase();
  const cohort = COHORT_WORDS.find((c) => q.includes(c.toLowerCase())) ?? (/\b(company|larkspur|everyone|overall)\b/.test(q) ? "Larkspur" : "Larkspur");
  const days = /(\d+)\s*days?/.exec(q);
  const months = /(\d+)\s*months?/.exec(q);
  const horizon: Record<string, number> = days ? { horizon_days: Number(days[1]) } : months ? { horizon_months: Number(months[1]) } : { horizon_months: 3 };
  if (/\b(what did we decide|did we decide|last time|remember|memory|decided)\b/.test(q)) return { tool: "search_memory", args: { query: question } };
  if (/\b(what changed|change since|why .*(differ|change)|compared with the previous|previous forecast)\b/.test(q)) return { tool: "explain_change", args: { cohort, ...horizon } };
  if (/\b(prepare|draft)\b.*\breview\b/.test(q)) return { tool: "prepare_review", args: { cohort, ...horizon } };
  if (/\b(hires|hired|joiners|joined|transfers?|transferred|flows?|headcount|moved (in|out))\b/.test(q) && !/\b(value|column|check)\b/.test(q)) {
    const window = /\b(\d{4}-\d{2})\b.*\b(\d{4}-\d{2})\b/.exec(q);
    return { tool: "workforce_flows", args: { cohort, ...(window ? { from: window[1], to: window[2] } : {}) } };
  }
  if (/\b(where did|trace|lineage|come from|root cause)\b/.test(q)) return { tool: "trace_lineage", args: {} };
  if (/\b(check|checks|quality|failed|failing|fresh)\b/.test(q)) return { tool: "data_quality_status", args: { source: /payroll/.test(q) ? "payroll" : "all" } };
  if (/\b(coverage|calibrat\w*|accuracy|skill)\b/.test(q)) {
    const level = /\borgani[sz]ations?\b/.test(q) ? "organization" : "company";
    return { tool: "backtest_summary", args: { level, ...horizon } };
  }
  if (/\b(backtest|history|track record|how accurate|past forecasts)\b/.test(q)) return { tool: "forecast_history", args: { cohort, ...horizon } };
  if (/\b(by group|breakdown|break down|by team|by level|by tenure)\b/.test(q)) {
    const by = /team/.test(q) ? "team" : /level/.test(q) ? "level_band" : /tenure/.test(q) ? "tenure_band" : "group";
    return { tool: "forecast_breakdown", args: { cohort, by, ...horizon } };
  }
  if (/\b(profile|below (the )?midpoint|promotion|requisitions?|backfill)\b/.test(q)) return { tool: "cohort_profile", args: { cohort } };
  if (/\b(forecast|expect|how many|departures|attrition|leave|quit|turnover)\b/.test(q)) return { tool: "forecast_departures", args: { cohort, ...horizon } };
  return null;
}

function lastUserText(opts: LanguageModelV4CallOptions): string {
  for (let i = opts.prompt.length - 1; i >= 0; i--) {
    const m = opts.prompt[i]!;
    if (m.role === "user") return m.content.map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }
  return "";
}

function toolResultsSinceUser(opts: LanguageModelV4CallOptions): number {
  let n = 0;
  for (let i = opts.prompt.length - 1; i >= 0; i--) {
    const m = opts.prompt[i]!;
    if (m.role === "user") break;
    if (m.role === "tool") n++;
  }
  return n;
}

/** The deterministic stub: one tool call chosen by rules, then the template answer over this turn's results. */
export function stubModel(aliases: AliasMap): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "staysignal",
    modelId: "stub",
    doGenerate: async (opts) => {
      if (toolResultsSinceUser(opts) > 0) {
        const text = templateAnswer([...aliases.values()].map((a) => ({ alias: a.alias, tool: a.tool, values: a.values })));
        return result([{ type: "text", text }], "stop");
      }
      const plan = stubPlan(lastUserText(opts));
      if (!plan) return result([{ type: "text", text: "I can answer cohort-level questions about Larkspur's forecast, what changed, data quality and reviews. Try asking for a forecast of an organization over 90 days." }], "stop");
      return result([{ type: "tool-call", toolCallId: "call_1", toolName: plan.tool, input: JSON.stringify(plan.args) }], "tool-calls");
    },
  });
}

/** Replays a recorded turn's model steps in order (tool calls, then text); tools still execute live. */
export function recordedModel(turn: RecordedTurn): LanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    provider: "recorded",
    modelId: turn.model,
    doGenerate: async () => {
      const step = turn.steps[Math.min(i, turn.steps.length - 1)]!;
      i++;
      if (step.tool_calls?.length) {
        return result(step.tool_calls.map((c, k) => ({ type: "tool-call" as const, toolCallId: `rec_${i}_${k}`, toolName: c.tool, input: JSON.stringify(c.args) })), "tool-calls");
      }
      return result([{ type: "text", text: step.text ?? "" }], "stop");
    },
  });
}

/** Every token of the Qwen3.6-27B tokenizer (mlx-community/Qwen3.6-27B-4bit, snapshot c000ac2c) whose text holds an
 * en or em dash: the Lab recorder's list (sim/src/staysignal_sim/client.py). The public hygiene tier rejects those
 * characters in committed text and a recorded turn is never hand-edited, so the mlx provider bans them at sampling
 * time with a logit bias of -100. */
export const NO_DASH_TOKEN_IDS: readonly number[] = [
  1317, 1892, 2218, 4006, 8283, 15744, 16312, 21010, 27090, 28630, 32963, 36203, 38697, 42064, 46812, 47267, 47853,
  48944, 48952, 50649, 52510, 57541, 58180, 60537, 60723, 62804, 65467, 67728, 67999, 68801, 72418, 73238, 76273,
  78015, 79916, 80950, 81357, 82280, 82957, 83173, 83581, 84830, 86674, 89534, 91814, 92933, 95060, 177177, 180201,
  184142, 197005, 200228, 211741, 216119, 216120, 230118, 236392, 242602,
];

/** The request body the mlx provider sends: the SDK's body plus the dash ban (mlx_lm.server 0.32.0 takes string keys). */
export function withDashBan(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, logit_bias: Object.fromEntries(NO_DASH_TOKEN_IDS.map((id) => [String(id), -100])) };
}

export function openAiCompatible(name: "llama" | "mlx", baseURL: string, fetchFn?: typeof fetch): LanguageModel {
  const provider = createOpenAICompatible({ name, baseURL, includeUsage: true, ...(fetchFn ? { fetch: fetchFn } : {}), ...(name === "mlx" ? { transformRequestBody: withDashBan } : {}) });
  return provider(name === "mlx" ? "default_model" : "qwen3-1.7b");
}

export const LOCAL_URLS = { llama: "http://127.0.0.1:8187/v1", mlx: "http://127.0.0.1:8186/v1" } as const;
