// Memory budget for local LLM servers (SPEC 15.10). From the cached Qwen3.6-27B config: 16 full-attention layers with
// 4 KV heads of dimension 256 in bf16 give 64 KiB of KV cache per token; 48 linear-attention layers with 48 value heads
// of 128 x 128 in fp32 give about 0.151 GB of recurrent state per sequence. W is the resident size right after load
// (weights plus runtime overhead), measured by `npm run llm:measure` (results/llm-measure-*.json).
//   estimate = W + n_seq x (0.151 GB + ctx_tokens x 64 KiB) + prompt_cache_bytes
// Any configuration whose estimate exceeds 17.2 GB is refused (the MLX GPU working-set limit is 17.76 GB).

export const GB = 1e9;
export const KV_BYTES_PER_TOKEN = 64 * 1024;
export const RECURRENT_BYTES_PER_SEQ = 0.151 * GB;
export const LIMIT_BYTES = 17.2 * GB;
/** Resident size after load: the wired memory the 27B load added, 15.69 GB, measured by `npm run llm:measure` on
 * 2026-10-12 (results/llm-measure-2026-10-12.json; `footprint` reported 16 GiB at the same point). */
export const W_27B_BYTES = 15.7 * GB;
export const W_MEASURED_SOURCE = "results/llm-measure-2026-10-12.json: wired-memory delta after load";

export interface LlmConfig {
  nSeq: number;
  ctxTokens: number;
  promptCacheBytes: number;
  wBytes?: number;
}

export function estimateBytes(c: LlmConfig): number {
  const w = c.wBytes ?? W_27B_BYTES;
  return w + c.nSeq * (RECURRENT_BYTES_PER_SEQ + c.ctxTokens * KV_BYTES_PER_TOKEN) + c.promptCacheBytes;
}

export function checkBudget(c: LlmConfig): { ok: boolean; estimateGb: number; limitGb: number } {
  const est = estimateBytes(c);
  return { ok: est <= LIMIT_BYTES, estimateGb: Math.round((est / GB) * 1000) / 1000, limitGb: LIMIT_BYTES / GB };
}

/** Server profiles for the 27B. `agent`: one sequence with a 7,000-token history cap plus tool schemas (8,704 tokens
 * of context; the system prompt and 13 tool schemas alone measured 3,700 tokens), 16.93 GB estimated; `lab`: 3
 * sequences of about 2,300 tokens with a 512 MB prompt cache, 17.12 GB (4 sequences estimate 17.42 GB with the
 * measured W and are refused, so SPEC 15.10's fallback of 3 applies). */
export const PROFILES = {
  agent: { nSeq: 1, ctxTokens: 8704, promptCacheBytes: 512e6, promptCacheSize: 2 },
  lab: { nSeq: 3, ctxTokens: 2300, promptCacheBytes: 512e6, promptCacheSize: 4 },
} as const;
export type ProfileName = keyof typeof PROFILES;
