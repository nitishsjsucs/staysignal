// npm run demo:record [-- --provider mlx|llama] [--questions demo/questions.json] [--only id,id] [--base URL]
// (SPEC 14.2, ADR 0010): asks each chat question of the demo script through POST /api/dev/agent/turn (the same
// AnalystAgent turn as the chat dock, dev auth on localhost only) with a live local model, takes the model's own steps
// (tool calls with their arguments, then the accepted text) and writes one RecordedTurn per question to
// demo/recordings/<id>.json, labeled with the model and the date; then regenerates the recordings index. The recorded
// provider replays these steps while the tools run live. Needs `npm run dev:wrangler` (restart it afterwards so the
// bundle picks up the new index) and the guarded model server (`npm run llm -- start 27b` for mlx). Only 27B
// recordings are committed as demo turns; a Qwen3-1.7B recording is for checking the recorder.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordedProvenance } from "../src/shared/provenance.ts";

export interface DemoQuestion {
  id: string;
  beat: string;
  principal: string;
  question: string;
  expect?: "refusal";
}

interface Step {
  tool_calls?: { tool: string; args: Record<string, unknown>; result_id?: string | null }[];
  text?: string;
}

export interface TurnReply {
  text: string;
  grounding: string;
  refusal: { code: string; layer: string } | null;
  tool_calls: { tool: string; result_id: string | null; refused: { code: string } | null }[];
  model_steps?: Step[];
}

export const MODELS = {
  mlx: { url: "http://127.0.0.1:8186/v1", model: "Qwen3.6-27B (mlx-community/Qwen3.6-27B-4bit, mlx_lm.server)", short: "27B" },
  llama: { url: "http://127.0.0.1:8187/v1", model: "Qwen3-1.7B (Q4_0, llama-server)", short: "Qwen3-1.7B" },
} as const;
export type RecordProvider = keyof typeof MODELS;

export function localDate(d = new Date()): string {
  return d.toLocaleDateString("en-CA");
}

/** The chat's provenance line for a replayed turn, the same one the Worker shows (src/shared/provenance.ts). */
export function labelFor(provider: RecordProvider, date: string): string {
  return recordedProvenance(MODELS[provider].model, date, "chat");
}

/** What to write for one question, or why nothing is written. A recording needs the model's steps and text that
 * passed the grounding check (passed, or repaired by the model); a template answer would replay as the template. */
export function toRecording(q: DemoQuestion, reply: TurnReply, provider: RecordProvider, date: string): { ok: true; recording: Record<string, unknown> } | { ok: false; reason: string } {
  if (reply.refusal) {
    return q.expect === "refusal"
      ? { ok: false, reason: `refused by the ${reply.refusal.layer} (${reply.refusal.code}), as expected; refusals need no recording` }
      : { ok: false, reason: `unexpected refusal ${reply.refusal.code} by the ${reply.refusal.layer}` };
  }
  if (q.expect === "refusal") return { ok: false, reason: "expected a refusal but the turn answered" };
  if (!reply.model_steps?.length) return { ok: false, reason: "the turn returned no model steps (is the server current?)" };
  if (reply.grounding !== "passed" && reply.grounding !== "repaired") return { ok: false, reason: `grounding ${reply.grounding}: the model's text did not pass the check; ask again` };
  const last = reply.model_steps[reply.model_steps.length - 1];
  if (!last?.text) return { ok: false, reason: "the model wrote no final text" };
  return {
    ok: true,
    recording: {
      id: q.id,
      question: q.question,
      model: MODELS[provider].model,
      provider,
      recorded_at: date,
      label: labelFor(provider, date),
      principal: q.principal,
      grounding: reply.grounding,
      note: "Synthetic company. Model text and tool calls from a local model; tool results are recomputed live on replay.",
      steps: reply.model_steps,
    },
  };
}

function arg(name: string, d: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
}

async function main(): Promise<void> {
  const provider = arg("--provider", "mlx") as RecordProvider;
  if (!(provider in MODELS)) throw new Error("--provider must be mlx or llama");
  const base = arg("--base", "http://127.0.0.1:8795");
  const only = arg("--only", "").split(",").filter(Boolean);
  const file = arg("--questions", join("demo", "questions.json"));
  const all = (JSON.parse(readFileSync(file, "utf8")) as { questions: DemoQuestion[] }).questions;
  const questions = only.length ? all.filter((q) => only.includes(q.id)) : all;
  const ping = await fetch(`${MODELS[provider].url}/models`).catch(() => null);
  if (!ping?.ok) throw new Error(`no model server at ${MODELS[provider].url}; start it with npm run llm -- start ${provider === "mlx" ? "27b" : "1.7b"}`);
  const date = localDate();
  const out = join("demo", "recordings");
  mkdirSync(out, { recursive: true });
  const tokens = new Map<string, string>();
  let failed = 0;
  for (const q of questions) {
    if (!tokens.has(q.principal)) {
      const r = await fetch(`${base}/dev/login?principal=${encodeURIComponent(q.principal)}`);
      if (!r.ok) throw new Error(`dev login failed (${r.status}); is npm run dev:wrangler running on ${base}?`);
      tokens.set(q.principal, ((await r.json()) as { token: string }).token);
    }
    const t0 = Date.now();
    const r = await fetch(`${base}/api/dev/agent/turn`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.get(q.principal)}`, "content-type": "application/json" },
      body: JSON.stringify({ question: q.question, provider, capture_steps: true }),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) {
      failed++;
      console.log(`[demo:record] ${q.id}: turn failed with HTTP ${r.status} after ${secs} s`);
      continue;
    }
    const res = toRecording(q, (await r.json()) as TurnReply, provider, date);
    if (!res.ok) {
      if (q.expect !== "refusal" || !res.reason.endsWith("as expected; refusals need no recording")) failed++;
      console.log(`[demo:record] ${q.id}: not recorded: ${res.reason} (${secs} s)`);
      continue;
    }
    writeFileSync(join(out, `${q.id}.json`), `${JSON.stringify(res.recording, null, 2)}\n`);
    console.log(`[demo:record] ${q.id}: wrote ${join(out, `${q.id}.json`)} (${res.recording.grounding}, ${secs} s)`);
  }
  const idx = spawnSync(process.execPath, [join("scripts", "gen-fixtures.ts")], { stdio: "inherit" });
  if (idx.status !== 0) throw new Error("npm run fixtures:index failed");
  console.log(`[demo:record] ${questions.length - failed} of ${questions.length} questions done with ${MODELS[provider].model}; restart the server to replay them`);
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(`[demo:record] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
