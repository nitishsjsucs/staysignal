// The Scenario Lab's persona interview (SPEC 15.8). Locally, with the engine running, the answer streams live from the
// engine's /lab/interview (the local 27B, or the scripted stub when the Worker runs the stub model); a live answer
// with no response within 12 seconds, or any engine error, falls back to a recorded answer for the same persona and
// question (lab/interviews.json), and without one to a labeled placeholder. Production shows recorded answers only.
// Demo mode (SS_DEMO=1) never calls the engine or a model: a recorded answer, or a friendly message naming the
// recorded questions. Synthetic personas: hypothesis generation, never a forecast, a survey or evidence for a review
// (ADR 0008).
import recorded from "../../lab/interviews.json";
import { recordedProvenance, UNRECORDED_INTERVIEW } from "../shared/provenance";

export const LAB_LABEL = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.";
export const PLACEHOLDER_ANSWER =
  "[stub] Placeholder: the scripted stub wrote this, not a model. No recorded answer exists for this question; the live interview runs only on the local machine with the 27B and the engine.";
export const FIRST_BYTE_MS = 12_000;

export interface InterviewRequest {
  proposal: string;
  persona_id: string;
  question: string;
}
export interface RecordedAnswer extends InterviewRequest {
  answer: string;
  model: string;
  recorded_at: string;
}
export type InterviewSource = "live" | "stub" | "recorded" | "placeholder" | "unrecorded";

const ALL = (): RecordedAnswer[] => (recorded as { answers: RecordedAnswer[] }).answers;

/** The recorded questions for a proposal (the interview's chips in demo mode), without the answers. */
export function recordedInterviews(proposal: string, answers: RecordedAnswer[] = ALL()): { persona_id: string; question: string; provenance: string }[] {
  return answers.filter((a) => a.proposal === proposal).map((a) => ({ persona_id: a.persona_id, question: a.question, provenance: recordedProvenance(a.model, a.recorded_at, "interview") }));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** The request, cleaned, or why it is refused. */
export function parseInterview(body: unknown): InterviewRequest | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const proposal = typeof b.proposal === "string" ? b.proposal : "";
  const persona = typeof b.persona_id === "string" ? b.persona_id : "";
  const question = typeof b.question === "string" ? b.question.replace(/\s+/g, " ").trim() : "";
  if (!/^[a-z0-9-]{3,60}$/.test(proposal)) return { error: "unknown proposal" };
  if (!/^P\d{2}$/.test(persona)) return { error: "unknown persona" };
  if (!question || question.length > 300) return { error: "the question must be 1 to 300 characters" };
  return { proposal, persona_id: persona, question };
}

/** A recorded answer for the same proposal, persona and question (case and punctuation ignored). */
export function findRecordedAnswer(req: InterviewRequest, answers: RecordedAnswer[] = ALL()): RecordedAnswer | null {
  const q = norm(req.question);
  return answers.find((a) => a.proposal === req.proposal && a.persona_id === req.persona_id && norm(a.question) === q) ?? null;
}

function textResponse(text: string, source: InterviewSource, model: string | null, provenance: string | null = null): Response {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-staysignal-label": LAB_LABEL, "x-staysignal-source": source };
  if (model) headers["x-staysignal-model"] = model;
  if (provenance) headers["x-staysignal-provenance"] = provenance;
  return new Response(text, { headers });
}

function recordedResponse(rec: RecordedAnswer): Response {
  return textResponse(rec.answer, "recorded", `${rec.model}, recorded ${rec.recorded_at}`, recordedProvenance(rec.model, rec.recorded_at, "interview"));
}

/** The fallback: a recorded answer, else the labeled placeholder. */
export function fallbackAnswer(req: InterviewRequest): Response {
  const rec = findRecordedAnswer(req);
  return rec ? recordedResponse(rec) : textResponse(PLACEHOLDER_ANSWER, "placeholder", null);
}

/** Demo mode: a recorded answer, else a friendly message (the page shows the recorded questions); never a model. */
export function recordedOnlyAnswer(req: InterviewRequest, answers: RecordedAnswer[] = ALL()): Response {
  const rec = findRecordedAnswer(req, answers);
  return rec ? recordedResponse(rec) : textResponse(UNRECORDED_INTERVIEW, "unrecorded", null);
}

/** The live answer from the engine, streamed through, or the fallback when it does not start within 12 seconds. */
export async function liveAnswer(engineUrl: string, req: InterviewRequest, provider: "mlx" | "stub", fetchFn: typeof fetch = fetch): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
  try {
    const r = await fetchFn(`${engineUrl}/lab/interview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...req, provider }), signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok || !r.body) return fallbackAnswer(req);
    const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-staysignal-label": LAB_LABEL, "x-staysignal-source": provider === "stub" ? "stub" : "live" };
    if (provider === "mlx") headers["x-staysignal-model"] = "Qwen3.6-27B (local), max 100 tokens";
    return new Response(r.body, { headers });
  } catch {
    clearTimeout(timer);
    return fallbackAnswer(req);
  }
}
