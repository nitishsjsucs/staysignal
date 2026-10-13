// What a human decision adds to the agent's memory (SPEC 14.10): an approval or a rejection becomes a decision note and
// a rollback a timeline bullet. Each cites the action sequence number and names the decider's role, never a person, and
// never copies the free-text reason (it may name someone). Routine actions are recorded by the routine itself.
import type { MemoryNoteInput } from "../../shared/contracts";

export interface ActionForMemory {
  seq: number;
  kind: string;
  actor_kind: string;
  payload: Record<string, unknown>;
  reverses_seq: number | null;
}

const SUBJECT: Record<string, string> = { review: "review", mapping: "mapping proposal", publish: "publish request", run: "publish request" };

const ACTION_NAME: Record<string, string> = { "review.approve": "a review approval", "mapping.activate": "a mapping activation", "run.publish": "a publish", rollback: "a rollback" };

const cap = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

function cohortName(id: unknown): string {
  const s = String(id ?? "");
  return s === "company" ? "the company" : (s.split(":").pop() ?? s);
}

export function decisionMemoryNote(a: ActionForMemory, roleLabel: string): MemoryNoteInput | null {
  if (a.actor_kind !== "human") return null;
  const p = a.payload;
  if (a.kind === "review.approve") {
    return {
      kind: "decision",
      title: `Review ${p.review_id} for ${cohortName(p.cohort_id)} approved`,
      bullets: [`A ${roleLabel} approved review ${p.review_id} for ${cohortName(p.cohort_id)} (action ${a.seq}); its checks became tasks for the owning team.`],
      aliases: ["review", "approval"],
    };
  }
  if (a.kind === "mapping.activate") {
    return {
      kind: "decision",
      title: `${cap(String(p.source))} mapping ${p.to} activated`,
      bullets: [`A ${roleLabel} approved mapping proposal ${p.proposal_id}: the ${p.source} mapping moved from ${p.from} to ${p.to} (action ${a.seq}).`],
      aliases: ["mapping", "approval"],
    };
  }
  if (a.kind === "run.publish") {
    return {
      kind: "decision",
      title: `Run ${p.run_id} published by approval`,
      bullets: [`A ${roleLabel} approved publishing run ${p.run_id} in place of ${p.previous_run_id ?? "no earlier run"} (action ${a.seq}).`],
      aliases: ["publish", "approval"],
    };
  }
  if (a.kind.endsWith(".reject")) {
    const subject = SUBJECT[a.kind.split(".")[0] ?? ""] ?? "request";
    return {
      kind: "decision",
      title: `${cap(subject)} ${p.subject_id} rejected`,
      bullets: [`A ${roleLabel} rejected ${subject} ${p.subject_id} (action ${a.seq}).`],
      aliases: ["rejection"],
    };
  }
  if (a.kind === "rollback") {
    const what = ACTION_NAME[String(p.reverses_kind)] ?? String(p.reverses_kind);
    return { kind: "timeline", bullets: [`A ${roleLabel} rolled back action ${a.reverses_seq}, ${what} (action ${a.seq}).`] };
  }
  return null;
}
