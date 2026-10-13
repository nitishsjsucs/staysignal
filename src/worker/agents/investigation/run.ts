// One specialist's run (SPEC 14.6): its scoped tools through the governed registry (the same authorization, rounding
// and result IDs as everywhere else), at most 4 steps, then a validated report with one repair and the template
// fallback. Aliases continue the investigation's numbering (r1, r2, ... across specialists), so the merged narrative
// can cite any result. The stub, and the recorded provider (no specialist turns are recorded), call the plan.
import { generateText, isStepCount, type ModelMessage, type Tool } from "ai";
import type { AliasEntry, AliasMap } from "../../../shared/grounding/aliases";
import { isRefusal } from "../../../shared/policy/refusals";
import { getTool, runTool, type ToolContext, toolsFor } from "../../../shared/tools/registry";
import { LOCAL_URLS, openAiCompatible, type ProviderName } from "../providers";
import { REPORT_INSTRUCTIONS, type SpecialistReport, templateReport, validateReport } from "./report";
import { briefText, type InvestigationBrief, MAX_STEPS, type SpecialistDef } from "./specialists";

export interface SpecialistCall {
  alias: string | null;
  tool: string;
  args: Record<string, unknown>;
  result_id: string | null;
  refused: string | null;
}

export interface SpecialistRun {
  specialist: SpecialistDef["name"];
  title: string;
  provider: ProviderName;
  outcome: "passed" | "repaired" | "template";
  calls: SpecialistCall[];
  aliases: AliasEntry[]; // the entries this specialist added
  report: SpecialistReport;
  problems: string[];
  ms: number;
}

const usesPlan = (p: ProviderName) => p === "stub" || p === "recorded" || p === "workers-ai";

export async function runSpecialist(ctx: ToolContext, provider: ProviderName, def: SpecialistDef, brief: InvestigationBrief, prior: AliasMap): Promise<SpecialistRun> {
  const t0 = Date.now();
  const aliases: AliasMap = new Map(prior);
  const own: string[] = [];
  const calls: SpecialistCall[] = [];
  const toolArgs: unknown[] = [];
  const allowed = new Set<string>(toolsFor(ctx.principal).map((t) => t.name).filter((n) => def.tools.includes(n)));
  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    toolArgs.push(args);
    if (!allowed.has(tool)) {
      calls.push({ alias: null, tool, args, result_id: null, refused: "NOT_PERMITTED" });
      return { refused: true, code: "NOT_PERMITTED", message: "Not one of this specialist's tools." };
    }
    const out = await runTool(ctx, tool, args);
    if (isRefusal(out)) {
      calls.push({ alias: null, tool, args, result_id: null, refused: out.code });
      return { refused: true, code: out.code, message: out.message };
    }
    const alias = `r${aliases.size + 1}`;
    aliases.set(alias, { alias, result_id: out.result_id, tool, values: out.values, step: out.rounding?.step ?? null });
    own.push(alias);
    calls.push({ alias, tool, args, result_id: out.result_id, refused: null });
    return getTool(tool)?.digest(out, alias);
  };

  let outcome: SpecialistRun["outcome"] = "template";
  let report: SpecialistReport | null = null;
  let problems: string[] = [];
  if (usesPlan(provider)) {
    for (const p of def.plan(brief).slice(0, MAX_STEPS)) await call(p.tool, p.args);
  } else {
    const model = openAiCompatible(provider as "llama" | "mlx", LOCAL_URLS[provider as "llama" | "mlx"]);
    const tools: Record<string, Tool> = {};
    for (const name of allowed) {
      const t = getTool(name)!;
      tools[name] = { description: t.description, inputSchema: t.input as never, execute: async (args: Record<string, unknown>) => call(name, args) } as unknown as Tool;
    }
    const system = `${def.prompt}\n${REPORT_INSTRUCTIONS}`;
    const messages: ModelMessage[] = [{ role: "user", content: briefText(brief) }];
    const res = await generateText({ model, system, messages, tools, stopWhen: isStepCount(MAX_STEPS + 1), temperature: 0, maxOutputTokens: 600 });
    const context = { question: briefText(brief), toolArgs };
    let v = validateReport(def.name, res.text, aliases, own, context);
    if (v.report) {
      outcome = "passed";
    } else {
      problems = v.problems;
      const repair = await generateText({
        model,
        system,
        messages: [...messages, { role: "assistant", content: res.text }, { role: "user", content: `Your report broke these rules:\n- ${v.problems.join("\n- ")}\nYour results: ${own.join(", ") || "none"}. Answer with the corrected JSON only.` }],
        temperature: 0,
        maxOutputTokens: 600,
      });
      v = validateReport(def.name, repair.text, aliases, own, context);
      if (v.report) outcome = "repaired";
      else problems = [...problems, ...v.problems];
    }
    report = v.report;
  }
  if (!report) report = templateReport(def.name, aliases, own);
  return {
    specialist: def.name,
    title: def.title,
    provider,
    outcome,
    calls,
    aliases: own.map((a) => aliases.get(a)!),
    report,
    problems,
    ms: Date.now() - t0,
  };
}
