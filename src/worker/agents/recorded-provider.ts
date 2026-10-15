// Recorded turns (SPEC 14.2, ADR 0010): a recorded Qwen3.6-27B turn's model text and tool calls replay through a mock
// model while the tools execute live, so content-addressed result IDs resolve after any reset. Recordings live in
// demo/recordings/*.json and are bundled through the generated index.
import { recordedProvenance } from "../../shared/provenance";
import demoQuestions from "../../../demo/questions.json";
import { RECORDINGS } from "../generated/recordings-index";

export interface RecordedStep {
  tool_calls?: { tool: string; args: Record<string, unknown>; result_id?: string | null }[];
  text?: string;
}

/** One recorded turn (written by npm run demo:record, scripts/demo-record.ts). `label` is what the chat shows on
 * replay and names the model and the recording date. */
export interface RecordedTurn {
  id: string;
  question: string;
  model: string;
  recorded_at: string;
  label: string;
  principal?: string;
  provider?: string;
  grounding?: string;
  steps: RecordedStep[];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

export function findRecording(question: string): RecordedTurn | null {
  const q = norm(question);
  return (RECORDINGS as RecordedTurn[]).find((r) => norm(r.question) === q) ?? null;
}

export function recordingCount(): number {
  return RECORDINGS.length;
}

/** The questions with a recorded turn, in recording order: the chat's chips in demo mode. */
export function recordedQuestions(): string[] {
  const order = (demoQuestions as { questions: { question: string }[] }).questions.map((q) => norm(q.question));
  const rank = (q: string) => (order.indexOf(norm(q)) + order.length + 1) % (order.length + 1);
  return (RECORDINGS as RecordedTurn[]).map((r) => r.question).sort((a, b) => rank(a) - rank(b));
}

/** What the chat shows on a replayed turn: the shared provenance line, from the recording's model and date. The public
 * demo's variant says where its numbers come from: results exported from the synthetic warehouse. */
export function replayLabel(turn: RecordedTurn, place?: string, variant: "local" | "public" = "local"): string {
  return recordedProvenance(turn.model, turn.recorded_at, variant === "public" ? "chat-public" : "chat", place);
}
