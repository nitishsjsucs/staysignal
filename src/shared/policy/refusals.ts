// Refusal codes (SPEC 14.3) with the message shown to the user. A refusal is an answer, not an error: it is audited
// and rendered with its rule.
export type RefusalCode =
  | "INDIVIDUAL_LEVEL"
  | "MANAGER_LEVEL"
  | "PROTECTED_ATTRIBUTE"
  | "OUT_OF_SCOPE"
  | "SMALL_COHORT"
  | "NOT_ASSIGNED"
  | "COMPLEMENT_RISK"
  | "DIFFERENCING_RISK"
  | "BUDGET_EXHAUSTED"
  | "NOT_PERMITTED";

export interface Refusal {
  refused: true;
  code: RefusalCode;
  message: string;
}

export const REFUSAL_MESSAGES: Record<RefusalCode, string> = {
  INDIVIDUAL_LEVEL: "StaySignal works at the cohort level only. There is no individual score to show, and no individual is ranked, listed or described.",
  MANAGER_LEVEL: "StaySignal does not single out a manager's team. Team-level views are for planning and are never an evaluation of a manager.",
  PROTECTED_ATTRIBUTE: "StaySignal does not use or report by protected attributes such as sex, race, ethnicity, age, disability or national origin.",
  OUT_OF_SCOPE: "That is outside StaySignal's scope: cohort-level workforce planning on Larkspur's synthetic data.",
  SMALL_COHORT: "That cohort is too small to show safely (cohorts under 10 people are hidden; comparisons over time need 50 or more).",
  NOT_ASSIGNED: "That organization is not assigned to you.",
  COMPLEMENT_RISK: "That question would reveal a small group by subtraction from a larger one, so it is not answered.",
  DIFFERENCING_RISK: "That comparison would reveal fewer than 10 people who joined or left, so it is not served.",
  BUDGET_EXHAUSTED: "Today's model budget is used up. Charts from the buttons still work.",
  NOT_PERMITTED: "Your role does not include that action.",
};

export function refuse(code: RefusalCode, detail?: string): Refusal {
  return { refused: true, code, message: detail ? `${REFUSAL_MESSAGES[code]} ${detail}` : REFUSAL_MESSAGES[code] };
}

export function isRefusal(x: unknown): x is Refusal {
  return typeof x === "object" && x !== null && (x as { refused?: unknown }).refused === true;
}
