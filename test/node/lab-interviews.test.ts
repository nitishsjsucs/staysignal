// The interview recorder (npm run lab:interviews, SPEC 15.8): which answers it refuses to write, how it merges them
// into lab/interviews.json, and that the recorded answers get the generated-text hygiene checks.
import { describe, expect, it } from "vitest";
import { answerProblem, mergeAnswers, type RecordedAnswer } from "../../scripts/lab-interviews.ts";
import { isGenerated } from "../../scripts/lib/hygiene.ts";

const q1 = { proposal: "infra-data-merge", persona_id: "P02", question: "What would you want to know before this change starts?" };
const q2 = { proposal: "promotion-criteria-third-window", persona_id: "P05", question: "What would you want to know before this change starts?" };
const rec = (q: typeof q1, answer: string): RecordedAnswer => ({ ...q, answer, model: "Qwen3.6-27B", recorded_at: "2026-10-13" });

describe("lab:interviews", () => {
  it("records only complete, clean model text", () => {
    expect(answerProblem("I would want to know who decides. Then I would ask about timing.")).toBeNull();
    expect(answerProblem("  ")).toBe("empty answer");
    expect(answerProblem("[stub] Speaking only for this synthetic persona.")).toBe("stub text");
    expect(answerProblem("I would want to know who decides and how the")).toBe("cut off by the 100-token cap");
    expect(answerProblem(`I would want to know ${String.fromCharCode(0x2014)} who decides.`)).toMatch(/^hygiene: .*dash/);
    expect(answerProblem("Would this mean keystroke logging for everyone?")).toMatch(/^hygiene: .*monitoring-term/);
  });

  it("replaces an answer to the same question and keeps the question order", () => {
    const merged = mergeAnswers([rec(q2, "Old."), rec(q1, "Kept.")], [rec(q2, "New.")], [q1, q2]);
    expect(merged.map((a) => a.answer)).toEqual(["Kept.", "New."]);
  });

  it("treats the recorded answers as generated text", () => {
    expect(isGenerated("lab/interviews.json")).toBe(true);
  });
});
