// ADR 0018: a sandbox starts from the committed demo state, its alarm at the expiry deletes everything it stored, a
// sandbox object woken after that seeds nothing and schedules its own cleanup, and the chat replays recorded turns
// for the recorded questions and the labeled stub for anything else, with no model and no outbound request.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localPrincipal } from "../../src/shared/policy/roles";
import { STUB_LABEL_PUBLIC } from "../../src/shared/provenance";
import type { AnalystAgent } from "../../src/worker/agents/analyst-agent";
import { DEMO_TURN_MESSAGES } from "../../src/worker/agents/analyst-agent";
import { analystName } from "../../src/worker/auth/principal";
import { parseConfig } from "../../src/worker/config";
import type { TurnOutput } from "../../src/worker/agents/turn";

/** The RPC stub types a TurnOutput as never; the value is a plain object. */
const turnOf = async (agent: { turn: (...a: never[]) => unknown }, ...args: unknown[]): Promise<TurnOutput> => (await (agent.turn as (...a: unknown[]) => Promise<unknown>)(...args)) as TurnOutput;
import { demoCall, demoJson, P, resetGate, visit } from "../helpers/demo";

type Me = { principal: { sandbox: { id: string; exp: number } } };
type Sandbox = { admit(units: number): Promise<unknown>; storedBytes(): Promise<number>; listSchedules(): Promise<unknown> };

async function restarted(name: string): Promise<Sandbox> {
  for (let i = 0; i < 20; i++) {
    try {
      return (await getAgentByName(env.WORKSPACE_AGENT, name)) as unknown as Sandbox;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("the sandbox object did not restart");
}

const outbound: string[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    outbound.push(url);
    throw new Error(`outbound request in the public demo: ${url}`);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});
beforeEach(resetGate);
afterEach(() => vi.restoreAllMocks());

describe("a sandbox's life", () => {
  it("starts from the committed demo state with its expiry scheduled", async () => {
    const v = await visit(P.analyst);
    const sb = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const runs = await demoJson<{ published: string; runs: { run_id: string }[] }>("/api/runs", { cookie: v.cookie });
    expect(runs.published).toBe("R-2026-10-01#1");
    expect(runs.runs.map((r) => r.run_id)).toEqual(["R-2026-09-01#1", "R-2026-10-01#1"]);
    const ws = await getAgentByName(env.WORKSPACE_AGENT, `sbx-${sb.id}`);
    const schedules = (await ws.listSchedules()) as unknown as { callback: string; payload: string; time: number }[];
    expect(schedules.map((s) => [s.callback, s.payload])).toEqual([["expireSandbox", "expiry"]]);
    expect(schedules[0]!.time).toBe(sb.exp);
  });

  it("is deleted by its alarm at the expiry; a late wake seeds nothing and cleans itself up", async () => {
    const v = await visit(P.lead);
    const sb = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const name = `sbx-${sb.id}`;
    const ws = await getAgentByName(env.WORKSPACE_AGENT, name);
    const before = await ws.storedBytes();
    // four hours and a minute later
    vi.spyOn(Date, "now").mockReturnValue((sb.exp + 60) * 1000);
    await runDurableObjectAlarm(ws as unknown as DurableObjectStub);
    vi.restoreAllMocks();
    // the destroyed object's isolate is aborted right after; a new one starts on the next call
    const again = await restarted(name);
    expect(await again.admit(1)).toMatchObject({ ok: false, code: "SANDBOX_EXPIRED" });
    // nothing of the workspace is left: only the agents SDK's empty bookkeeping tables of the new instance
    expect(await again.storedBytes()).toBeLessThan(before);
    const tables = await runInDurableObject(env.WORKSPACE_AGENT.get(env.WORKSPACE_AGENT.idFromName(name)), (_i, state) => state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((t) => t.name));
    for (const t of ["meta", "forecast_runs", "action_log", "approval_audit", "reviews", "memory_files", "traces", "results"]) expect(tables).not.toContain(t);
    const schedules = (await again.listSchedules()) as unknown as { callback: string; payload: string }[];
    expect(schedules.map((s) => [s.callback, s.payload])).toEqual([["expireSandbox", "orphan"]]);
    const r = await demoCall("/api/me", { cookie: v.cookie });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ reason: "sandbox_expired" });
  });

  it("deletes the visitor's conversation at the same expiry", async () => {
    const v = await visit(P.lead);
    const sb = (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox;
    const p = { ...localPrincipal(P.lead)!, sandbox: sb };
    const agent = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(parseConfig(env), p));
    await turnOf(agent, p, "Forecast voluntary departures in Engineering over the next 90 days.");
    const schedules = (await agent.listSchedules()) as unknown as { callback: string; time: number }[];
    expect(schedules.map((s) => s.callback)).toEqual(["expireSandbox"]);
    expect(schedules[0]!.time).toBe(sb.exp);
  });
});

