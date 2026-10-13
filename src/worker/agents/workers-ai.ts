// The production model (SPEC 14.11): Workers AI `@cf/qwen/qwen3-30b-a3b-fp8` through AI Gateway's OpenAI-compatible
// endpoint, with metadata-only logging (`cf-aig-collect-log-payload: false`) and at most five allowlisted metadata
// keys (ids and labels, never prompt text or a person), Qwen3's `/no_think` switch at the end of the system prompt,
// `<think>` blocks stripped from any text, and a daily neuron budget reserved before each call and settled from the
// returned usage. Pattern from PeopleLens worker/src/llm/workersAi.ts and session/accountBudgetDO.ts (MIT).
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import rates from "../../../ai/rates.json";

export const PRODUCTION_MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
export const METADATA_ONLY_HEADER = "cf-aig-collect-log-payload";
export const METADATA_HEADER = "cf-aig-metadata";
export const METADATA_KEYS = ["route", "tool", "role", "eval_run", "request_hash"] as const;
export const NO_THINK = "/no_think";

export interface WorkersAiConfig {
  accountId: string;
  gatewayId: string;
  token: string;
  model: string;
  dailyNeuronCap: number;
}

export type AigMetadata = Partial<Record<(typeof METADATA_KEYS)[number], string | number>>;

/** At most five allowlisted keys; values are short ids or labels (no spaces, no '@', at most 64 characters). */
export function aigMetadata(meta: Record<string, unknown>): string {
  const out: Record<string, string | number> = {};
  for (const k of METADATA_KEYS) {
    const v = meta[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "string" && /^[A-Za-z0-9_.:#-]{1,64}$/.test(v)) out[k] = v;
  }
  return JSON.stringify(out);
}

export function gatewayBaseUrl(cfg: Pick<WorkersAiConfig, "accountId" | "gatewayId">): string {
  return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(cfg.accountId)}/${encodeURIComponent(cfg.gatewayId)}/workers-ai/v1`;
}

export function gatewayHeaders(cfg: Pick<WorkersAiConfig, "token">, meta: AigMetadata): Record<string, string> {
  return {
    authorization: `Bearer ${cfg.token}`,
    "cf-aig-authorization": `Bearer ${cfg.token}`,
    [METADATA_ONLY_HEADER]: "false",
    [METADATA_HEADER]: aigMetadata(meta),
  };
}

export function workersAiModel(cfg: WorkersAiConfig, meta: AigMetadata, fetchImpl?: typeof fetch): LanguageModel {
  const provider = createOpenAICompatible({ name: "workers-ai", baseURL: gatewayBaseUrl(cfg), headers: gatewayHeaders(cfg, meta), includeUsage: true, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  return provider(cfg.model);
}

/** Removes Qwen3 reasoning: closed `<think>` blocks and an unclosed one at the end. */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .trim();
}

export function withNoThink(system: string): string {
  return system.trimEnd().endsWith(NO_THINK) ? system : `${system}\n${NO_THINK}`;
}

const RATES = rates as Record<string, { input_neurons_per_million: number; output_neurons_per_million: number }>;

/** Neurons for a call's token usage at the pinned rates (ai/rates.json); null when the model has no rate. */
export function neuronsFor(model: string, usage: { input: number; output: number }): number | null {
  const r = RATES[model];
  if (!r) return null;
  return Math.ceil((usage.input * r.input_neurons_per_million + usage.output * r.output_neurons_per_million) / 1e6);
}

/** The pre-flight reservation for one turn: the worst case of every step at the prompt and output ceilings. */
export const TURN_CEILING = { input: 7 * 8000, output: 7 * 400 };

export interface BudgetPort {
  reserve(neurons: number, cap: number): Promise<{ ok: boolean; used: number; cap: number }>;
  settle(reserved: number, actual: number | null): Promise<void>;
}
