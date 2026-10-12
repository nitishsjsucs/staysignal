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

export type Report = LlmMeasureReport | OracleCoverageReport | DemoResetReport;
export const REPORT_KINDS: readonly string[] = ["llm-measure", "oracle-coverage", "demo-reset"];

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

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function renderOracleCoverage(file: string, r: OracleCoverageReport): string {
  const lines: string[] = [];
  const first = r.origins[0] ?? "";
  const last = r.origins[r.origins.length - 1] ?? "";
  lines.push(
    `**Oracle coverage (C5)** (\`${r.command}\`, ${r.date}, [${file}](${file})). Synthetic world (\`${r.profile}\`, seed ${r.seed}). The forward-simulation oracle's ${Math.round(r.level * 100)}% intervals (${r.n_futures.toLocaleString("en-US")} futures each) against the realized counts at ${r.origins.length} quarterly origins from ${first} to ${last}, for the company and each organization, by cause and horizon: ${pct(r.coverage)} of ${r.cells} cells (target ${pct(r.band[0])} to ${pct(r.band[1])}; ${r.within_band ? "met" : "not met"}).`,
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

export function renderDemoReset(file: string, r: DemoResetReport): string {
  return `**Demo reset** (\`${r.command}\`, ${r.date}, [${file}](${file})): restoring the snapshot for the start of beat ${r.beat} and restarting the demo profile (wrangler dev and the local engine) took ${r.seconds.toFixed(1)} s, against a target of ${r.target_seconds} s. Synthetic demo state.`;
}

export function renderResults(reports: { file: string; report: Report }[]): string {
  if (reports.length === 0) return "No recorded results yet.";
  const parts = reports
    .slice()
    .sort((a, b) => a.file.localeCompare(b.file))
    .map(({ file, report }) => (report.kind === "llm-measure" ? renderLlmMeasure(file, report) : report.kind === "oracle-coverage" ? renderOracleCoverage(file, report) : report.kind === "demo-reset" ? renderDemoReset(file, report) : ""))
    .filter(Boolean);
  return parts.join("\n\n");
}

export function replaceSection(readme: string, body: string): string {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a === -1 || b === -1 || b < a) throw new Error("README results markers not found");
  return `${readme.slice(0, a + START.length)}\n${body}\n${readme.slice(b)}`;
}