describe("the chat in the public demo", () => {
  it("replays the recorded turn for a recorded question, from the author's laptop", async () => {
    const v = await visit(P.lead);
    const p = { ...localPrincipal(P.lead)!, sandbox: (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox };
    const agent = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(parseConfig(env), p));
    const t = await turnOf(agent, p, "Forecast voluntary departures in Engineering over the next 90 days.");
    expect(t).toMatchObject({ provider: "recorded", recorded: true, grounding: "passed" });
    expect(t.label).toMatch(/^Recorded from Qwen3\.6-27B on the author's laptop, \d{4}-\d{2}-\d{2}; replayed\. Tools run live in your sandbox; their numbers come from results exported from the synthetic warehouse\.$/);
    // the trace says the turn was replayed, not generated, and has no token counts
    const model = t.spans.filter((s) => s.kind === "model_call");
    expect(model.map((s) => s.name)).toEqual(["replay: recorded turn"]);
    expect(model[0]).not.toHaveProperty("tokens");
    expect(outbound).toEqual([]);
  });

  it("offers each role only the recorded questions it may run", async () => {
    const asked = async (principal: string) => (await demoJson<{ demo: { recorded_questions: string[] } }>("/api/me", { cookie: (await visit(principal)).cookie })).demo.recorded_questions;
    const lead = await asked(P.lead);
    expect(lead).toContain("Forecast voluntary departures in Engineering over the next 90 days.");
    const gtm = await asked("hrbp-gtm@larkspur.example");
    expect(gtm.length).toBeLessThan(lead.length);
    expect(gtm.some((q) => /Engineering/.test(q))).toBe(false);
    expect(await asked(P.auditor)).not.toContain("Forecast voluntary departures in Engineering over the next 90 days.");
    expect(await asked(P.hrbpEng)).toContain("Forecast voluntary departures in Engineering over the next 90 days.");
  });

  it("answers any other question with the labeled deterministic stub: tools run, no model does", async () => {
    const v = await visit(P.lead);
    const p = { ...localPrincipal(P.lead)!, sandbox: (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox };
    const agent = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(parseConfig(env), p));
    for (const provider of [undefined, "mlx", "llama", "workers-ai"] as const) {
      const t = await turnOf(agent, p, "Forecast voluntary departures in Sales over the next 30 days.", provider);
      expect(t.provider).toBe("stub");
      expect(t.recorded).toBe(false);
      expect(t.label).toBe(STUB_LABEL_PUBLIC);
      expect(t.tool_calls.map((c) => c.tool)).toEqual(["forecast_departures"]);
      expect(["passed", "template"]).toContain(t.grounding);
    }
    // the pre-router still refuses before anything runs
    const refused = await turnOf(agent, p, "Which engineers in Platform Engineering are most likely to quit?");
    expect(refused.refusal?.code).toBe("INDIVIDUAL_LEVEL");
    expect(outbound).toEqual([]);
  });

  it("bounds the question and spends the sandbox's units", async () => {
    const v = await visit(P.lead);
    const p = { ...localPrincipal(P.lead)!, sandbox: (await demoJson<Me>("/api/me", { cookie: v.cookie })).principal.sandbox };
    const agent = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(parseConfig(env), p));
    const long = await turnOf(agent, p, `Forecast ${"x".repeat(600)}`);
    expect(long.text).toBe(DEMO_TURN_MESSAGES.tooLong);
    expect(long.tool_calls).toEqual([]);
    // a turn in an expired sandbox does not run
    const gone = { ...p, sandbox: { id: "abcdefghijklmnopqrst", exp: p.sandbox.exp } };
    const other = await getAgentByName<Env, AnalystAgent>(env.ANALYST_AGENT, await analystName(parseConfig(env), gone));
    expect((await turnOf(other, gone, "Forecast voluntary departures in Engineering over the next 90 days.")).text).toBe(DEMO_TURN_MESSAGES.expired);
  });
});
