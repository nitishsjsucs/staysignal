// Renders results/*.json and evals/results/*.json into the README Results section (pattern copied from PeopleLake
// scripts/lib/results.ts, MIT). Only numbers produced by this repository's scripts appear, each with its command and
// date. Every StaySignal result is computed on the synthetic world and says so.
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

export type Report = LlmMeasureReport;
export const REPORT_KINDS: readonly string[] = ["llm-measure"];

const gb = (b: number | null | undefined) => (b === null || b === undefined ? "n/a" : `${(b / 1e9).toFixed(2)} GB`);
const s = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const n = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "n/a" : `${v.toLocaleString("en-US")}${unit}`);

function probeRow(name: string, m: StreamMeasure | undefined): string {
  if (!m) return `| ${name} | not reached | | | |`;
  return `| ${name} | ${n(m.promptTokens)} (${n(m.cachedTokens)} cached) | ${s(m.ttftMs)} | ${n(m.prefillTokPerS, " tok/s")} | ${n(m.decodeTokPerS, " tok/s")} |`;
}

export function renderLlmMeasure(file: string, r: LlmMeasureReport): string {
  const lines: string[] = [];
  lines.push(`**Local model measurement: ${r.model}** (\`${r.command}${r.model.includes("1.7B") ? " -- --model 1.7b" : ""}\`, ${r.date}, [${file}](${file})). Status: ${r.status}. Agent-shaped prompts: the system prompt plus the 13 tool schemas, and prior tool-result digests (synthetic placeholders).`);
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

export function renderResults(reports: { file: string; report: Report }[]): string {
  if (reports.length === 0) return "No recorded results yet.";
  const parts = reports
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, report }) => (report.kind === "llm-measure" ? renderLlmMeasure(file, report) : ""))
    .filter(Boolean);
  return parts.join("\n\n");
}

export function replaceSection(readme: string, body: string): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("README results markers not found");
  return `${readme.slice(0, a + START.length)}\n${body}\n${readme.slice(b)}`;
}
