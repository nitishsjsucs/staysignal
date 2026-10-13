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
  return at && /^\d{4}-\d{2}-\d{2}/.test(at) ? at.slice(0, 10) : null;
}

const TAIL: Record<ProvenanceWhere, string> = {
  chat: "Numbers compute live from the warehouse.",
  lab: "No model runs here; the charts are computed from the recorded posts.",
  interview: "No model runs here.",
};

export function recordedProvenance(model: string | null | undefined, at: string | null | undefined, where: ProvenanceWhere): string {
  const date = recordedDate(at);
  return `Recorded from ${modelName(model)} on this laptop${date ? `, ${date}` : ""}; replayed. ${TAIL[where]}`;
}

/** Shown when the demo has no recording for what was asked: friendly, and never a stub answer. */
export const UNRECORDED_CHAT =
  "This question has no recorded answer. The demo replays answers recorded from Qwen3.6-27B on this laptop rather than running the model live, so it answers the recorded questions below.";
export const UNRECORDED_CHAT_NONE =
  "No answers have been recorded for the demo yet. The demo replays answers recorded from Qwen3.6-27B on this laptop rather than running the model live.";
export const UNRECORDED_INTERVIEW =
  "This persona has no recorded answer to that question. In the demo the personas answer only the questions recorded from Qwen3.6-27B on this laptop; pick one of the recorded questions.";
