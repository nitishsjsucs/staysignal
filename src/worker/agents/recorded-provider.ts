// Recorded turns (SPEC 14.2, ADR 0010): a recorded Qwen3.6-27B turn's model text and tool calls replay through a mock
// model while the tools execute live, so content-addressed result IDs resolve after any reset. Recordings live in
// demo/recordings/*.json and are bundled through the generated index.
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
