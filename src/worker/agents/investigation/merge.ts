// The investigation's merge (SPEC 14.6), deterministic: the union of the specialists' findings, deduplicated by their
// evidence set, ordered by severity (then specialist order, then claim), each tagged with its specialist; proposals
// deduplicated by generator. The orchestrator's narrative is written from the merged findings with placeholders and
// checked like any answer (14.4).
import type { AliasMap } from "../../../shared/grounding/aliases";
import { checkGrounding } from "../../../shared/grounding/check";
import { renderPlaceholders } from "../../../shared/grounding/aliases";
import type { Finding, ProposalRef, Severity } from "./report";
import type { SpecialistRun } from "./run";
import { SPECIALIST_NAMES, type SpecialistName, specialist } from "./specialists";

export interface MergedFinding extends Finding {
  specialist: SpecialistName;
}

export interface MergedProposal extends ProposalRef {
  proposed_by: SpecialistName[];
  subject_id: string | null; // set when the routine drafts the generator's output as an approval
}

export interface Merged {
  findings: MergedFinding[];
  proposals: MergedProposal[];
  narrative: string;
  rendered: string;
  grounded: boolean;
}

const RANK: Record<Severity, number> = { critical: 0, warn: 1, info: 2 };

export function mergeRuns(runs: SpecialistRun[], aliases: AliasMap): Merged {
  const ordered = [...runs].sort((a, b) => SPECIALIST_NAMES.indexOf(a.specialist) - SPECIALIST_NAMES.indexOf(b.specialist));
  const all: MergedFinding[] = ordered.flatMap((r) => r.report.findings.map((f) => ({ ...f, specialist: r.specialist })));
  all.sort((a, b) => RANK[a.severity] - RANK[b.severity] || SPECIALIST_NAMES.indexOf(a.specialist) - SPECIALIST_NAMES.indexOf(b.specialist) || a.claim.localeCompare(b.claim));
  const seen = new Set<string>();
  const findings: MergedFinding[] = [];
  for (const f of all) {
    const key = [...f.evidence].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }
  const proposals: MergedProposal[] = [];
  for (const r of ordered) {
    for (const p of r.report.proposals) {
      const existing = proposals.find((x) => x.generator === p.generator);
      if (existing) {
        if (!existing.proposed_by.includes(r.specialist)) existing.proposed_by.push(r.specialist);
        existing.evidence = [...new Set([...existing.evidence, ...p.evidence])].sort();
      } else {
        proposals.push({ ...p, evidence: [...p.evidence].sort(), proposed_by: [r.specialist], subject_id: null });
      }
    }
  }
  // no typed numbers: counts are shown by the UI from the findings themselves; the narrative cites results only
  const top = findings[0];
  const narrative = [
    "The specialists ran one after another; their findings are listed most severe first.",
    top ? `Most severe, from the ${specialist(top.specialist)?.title.toLowerCase() ?? top.specialist}: ${top.claim}` : "",
    proposals.length ? `They point at the deterministic ${proposals.map((p) => p.kind).join(" and ")} proposal; a person decides.` : "No change is proposed.",
  ]
    .filter(Boolean)
    .join(" ");
  const g = checkGrounding({ text: narrative, aliases, question: "", toolArgs: [] });
  return { findings, proposals, narrative, rendered: renderPlaceholders(narrative, aliases).text, grounded: g.ok };
}
