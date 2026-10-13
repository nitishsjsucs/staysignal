// One analyst turn (SPEC 4.3, 14.2 to 14.4): the deterministic pre-router, the model with governed tools (at most 6
// steps; the model sees digests under per-turn aliases), the numeric-grounding check with one repair, and the
// deterministic template fallback. The same function serves the chat dock, /api/dev/agent/turn and the evals.
import { generateText, isStepCount, type LanguageModel, type ModelMessage, type Tool } from "ai";
import type { AliasMap } from "../../shared/grounding/aliases";
import { renderPlaceholders } from "../../shared/grounding/aliases";
import { checkGrounding } from "../../shared/grounding/check";
import { templateAnswer } from "../../shared/grounding/template";
import { cohortGuard } from "../../shared/guard/cohort-guard";
import { preRoute } from "../../shared/guard/prerouter";
import { isRefusal, REFUSAL_MESSAGES, type RefusalCode } from "../../shared/policy/refusals";
import { getTool, publishedCohorts, runTool, type ToolContext, toolsFor } from "../../shared/tools/registry";
import { REPAIR_PROMPT, SYSTEM_PROMPT } from "./prompts";
import { findRecording, type RecordedStep } from "./recorded-provider";
import { openAiCompatible, type ProviderName, recordedModel, stubModel, LOCAL_URLS } from "./providers";
import { type AigMetadata, type BudgetPort, neuronsFor, stripThink, TURN_CEILING, type WorkersAiConfig, withNoThink, workersAiModel } from "./workers-ai";

export type Grounding = "passed" | "repaired" | "template" | "refused";

export interface Span {
  kind: "prerouter" | "model_call" | "tool_call" | "grounding" | "repair" | "template";
  name: string;
  start_ms: number;
  dur_ms: number;
  tokens?: { input: number | null; output: number | null; cached: number | null };
  outcome: string;
  result_ids?: string[];
}

export interface ToolCallRecord {
  alias: string | null;
  tool: string;
  args: Record<string, unknown>;
  result_id: string | null;
  refused: { code: RefusalCode; message: string } | null;
}

export interface TurnOutput {
  question: string;
  text: string; // with placeholders
  rendered: string;
  aliases: Record<string, string>;
  tool_calls: ToolCallRecord[];
  grounding: Grounding;
  refusal: { code: RefusalCode; message: string; layer: "prerouter" | "tool" | "budget" } | null;
  provider: ProviderName;
  recorded: boolean;
  label: string | null;
  violations: string[];
  spans: Span[];
  /** The model's own steps (tool calls with their arguments, then the accepted text), returned only when
   * TurnOptions.captureSteps is set: the demo-turn recorder writes them to demo/recordings (ADR 0010). */
  model_steps?: RecordedStep[];
}

/** What a production turn needs beyond the tools: the Workers AI settings, the neuron budget, and the gateway
 * metadata (ids only). Absent, a "workers-ai" turn falls back to the stub (local, CI). */
export interface TurnOptions {
  workersAi?: WorkersAiConfig | null;
  budget?: BudgetPort | null;
  meta?: AigMetadata;
  fetch?: typeof fetch;
  /** Return the model's steps with the turn (dev and localhost only, for npm run demo:record). */
  captureSteps?: boolean;
}

export interface TurnHooks {
  onToolCall?(call: { toolCallId: string; tool: string; args: Record<string, unknown> }): void;
  onToolResult?(call: { toolCallId: string; record: ToolCallRecord }): void;
}

function modelFor(provider: ProviderName, aliases: AliasMap, question: string, opts: TurnOptions = {}): { model: LanguageModel; recorded: boolean; label: string | null } {
  if (provider === "workers-ai" && opts.workersAi) return { model: workersAiModel(opts.workersAi, opts.meta ?? {}, opts.fetch), recorded: false, label: null };
  if (provider === "recorded") {
    const rec = findRecording(question);
    if (rec) return { model: recordedModel(rec), recorded: true, label: rec.label || "Model text replayed from a recorded 27B turn; tools ran live" };
    return { model: stubModel(aliases), recorded: false, label: "No recorded turn for this question; the deterministic template answered" };
  }
  if (provider === "llama" || provider === "mlx") return { model: openAiCompatible(provider, LOCAL_URLS[provider]), recorded: false, label: null };
  return { model: stubModel(aliases), recorded: false, label: provider === "stub" ? "Stub model (deterministic template)" : null };
}

