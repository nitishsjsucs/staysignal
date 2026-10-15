// The one provenance line for recorded model output (the operator's decision of 2026-10-13: the demo never runs a
// model live; every model output on screen was recorded once on the operator's laptop and is replayed). The same
// wording appears on chat answers, Scenario Lab sessions and persona interview answers; only the last sentence says
// what is computed where.

export type ProvenanceWhere = "chat" | "lab" | "interview";

/** The model's display name: "Qwen3.6-27B (mlx-community/Qwen3.6-27B-4bit, mlx_lm.server)" -> "Qwen3.6-27B". */
export function modelName(model: string | null | undefined): string {
  const m = (model ?? "").split(" (")[0]?.trim();
  return m || "a local model";
}

/** The recording date (YYYY-MM-DD) from a date or a timestamp, or null. */
export function recordedDate(at: string | null | undefined): string | null {
  if (!at || !/^\d{4}-\d{2}-\d{2}/.test(at)) return null;
  // A full UTC timestamp (the Lab's manifests) names its zone, so an evening recording in California is not read as
  // the next day; a bare date (the chat recorder's local date) stays as it is.
  const t = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?Z$/.exec(at);
  return t ? `${t[1]} ${t[2]}:${t[3]} UTC` : at.slice(0, 10);
}

const TAIL: Record<ProvenanceWhere, string> = {
  chat: "Numbers compute live from the warehouse.",
  lab: "No model runs here; the charts are computed from the recorded posts.",
  interview: "No model runs here.",
};

/** `place` is where the recording was made as the viewer reads it: "this laptop" in the operator's own demo, "the
 * author's laptop" in the public demo (ADR 0018). */
export function recordedProvenance(model: string | null | undefined, at: string | null | undefined, where: ProvenanceWhere, place = "this laptop"): string {
  const date = recordedDate(at);
  return `Recorded from ${modelName(model)} on ${place}${date ? `, ${date}` : ""}; replayed. ${TAIL[where]}`;
}

/** The public demo's chip on an answer to a question with no recording: the deterministic stub, never a model. */
export const STUB_LABEL_PUBLIC = "Stub model (deterministic template): no recording exists for this question, so no model ran";

/** Shown when the demo has no recording for what was asked: friendly, and never a stub answer. */
export const UNRECORDED_CHAT =
  "This question has no recorded answer. The demo replays answers recorded from Qwen3.6-27B on this laptop rather than running the model live, so it answers the recorded questions below.";
export const UNRECORDED_CHAT_NONE =
  "No answers have been recorded for the demo yet. The demo replays answers recorded from Qwen3.6-27B on this laptop rather than running the model live.";
export const UNRECORDED_INTERVIEW =
  "This persona has no recorded answer to that question. In the demo the personas answer only the questions recorded from Qwen3.6-27B on this laptop; pick one of the recorded questions.";
