// Deterministic pre-router (SPEC 14.3): refuses before any model call questions that name or describe a single
// person, single out a manager's team, ask by a protected attribute, ask the analyst to make a decision, or fall
// outside cohort-level workforce analytics. Patterns follow PeopleLens worker/src/planner/values.ts (MIT). The model may refuse too; the eval
// measures both layers.
import type { RefusalCode } from "../policy/refusals";

export interface PreRoute {
  code: RefusalCode;
  rule: string;
}

const INDIVIDUAL: RegExp[] = [
  /\bwhich\s+(?:\w+\s+){0,3}(?:engineers?|employees?|people|persons?|individuals?|staff(?:ers)?|reps?|workers?|members?|analysts?|managers?|designers?|developers?)\b[^?]*\b(?:quit|leave|leaving|resign|depart|likely|at risk|risk|flight)/i,
  /\bwho\s+(?:is|are|will|might|could)\s+(?:most\s+|the\s+most\s+)?(?:likely\s+to\s+)?(?:quit|leave|resign|depart|go)\b/i,
  /\bwho\s+(?:is|are)\s+(?:at\s+risk|a\s+risk)/i,
  /\bwho\s+(?:is|are)\s+the\s+(?:people|employees|staff|ones|persons?)\s+(?:most\s+)?(?:at\s+risk|likely)/i,
  /\b(?:list|name|show|identify|rank|flag)\s+(?:me\s+)?(?:the\s+)?(?:top\s+\d+\s+)?(?:employees?|people|individuals|persons?|engineers?|staff)\b/i,
  /\b(?:individual|person(?:al)?|employee)[-\s](?:level\s+)?(?:risk|scores?|probabilit(?:y|ies)|predictions?)\b/i,
  /\brisk\s+scores?\s+(?:for|of)\s+(?:each|every|an?|this|that)\s+(?:employee|person|individual)/i,
  /\bE\d{6}\b/,
  /\b(?:the|this|that)\s+(?:person|employee|individual)\s+who\b/i,
  /\bis\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:going|likely|about)\s+to\s+(?:quit|leave|resign)/,
  /\b(?:his|her)\s+(?:risk|probability|chance)\s+of\s+leaving\b/i,
  // raw extract rows are one row per person
  /\b(?:raw|row[-\s]level|unaggregated)\s+(?:\w+\s+){0,2}(?:rows?|records?|extracts?|tables?)\b/i,
];

const MANAGER: RegExp[] = [
  /\bwhich\s+manager'?s?\b/i,
  /\bmanagers?'?s?\s+teams?\s+(?:is|are)?\s*(?:most\s+)?(?:at\s+risk|likely|worst)/i,
  /\b(?:rank|compare|score)\s+(?:the\s+)?managers\b/i,
  /\b(?:worst|best|bad|weakest)\s+managers?\b/i,
  /\bteams?\s+(?:of|under)\s+(?:which|what)\s+manager/i,
];

const PROTECTED: RegExp[] = [
  /\b(?:gender|sex|women|woman|men\b|female|male|nonbinary|non-binary)\b/i,
  /\b(?:race|racial|ethnicity|ethnic|black|hispanic|latino|latina|latinx|asian|white employees|caucasian)\b/i,
  /\b(?:age\s+(?:group|band|bracket)|older\s+(?:workers|employees|people)|younger\s+(?:workers|employees|people)|over\s+40|under\s+30|by\s+age)\b/i,
  /\b(?:disabilit(?:y|ies)|disabled|religio(?:n|us)|national\s+origin|nationality|immigra(?:nt|tion)|veterans?|sexual\s+orientation|lgbt\w*|pregnan\w*|parental\s+status|marital)\b/i,
];

const OUT_OF_SCOPE: RegExp[] = [
  /\b(?:weather|stock\s+price|bitcoin|crypto(?:currency)?|recipe|poem|song|lyrics|joke|sports?\s+score|horoscope)\b/i,
  /\b(?:write|generate)\s+(?:me\s+)?(?:a\s+)?(?:poem|story|essay|song|python|javascript|code|sql)\b/i,
  /\bperformance\s+(?:ratings?|reviews?|scores?)\b/i,
  /\b(?:keystrokes?|screen\s+monitoring|location\s+tracking|email\s+monitoring|social\s+media)\b/i,
  /\bignore\s+(?:all\s+|the\s+|your\s+)?(?:previous\s+|prior\s+)?(?:instructions|rules)\b/i,
  /\b(?:forget|disregard|override|bypass|skip)\s+(?:all\s+|the\s+|your\s+|any\s+)?(?:previous\s+|prior\s+)?(?:policy|policies|rules|instructions|guardrails|restrictions|checks)\b/i,
  /\b(?:fire|terminate|lay\s*off|let\s+go\s+of)\s+(?:someone|people|employees|staff|them|him|her)\b/i,
  /\b(?:who|which\s+(?:\w+\s+){0,2}(?:employees?|people|staff|engineers?))\s+should\s+(?:we|i)\s+(?:fire|terminate|lay\s*off|let\s+go)\b/i,
];

// Decisions belong to a person with the right in the app (SPEC 14.6): the analyst never approves, rejects, publishes
// or rolls back anything, whatever the question says. The verb must be a command (sentence start, or after "and",
// "then", "please", "now" or "just"), so "Who can approve a review?" still reaches the model.
const DECISION: RegExp[] = [
  /(?:^|[.;:!]\s*|\b(?:and|then|please|now|just)\s+)(?:approve|reject|publish|unpublish|roll\s*back)\s+(?:the\s+|this\s+|that\s+|all\s+|every\s+)?(?:pending\s+|open\s+|latest\s+|held\s+)?(?:\w+\s+){0,3}(?:proposals?|reviews?|runs?|mappings?|repairs?|actions?|changes?|requests?|drafts?)\b/i,
];

export function preRoute(question: string): PreRoute | null {
  const q = question.trim();
  for (const re of DECISION) if (re.test(q)) return { code: "NOT_PERMITTED", rule: re.source };
  for (const re of MANAGER) if (re.test(q)) return { code: "MANAGER_LEVEL", rule: re.source };
  for (const re of INDIVIDUAL) if (re.test(q)) return { code: "INDIVIDUAL_LEVEL", rule: re.source };
  for (const re of PROTECTED) if (re.test(q)) return { code: "PROTECTED_ATTRIBUTE", rule: re.source };
  for (const re of OUT_OF_SCOPE) if (re.test(q)) return { code: "OUT_OF_SCOPE", rule: re.source };
  return null;
}