export async function runTurn(ctx: ToolContext, provider: ProviderName, question: string, history: ModelMessage[] = [], hooks: TurnHooks = {}, opts: TurnOptions = {}): Promise<TurnOutput> {
  const t0 = Date.now();
  const spans: Span[] = [];
  const at = () => Date.now() - t0;
  const base = { question, provider, aliases: {}, tool_calls: [], violations: [], spans } as const;
  const routed = preRoute(question);
  spans.push({ kind: "prerouter", name: "preRoute", start_ms: 0, dur_ms: at(), outcome: routed ? routed.code : "pass" });
  if (routed) {
    const msg = REFUSAL_MESSAGES[routed.code];
    return { ...base, aliases: {}, tool_calls: [], violations: [], text: msg, rendered: msg, grounding: "refused", refusal: { code: routed.code, message: msg, layer: "prerouter" }, recorded: false, label: null };
  }
  // the cohort guard: a named cohort below the size floors is refused here, whatever the model would have done
  const cohorts = await publishedCohorts(ctx);
  const sized = cohorts ? cohortGuard(ctx.principal, question, cohorts) : null;
  spans.push({ kind: "prerouter", name: "cohortGuard", start_ms: at(), dur_ms: 0, outcome: sized ? sized.refusal.code : "pass" });
  if (sized) {
    const msg = sized.refusal.message;
    return { ...base, aliases: {}, tool_calls: [], violations: [], text: msg, rendered: msg, grounding: "refused", refusal: { code: sized.refusal.code, message: msg, layer: "prerouter" }, recorded: false, label: null };
  }
  const aliases: AliasMap = new Map();
  const calls: ToolCallRecord[] = [];
  const byCallId = new Map<string, ToolCallRecord>();
  const toolArgs: unknown[] = [];
  const { model, recorded, label } = modelFor(provider, aliases, question, opts);
  const production = provider === "workers-ai" && Boolean(opts.workersAi);
  const system = production ? withNoThink(SYSTEM_PROMPT) : SYSTEM_PROMPT;
  // the neuron budget (SPEC 14.11): reserve the turn's worst case first; refuse when today's cap would be exceeded
  let reservation: { reserved: number } | null = null;
  const usage = { input: 0, output: 0, known: true };
  const addUsage = (u: { inputTokens?: number; outputTokens?: number } | undefined) => {
    if (u?.inputTokens === undefined || u?.outputTokens === undefined) usage.known = false;
    else {
      usage.input += u.inputTokens;
      usage.output += u.outputTokens;
    }
  };
  if (production && opts.budget) {
    const want = neuronsFor(opts.workersAi!.model, TURN_CEILING) ?? 0;
    const r = await opts.budget.reserve(want, opts.workersAi!.dailyNeuronCap);
    spans.push({ kind: "prerouter", name: "budget", start_ms: at(), dur_ms: 0, outcome: r.ok ? "reserved" : "BUDGET_EXHAUSTED" });
    if (!r.ok) {
      const msg = REFUSAL_MESSAGES.BUDGET_EXHAUSTED;
      return { ...base, aliases: {}, tool_calls: [], violations: [], text: msg, rendered: msg, grounding: "refused", refusal: { code: "BUDGET_EXHAUSTED", message: msg, layer: "budget" }, recorded: false, label: null };
    }
    reservation = { reserved: want };
  }
  const settle = async () => {
    if (!reservation || !opts.budget) return;
    await opts.budget.settle(reservation.reserved, usage.known ? neuronsFor(opts.workersAi!.model, usage) : null);
  };
  const tools: Record<string, Tool> = {};
  for (const def of toolsFor(ctx.principal)) {
    tools[def.name] = {
      description: def.description,
      inputSchema: def.input as never,
      execute: async (args: Record<string, unknown>, opts: { toolCallId: string }) => {
        const s = at();
        hooks.onToolCall?.({ toolCallId: opts.toolCallId, tool: def.name, args });
        toolArgs.push(args);
        const out = await runTool(ctx, def.name, args);
        let record: ToolCallRecord;
        let digest: unknown;
        if (isRefusal(out)) {
          record = { alias: null, tool: def.name, args, result_id: null, refused: { code: out.code, message: out.message } };
          digest = { refused: true, code: out.code, message: out.message };
        } else {
          const alias = `r${aliases.size + 1}`;
          aliases.set(alias, { alias, result_id: out.result_id, tool: def.name, values: out.values, step: out.rounding?.step ?? null });
          record = { alias, tool: def.name, args, result_id: out.result_id, refused: null };
          digest = getTool(def.name)?.digest(out, alias);
        }
        calls.push(record);
        byCallId.set(opts.toolCallId, record);
        spans.push({ kind: "tool_call", name: def.name, start_ms: s, dur_ms: at() - s, outcome: record.refused ? record.refused.code : "ok", result_ids: record.result_id ? [record.result_id] : [] });
        hooks.onToolResult?.({ toolCallId: opts.toolCallId, record });
        return digest;
      },
    } as unknown as Tool;
  }
  const messages: ModelMessage[] = [...history, { role: "user", content: question }];
  let text = "";
  let modelText = "";
  let lastSteps: { toolCalls: { toolCallId: string; toolName: string; input: unknown }[] }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = at();
    const res = await generateText({ model, system, messages, tools, stopWhen: isStepCount(6), temperature: 0, maxOutputTokens: 400 });
    addUsage(res.totalUsage ?? res.usage);
    spans.push({ kind: "model_call", name: `generate${attempt ? " (retry)" : ""}`, start_ms: s, dur_ms: at() - s, tokens: { input: res.usage.inputTokens ?? null, output: res.usage.outputTokens ?? null, cached: res.usage.inputTokenDetails?.cacheReadTokens ?? null }, outcome: res.finishReason });
    text = production ? stripThink(res.text) : res.text;
    modelText = text;
    lastSteps = res.steps;
    // mlx drops an unparseable tool call silently: finish_reason tool-calls with no calls is retried once
    const silentDrop = res.finishReason === "tool-calls" && res.toolCalls.length === 0 && !text;
    if (!silentDrop) break;
  }
  const refusedCall = calls.find((c) => c.refused);
  if (refusedCall && aliases.size === 0) {
    await settle();
    const r = refusedCall.refused!;
    return { ...base, aliases: {}, tool_calls: calls, violations: [], text: r.message, rendered: r.message, grounding: "refused", refusal: { code: r.code, message: r.message, layer: "tool" }, recorded, label };
  }
  let grounding: Grounding = "passed";
  let check = checkGrounding({ text, aliases, question, toolArgs });
  const violations = [...check.violations];
  spans.push({ kind: "grounding", name: "check", start_ms: at(), dur_ms: 0, outcome: check.ok ? "passed" : `${check.violations.length} violations` });
  if (!check.ok && !recorded && provider !== "stub") {
    const s = at();
    const repair = await generateText({ model, system: production ? withNoThink(REPAIR_PROMPT) : REPAIR_PROMPT, messages: [...messages, { role: "assistant", content: text }, { role: "user", content: `Violations:\n- ${check.violations.join("\n- ")}\nAvailable results: ${[...aliases.keys()].join(", ")}.` }], temperature: 0, maxOutputTokens: 400 });
    addUsage(repair.totalUsage ?? repair.usage);
    const repairText = production ? stripThink(repair.text) : repair.text;
    const again = checkGrounding({ text: repairText, aliases, question, toolArgs });
    spans.push({ kind: "repair", name: "repair", start_ms: s, dur_ms: at() - s, outcome: again.ok ? "passed" : "failed" });
    if (again.ok) {
      text = repairText;
      check = again;
      grounding = "repaired";
    }
  }
  if (!check.ok) {
    const s = at();
    text = templateAnswer([...aliases.values()].map((a) => ({ alias: a.alias, tool: a.tool, values: a.values })));
    check = checkGrounding({ text, aliases, question, toolArgs });
    grounding = "template";
    spans.push({ kind: "template", name: "template", start_ms: s, dur_ms: at() - s, outcome: check.ok ? "passed" : "failed" });
  }
  await settle();
  const rendered = renderPlaceholders(text, aliases).text;
  // the recorder's view: each model step that called tools, then the text the turn accepted (the model's own text or
  // its repair; when the turn fell to the template, the model's failed text, so a replay falls to the template too)
  const model_steps: RecordedStep[] | undefined = opts.captureSteps
    ? [
        ...lastSteps
          .filter((st) => st.toolCalls.length > 0)
          .map((st) => ({ tool_calls: st.toolCalls.map((tc) => ({ tool: tc.toolName, args: (tc.input ?? {}) as Record<string, unknown>, result_id: byCallId.get(tc.toolCallId)?.result_id ?? null })) })),
        { text: grounding === "template" ? modelText : text },
      ]
    : undefined;
  return {
    question,
    text,
    rendered,
    aliases: Object.fromEntries([...aliases.entries()].map(([k, v]) => [k, v.result_id])),
    tool_calls: calls,
    grounding,
    refusal: null,
    provider,
    recorded,
    label,
    violations,
    spans,
    ...(model_steps ? { model_steps } : {}),
  };
}
