// C34: multi-agent reports keep provenance (SPEC 14.6). Stub specialists run in sequence with scoped tools as the
// agent principal; every finding cites result IDs stored in the WorkspaceAgent; a proposal references a deterministic
// generator, never authored content; the merge is deterministic; a model's report that types a number or cites
// another specialist's result is rejected.
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { AliasEntry, AliasMap } from "../../src/shared/grounding/aliases";
import { mergeRuns } from "../../src/worker/agents/investigation/merge";
import { GENERATORS, validateReport } from "../../src/worker/agents/investigation/report";
import type { SpecialistRun } from "../../src/worker/agents/investigation/run";
import { SPECIALIST_NAMES } from "../../src/worker/agents/investigation/specialists";
import { json, P } from "../helpers/api";

const ws = () => getAgentByName(env.WORKSPACE_AGENT, "larkspur");

interface Inv {
  investigation_id: string;
  status: string;
  specialists: { specialist: string; outcome: string; calls: { alias: string | null; tool: string; result_id: string | null; refused: string | null }[] }[];
  merged: { findings: { specialist: string; severity: string; evidence: string[]; claim: string; rendered: string }[]; proposals: { generator: string; proposed_by: string[]; subject_id: string | null }[]; rendered: string; grounded: boolean };
}

async function investigate(): Promise<Inv> {
  const w = await ws();
  const id = (await w.startInvestigation({ routine_id: "RTN-TEST", run_id: "R-2026-10-01#1", incident_id: null, reason: "held", failing: ["C01", "C02", "C03"], lineage: ["stg_payroll__lines", "int_comp__annualized"] })) as unknown as string;
  for (const name of SPECIALIST_NAMES) await w.runSpecialist(id, name);
  await w.mergeInvestigation(id);
  return (await w.getInvestigation(id)) as unknown as Inv;
}

describe("multi-agent investigation", () => {
  it("runs the three specialists in order with their own tools and cites stored results", async () => {
    const inv = await investigate();
    expect(inv.status).toBe("done");
    expect(inv.specialists.map((s) => s.specialist)).toEqual(["data_quality", "model", "composition"]);
    expect(inv.specialists.every((s) => s.outcome === "template")).toBe(true);
    const tools = Object.fromEntries(inv.specialists.map((s) => [s.specialist, s.calls.map((c) => c.tool)]));
    expect(tools).toEqual({ data_quality: ["data_quality_status", "trace_lineage"], model: ["backtest_summary"], composition: ["explain_change", "workforce_flows"] });
    // aliases continue across specialists, so the merged narrative can cite any of them
    const aliases = inv.specialists.flatMap((s) => s.calls.map((c) => c.alias).filter(Boolean));
    expect(aliases).toEqual(aliases.map((_, i) => `r${i + 1}`));
    expect(inv.merged.findings.length).toBeGreaterThanOrEqual(4);
    const w = await ws();
    for (const f of inv.merged.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      for (const id of f.evidence) expect(await w.getResult(id)).not.toBeNull();
      expect(f.rendered).not.toMatch(/\{\{/);
    }
    // most severe first (before an arrival every check passes, so the lineage warning leads here; the routine tests
    // see the failing checks lead)
    const rank: Record<string, number> = { critical: 0, warn: 1, info: 2 };
    const ranks = inv.merged.findings.map((f) => rank[f.severity]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(inv.merged.findings[0]).toMatchObject({ severity: "warn", specialist: "data_quality" });
    expect(inv.merged.rendered).toContain("most severe first");
  });

  it("points at the deterministic mapping generator and never authors a proposal", async () => {
    const inv = await investigate();
    expect(inv.merged.proposals).toEqual([{ kind: "mapping", generator: GENERATORS.mapping, evidence: expect.any(Array), proposed_by: ["data_quality"], subject_id: null }]);
    expect(JSON.stringify(inv.merged.proposals)).not.toMatch(/ANN|multiplier|payroll@2/);
  });

  it("merges deterministically: the same reports in any order give the same result, duplicates once", () => {
    const entry = (alias: string, tool: string, values: unknown): AliasEntry => ({ alias, result_id: `res_${alias}`, tool, values, step: null });
    const aliases: AliasMap = new Map([
      ["r1", entry("r1", "data_quality_status", { failing: ["C01"], warnings: [], checks: 11, passing: 10, source: "all" })],
      ["r2", entry("r2", "backtest_summary", { coverage80: 0.8 })],
    ]);
    const run = (specialist: SpecialistRun["specialist"], findings: SpecialistRun["report"]["findings"]): SpecialistRun => ({ specialist, title: specialist, provider: "stub", outcome: "template", calls: [], aliases: [], report: { specialist, findings, proposals: [] }, problems: [], ms: 0 });
    const f = (claim: string, severity: "critical" | "warn" | "info", evidence: string[]) => ({ claim, rendered: claim, severity, evidence, aliases: [] });
    const runs = [
      run("composition", [f("b", "info", ["res_r2"])]),
      run("data_quality", [f("a", "critical", ["res_r1"])]),
      run("model", [f("c", "info", ["res_r2"]), f("d", "warn", ["res_r1", "res_r2"])]),
    ];
    const a = mergeRuns(runs, aliases);
    const b = mergeRuns([...runs].reverse(), aliases);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // the duplicate evidence set {res_r2} is kept once, from the earlier specialist in the fixed order
    expect(a.findings.map((x) => [x.claim, x.specialist])).toEqual([["a", "data_quality"], ["d", "model"], ["c", "model"]]);
  });

  it("rejects a model report that types a number or cites a result it did not produce", () => {
    const aliases: AliasMap = new Map([
      ["r1", { alias: "r1", result_id: "res_1", tool: "backtest_summary", values: { coverage80: 0.58, observed_over_expected: 0.88 }, step: null }],
      ["r2", { alias: "r2", result_id: "res_2", tool: "data_quality_status", values: { failing: ["C01"] }, step: null }],
    ]);
    const ctx = { question: "", toolArgs: [] };
    const ok = validateReport("model", '{"findings": [{"claim": "The 80% range held {{r1.coverage80|pct}} of the time.", "severity": "warn", "evidence": ["r1"]}]}', aliases, ["r1"], ctx);
    expect(ok.report?.findings[0]).toMatchObject({ evidence: ["res_1"], rendered: "The 80% range held 58% of the time." });
    const typed = validateReport("model", '{"findings": [{"claim": "The 80% range held 75% of the time.", "severity": "warn", "evidence": ["r1"]}]}', aliases, ["r1"], ctx);
    expect(typed.report).toBeNull();
    const foreign = validateReport("model", '{"findings": [{"claim": "Checks failed.", "severity": "critical", "evidence": ["r2"]}]}', aliases, ["r1"], ctx);
    expect(foreign.problems[0]).toContain("not one of your results");
    expect(validateReport("model", "not json", aliases, ["r1"], ctx).report).toBeNull();
  });

  it("is readable by analysts, leads and data engineers only", async () => {
    await investigate();
    const list = await json<{ investigations: { investigation_id: string }[] }>("/api/investigations", { as: P.dataEng });
    expect(list.investigations.length).toBeGreaterThan(0);
    expect((await json<{ code?: string }>("/api/investigations", { as: P.hrbpEng })).code).toBe("NOT_PERMITTED");
    expect((await json<{ code?: string }>(`/api/investigations/${list.investigations[0]!.investigation_id}`, { as: P.auditor })).code).toBe("NOT_PERMITTED");
  });
});
