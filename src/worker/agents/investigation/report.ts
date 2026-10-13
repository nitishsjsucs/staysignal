// A specialist's report (SPEC 14.6): findings whose claims carry placeholders only, each citing the results that
// back it, and proposals that point at a deterministic generator's output (a specialist can point at one but never
// author its content). Validated with zod; a model's report gets one repair, then the template report built from the
// tool results.
import { z } from "zod";
import { type AliasMap, renderPlaceholders } from "../../../shared/grounding/aliases";
import { checkGrounding } from "../../../shared/grounding/check";
import { templateAnswer } from "../../../shared/grounding/template";
import type { SpecialistName } from "./specialists";

export const SEVERITIES = ["critical", "warn", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Deterministic generators a specialist may point at; the content always comes from the generator. */
export const GENERATORS = { mapping: "quality/mapping_proposal.py" } as const;

export const ModelReport = z.object({
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(400),
        severity: z.enum(SEVERITIES),
        evidence: z.array(z.string().min(1)).min(1).max(6),
      }),
    )
    .max(6),
  proposals: z.array(z.object({ kind: z.literal("mapping") })).max(1).default([]),
});

export const REPORT_INSTRUCTIONS = [
  "When you are done, answer with JSON only, in this shape:",
  '{"findings": [{"claim": "...", "severity": "critical" | "warn" | "info", "evidence": ["r1"]}], "proposals": [{"kind": "mapping"}]}',
  "Each claim is one sentence; write every number as a placeholder such as {{r1.failing.0}} or {{r1.coverage80|pct}}. Evidence lists the aliases the claim rests on.",
  'Add {"kind": "mapping"} to proposals only when the evidence points at the payroll pay-basis mapping; the mapping change itself is generated deterministically, never by you.',
].join("\n");

export interface Finding {
  claim: string;
  rendered: string;
  severity: Severity;
  evidence: string[]; // result IDs
  aliases: string[];
}

export interface ProposalRef {
  kind: "mapping";
  generator: string;
  evidence: string[];
}

export interface SpecialistReport {
  specialist: SpecialistName;
  findings: Finding[];
  proposals: ProposalRef[];
}

function sevFor(tool: string, values: Record<string, unknown>): Severity {
  if (tool === "data_quality_status") return ((values.failing as unknown[]) ?? []).length ? "critical" : ((values.warnings as unknown[]) ?? []).length ? "warn" : "info";
  if (tool === "trace_lineage") return "warn";
  return "info";
}

function pointsAtMapping(tool: string, values: Record<string, unknown>): boolean {
  if (tool !== "trace_lineage") return false;
  const nodes = [...((values.path as string[]) ?? []), ...(((values.ranking as { node: string }[]) ?? []).slice(0, 1).map((r) => r.node))];
  return nodes.some((n) => /pay_basis|stg_map__/.test(n));
}

/** The deterministic report: one finding per tool result, worded by the same templates as the chat's fallback. */
export function templateReport(specialist: SpecialistName, aliases: AliasMap, own: string[]): SpecialistReport {
  const findings: Finding[] = [];
  const proposals: ProposalRef[] = [];
  for (const alias of own) {
    const a = aliases.get(alias);
    if (!a) continue;
    const values = (a.values ?? {}) as Record<string, unknown>;
    const claim = templateAnswer([{ alias, tool: a.tool, values }]);
    findings.push({ claim, rendered: renderPlaceholders(claim, aliases).text, severity: sevFor(a.tool, values), evidence: [a.result_id], aliases: [alias] });
    if (pointsAtMapping(a.tool, values) && !proposals.length) proposals.push({ kind: "mapping", generator: GENERATORS.mapping, evidence: [a.result_id] });
  }
  return { specialist, findings, proposals };
}

export interface Validation {
  report: SpecialistReport | null;
  problems: string[];
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Checks a model's report: the shape, evidence that names this specialist's own results, and grounded claims. */
export function validateReport(specialist: SpecialistName, text: string, aliases: AliasMap, own: string[], context: { question: string; toolArgs: unknown[] }): Validation {
  const parsed = ModelReport.safeParse(extractJson(text));
  if (!parsed.success) return { report: null, problems: [`not a valid report: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`] };
  const problems: string[] = [];
  const findings: Finding[] = [];
  for (const [i, f] of parsed.data.findings.entries()) {
    const evidence = f.evidence.map((e) => (aliases.has(e) && own.includes(e) ? e : [...aliases.values()].find((a) => a.result_id === e && own.includes(a.alias))?.alias ?? null));
    if (evidence.some((e) => e === null)) {
      problems.push(`finding ${i + 1} cites evidence that is not one of your results`);
      continue;
    }
    const scoped: AliasMap = new Map(own.map((a) => [a, aliases.get(a)!]));
    const g = checkGrounding({ text: f.claim, aliases: scoped, question: context.question, toolArgs: context.toolArgs });
    if (!g.ok) {
      problems.push(`finding ${i + 1}: ${g.violations.join("; ")}`);
      continue;
    }
    const used = evidence as string[];
    findings.push({ claim: f.claim, rendered: renderPlaceholders(f.claim, aliases).text, severity: f.severity, evidence: used.map((a) => aliases.get(a)!.result_id), aliases: used });
  }
  if (problems.length) return { report: null, problems };
  const lineage = own.map((a) => aliases.get(a)!).filter((a) => pointsAtMapping(a.tool, (a.values ?? {}) as Record<string, unknown>));
  const proposals: ProposalRef[] = parsed.data.proposals.length && lineage.length ? [{ kind: "mapping", generator: GENERATORS.mapping, evidence: [lineage[0]!.result_id] }] : [];
  return { report: { specialist, findings, proposals }, problems: [] };
}
