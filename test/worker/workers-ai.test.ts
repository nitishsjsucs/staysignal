// The production model path (SPEC 14.11, C48 gateway headers): Workers AI through AI Gateway with metadata-only
// logging and allowlisted metadata, the /no_think switch, <think> blocks stripped, and the daily neuron budget
// reserved before the call and settled from usage, refusing with BUDGET_EXHAUSTED when the cap would be exceeded.
// The gateway is a mocked fetch: nothing leaves the test.
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/shared/canonical-json";
import { localPrincipal } from "../../src/shared/policy/roles";
import { runTurn } from "../../src/worker/agents/turn";
import { aigMetadata, gatewayBaseUrl, gatewayHeaders, neuronsFor, NO_THINK, PRODUCTION_MODEL, stripThink, TURN_CEILING, type WorkersAiConfig } from "../../src/worker/agents/workers-ai";
import { workspaceStub } from "../../src/worker/agents/workspace-port";
import { sha256HexSync } from "../../src/worker/store/chain";
import { warehouseFor } from "../../src/worker/warehouse/client";

const CFG: WorkersAiConfig = { accountId: "acct0", gatewayId: "staysignal", token: "tok-test", model: PRODUCTION_MODEL, dailyNeuronCap: 1500 };

describe("gateway headers and model hygiene", () => {
  it("logs metadata only, with at most five allowlisted id-like keys", () => {
    const h = gatewayHeaders(CFG, { route: "chat", role: "people_analyst", request_hash: "abc123" });
    expect(h["cf-aig-collect-log-payload"]).toBe("false");
    expect(JSON.parse(h["cf-aig-metadata"]!)).toEqual({ route: "chat", role: "people_analyst", request_hash: "abc123" });
    expect(h.authorization).toBe("Bearer tok-test");
    const filtered = JSON.parse(aigMetadata({ route: "chat", question: "How many will leave Engineering?", email: "a@b.example", tool: "has spaces", role: "x".repeat(65), eval_run: 7 }));
    expect(filtered).toEqual({ route: "chat", eval_run: 7 });
    expect(gatewayBaseUrl(CFG)).toBe("https://gateway.ai.cloudflare.com/v1/acct0/staysignal/workers-ai/v1");
  });

  it("strips reasoning and prices tokens at the pinned rates", () => {
    expect(stripThink("<think>scratch work</think>Answer.")).toBe("Answer.");
    expect(stripThink("Answer.<think>never closed")).toBe("Answer.");
    expect(neuronsFor(PRODUCTION_MODEL, { input: 1_000_000, output: 0 })).toBe(4627);
    expect(neuronsFor(PRODUCTION_MODEL, { input: 0, output: 1_000_000 })).toBe(30454);
    expect(neuronsFor("@cf/unknown/model", { input: 1, output: 1 })).toBeNull();
    // the worst case of one turn fits the daily cap a few times, never once more than the cap
    const turn = neuronsFor(PRODUCTION_MODEL, TURN_CEILING)!;
    expect(turn).toBeGreaterThan(100);
    expect(turn * 4).toBeLessThan(1500);
  });
});

describe("the daily neuron budget", () => {
  it("reserves under the cap, refuses beyond it and settles to actual usage", async () => {
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "budget-test");
    const a = (await ws.reserveNeurons(600, 1000)) as unknown as { ok: boolean; used: number; day: string };
    expect(a).toMatchObject({ ok: true, used: 600 });
    expect(((await ws.reserveNeurons(500, 1000)) as unknown as { ok: boolean }).ok).toBe(false);
    await ws.settleNeurons(a.day, 600, 120);
    expect(await ws.neuronUsage(a.day)).toBe(120);
    expect(((await ws.reserveNeurons(500, 1000)) as unknown as { ok: boolean; used: number }).used).toBe(620);
    await ws.settleNeurons(a.day, 500, null); // unknown usage keeps the reservation
    expect(await ws.neuronUsage(a.day)).toBe(620);
  });
});

function completion(message: Record<string, unknown>, finish: string, usage: { prompt: number; completion: number }) {
  return Response.json({ id: "cmpl", object: "chat.completion", created: 0, model: PRODUCTION_MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } });
}

describe("a turn on the production model", () => {
  const p = localPrincipal("pa-analyst@larkspur.example")!;
  const ctx = () => ({ principal: p, warehouse: warehouseFor(env), workspace: workspaceStub(env), sha256: async (t: string) => sha256HexSync(t), canonical: canonicalJson });

  it("calls the gateway with metadata-only logging and /no_think, strips reasoning and settles the budget", async () => {
    const requests: { url: string; headers: Headers; body: { messages: { role: string; content: string }[] } }[] = [];
    const replies = [
      completion({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "forecast_departures", arguments: JSON.stringify({ cohort: "Engineering", horizon_months: 3 }) } }] }, "tool_calls", { prompt: 3000, completion: 40 }),
      completion({ role: "assistant", content: "<think>check the alias</think>For Engineering (synthetic data), StaySignal expects {{r1.expected}} voluntary departures." }, "stop", { prompt: 3200, completion: 60 }),
    ];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return replies.shift()!;
    }) as typeof fetch;
    const budget = { reserved: 0, settled: null as number | null, reserve: async (n: number, cap: number) => ({ ok: true, used: (budget.reserved = n), cap }), settle: async (_r: number, actual: number | null) => void (budget.settled = actual) };
    const out = await runTurn(ctx(), "workers-ai", "How many people will leave Engineering in the next 3 months?", [], {}, { workersAi: CFG, budget, meta: { route: "chat", role: p.role }, fetch: fakeFetch });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.url).toBe("https://gateway.ai.cloudflare.com/v1/acct0/staysignal/workers-ai/v1/chat/completions");
    expect(requests[0]!.headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(JSON.parse(requests[0]!.headers.get("cf-aig-metadata")!)).toEqual({ route: "chat", role: "people_analyst" });
    expect(requests[0]!.body.messages[0]!.content.trimEnd().endsWith(NO_THINK)).toBe(true);
    expect(out.tool_calls.map((c) => c.tool)).toEqual(["forecast_departures"]);
    expect(out.text).not.toContain("<think>");
    expect(out.grounding).toBe("passed");
    expect(budget.reserved).toBe(neuronsFor(PRODUCTION_MODEL, TURN_CEILING));
    expect(budget.settled).toBe(neuronsFor(PRODUCTION_MODEL, { input: 6200, output: 100 }));
  });

  it("refuses with BUDGET_EXHAUSTED before calling the model when the cap would be exceeded", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    const out = await runTurn(ctx(), "workers-ai", "Forecast Engineering over 90 days.", [], {}, { workersAi: CFG, budget: { reserve: async (_n, cap) => ({ ok: false, used: cap, cap }), settle: async () => {} }, fetch: fakeFetch });
    expect(out.refusal).toMatchObject({ code: "BUDGET_EXHAUSTED", layer: "budget" });
    expect(called).toBe(false);
  });
});
