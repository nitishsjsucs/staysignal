// npm run lab:interviews [-- --engine URL] [--only N,N] (SPEC 15.8): asks each question of lab/interview-questions.json
// once through the engine's /lab/interview with the local 27B (provider mlx), and writes the answers to
// lab/interviews.json, the recorded answers the demo replays. Needs the guarded 27B (`npm run llm -- start 27b`) and
// the engine's HTTP app (`uv run --project engine staysignal serve`, no runner needed). The persona's context comes
// from the model-recorded session: the engine's log row (var/engine/work/lab/interviews.jsonl) names it, and an answer
// from a stub placeholder session is refused. An answer that the public hygiene tier rejects, or that the 100-token cap
// cut off mid-sentence, is asked again (the interview samples at temperature 0.7), never edited. Synthetic personas:
// hypothesis generation, not a forecast, not a survey, not validated.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile } from "./lib/hygiene.ts";
import { localDate, MODELS } from "./demo-record.ts";

export interface InterviewQuestion {
  proposal: string;
  persona_id: string;
  question: string;
}
export interface RecordedAnswer extends InterviewQuestion {
  answer: string;
  model: string;
  recorded_at: string;
}
interface Doc {
  note: string;
  answers: RecordedAnswer[];
}

const QUESTIONS = join("lab", "interview-questions.json");
const ANSWERS = join("lab", "interviews.json");
const LOG = join("var", "engine", "work", "lab", "interviews.jsonl");

/** Why an answer cannot be recorded, or null: empty, stub text, cut off by the token cap, or a public-tier hygiene hit. */
export function answerProblem(answer: string): string | null {
  const a = answer.trim();
  if (!a) return "empty answer";
  if (a.startsWith("[stub]")) return "stub text";
  if (!/[.!?]["')]?$/.test(a)) return "cut off by the 100-token cap";
  const hits = checkFile({ path: ANSWERS, text: a });
  return hits.length ? `hygiene: ${hits.map((h) => h.rule).join(", ")}` : null;
}

/** The answers with `next` replacing any answer to the same proposal, persona and question, in question order. */
export function mergeAnswers(current: RecordedAnswer[], next: RecordedAnswer[], order: InterviewQuestion[]): RecordedAnswer[] {
  const key = (a: InterviewQuestion) => `${a.proposal}|${a.persona_id}|${a.question}`;
  const byKey = new Map(current.map((a) => [key(a), a]));
  for (const a of next) byKey.set(key(a), a);
  const rank = (a: InterviewQuestion) => {
    const i = order.findIndex((q) => key(q) === key(a));
    return i < 0 ? order.length : i;
  };
  return [...byKey.values()].sort((a, b) => rank(a) - rank(b));
}

function arg(name: string, d: string): string {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
}

function lastLogRow(): { session: string; persona_id: string; question: string; answer: string; provider: string } | null {
  if (!existsSync(LOG)) return null;
  const lines = readFileSync(LOG, "utf8").trim().split("\n");
  return lines.length ? (JSON.parse(lines[lines.length - 1]!) as never) : null;
}

async function main(): Promise<void> {
  const engine = arg("--engine", "http://127.0.0.1:8196");
  const only = arg("--only", "").split(",").filter(Boolean).map(Number);
  const tries = Number(arg("--tries", "3"));
  const questions = (JSON.parse(readFileSync(QUESTIONS, "utf8")) as { questions: InterviewQuestion[] }).questions;
  const todo = only.length ? questions.filter((_, i) => only.includes(i + 1)) : questions;
  const ping = await fetch(`${MODELS.mlx.url}/models`).catch(() => null);
  if (!ping?.ok) throw new Error("no model server on 8186; start it with npm run llm -- start 27b");
  const health = await fetch(`${engine}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`no engine at ${engine}; start it with uv run --project engine staysignal serve`);
  const date = localDate();
  const recorded: RecordedAnswer[] = [];
  let failed = 0;
  for (const q of todo) {
    let done = false;
    for (let attempt = 1; attempt <= tries && !done; attempt++) {
      const t0 = Date.now();
      const r = await fetch(`${engine}/lab/interview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...q, provider: "mlx" }) });
      if (!r.ok || !r.body) {
        console.log(`[lab:interviews] ${q.proposal} ${q.persona_id}: HTTP ${r.status}`);
        break;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let text = "";
      let firstMs: number | null = null;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        if (firstMs === null) firstMs = Date.now() - t0;
        text += dec.decode(value, { stream: true });
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const first = firstMs === null ? "n/a" : (firstMs / 1000).toFixed(1);
      const row = lastLogRow();
      if (!row || row.question !== q.question || row.persona_id !== q.persona_id) throw new Error("the engine's log has no row for this answer");
      if (row.session.endsWith("-stub")) throw new Error(`the engine answered from the placeholder session ${row.session}; record the 27B sessions first`);
      const problem = answerProblem(text);
      console.log(`[lab:interviews] ${q.proposal} ${q.persona_id} try ${attempt}: first token ${first} s, answer ${secs} s, session ${row.session}${problem ? `; not recorded: ${problem}` : ""}`);
      if (problem) continue;
      recorded.push({ ...q, answer: text.trim(), model: MODELS.mlx.model, recorded_at: date });
      done = true;
    }
    if (!done) failed++;
  }
  const doc = JSON.parse(readFileSync(ANSWERS, "utf8")) as Doc;
  doc.answers = mergeAnswers(doc.answers, recorded, questions);
  doc.note = "Recorded persona interview answers (SPEC 15.8), written by npm run lab:interviews from the engine's interview with Qwen3.6-27B on this laptop; the demo replays them. Synthetic personas only; hypothesis generation, not a forecast, not a survey, not validated.";
  writeFileSync(ANSWERS, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`[lab:interviews] ${recorded.length} of ${todo.length} answers written to ${ANSWERS}`);
  if (failed) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(`[lab:interviews] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
