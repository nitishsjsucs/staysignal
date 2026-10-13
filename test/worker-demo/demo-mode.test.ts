// The demo replays recorded model output only (the operator's decision of 2026-10-13). This project runs the Worker
// with SS_DEMO=1 and a live model named in SS_LLM (mlx, the 27B on 8186): no path may reach a live provider, the
// engine's live interview or the stub. Every fetch is watched; any request to a model server or the engine fails the
// test. A question without a recording gets the friendly message and the recorded questions, never a stub answer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/worker/config";
import { LAB_LABEL } from "../../src/worker/lab-interview";
import { UNRECORDED_CHAT, UNRECORDED_CHAT_NONE, UNRECORDED_INTERVIEW } from "../../src/shared/provenance";
import { recordedQuestions } from "../../src/worker/agents/recorded-provider";
import { call, json, P } from "../helpers/api";

const live: string[] = [];
const realFetch = globalThis.fetch;
const LIVE = /:(8186|8187|8196)\b|\/lab\/interview$|\/chat\/completions|\/v1\/(models|completions)/;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (LIVE.test(new URL(url, "http://localhost").pathname) || LIVE.test(url)) {
      if (!url.startsWith("http://localhost/api/")) {
        live.push(url);
        throw new Error(`demo mode reached a live provider: ${url}`);
      }
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

type Turn = { text: string; grounding: string; provider: string; recorded: boolean; label: string | null; tool_calls: unknown[]; suggestions?: string[]; spans: { kind: string; name: string }[] };

describe("demo mode configuration", () => {
  it("replays recordings whatever SS_LLM names", () => {
    const cfg = parseConfig({ SS_DEMO: "1", SS_LLM: "mlx" } as unknown as Env);
    expect(cfg).toMatchObject({ demo: true, llm: "recorded", workersAi: null });
    expect(parseConfig({ SS_DEMO: "0", SS_LLM: "stub" } as unknown as Env).llm).toBe("stub");
  });

  it("tells the app it is a demo and which questions are recorded", async () => {
    const me = await json<{ demo: { recorded_questions: string[] } | null }>("/api/me", { as: P.lead });
    expect(me.demo).toEqual({ recorded_questions: recordedQuestions() });
  });
});

describe("the chat in demo mode", () => {
  it("answers a question without a recording with the friendly message, no tool, no model and no stub", async () => {
    for (const provider of [undefined, "mlx", "llama", "stub", "workers-ai"]) {
      const t = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: "Forecast voluntary departures in Sales over the next 30 days.", ...(provider ? { provider } : {}) } });
      expect(t.provider).toBe("recorded");
      expect(t.grounding).toBe("unrecorded");
      expect(t.text).toBe(recordedQuestions().length ? UNRECORDED_CHAT : UNRECORDED_CHAT_NONE);
      expect(t.suggestions).toEqual(recordedQuestions());
      expect(t.tool_calls).toEqual([]);
      expect(t.spans.some((s) => s.kind === "model_call" || s.kind === "template")).toBe(false);
      expect(t.text).not.toMatch(/stub|template/i);
    }
    expect(live).toEqual([]);
  });

  it("still refuses the boundary question before any model call", async () => {
    const t = await json<Turn & { refusal: { code: string } | null }>("/api/dev/agent/turn", { as: P.lead, body: { question: "Which engineers in Platform Engineering are most likely to quit?", provider: "mlx" } });
    expect(t.grounding).toBe("refused");
    expect(t.refusal?.code).toBe("INDIVIDUAL_LEVEL");
    expect(live).toEqual([]);
  });
});

describe("the Scenario Lab in demo mode", () => {
  it("lists model-recorded sessions only and hides the stub placeholders", async () => {
    const idx = await json<{ demo: boolean; proposals: { id: string; placeholder: boolean }[] }>("/api/lab", { as: P.lead });
    expect(idx.demo).toBe(true);
    expect(idx.proposals.every((p) => !p.placeholder)).toBe(true);
    const all = await json<{ proposals: { id: string; placeholder: boolean }[] }>("/api/lab", { as: P.lead });
    for (const p of all.proposals) {
      const r = await call(`/api/lab/${p.id}`, { as: P.lead });
      const doc = (await r.json()) as { placeholder?: boolean; provenance?: string | null };
      expect(r.status).toBe(200);
      expect(doc.placeholder).toBe(false);
      expect(doc.provenance).toMatch(/^Recorded from Qwen3\.6-27B on this laptop, \d{4}-\d{2}-\d{2}; replayed\./);
    }
  });

  it("answers the interview from recorded answers only, never the engine, a model or the placeholder", async () => {
    const r = await call("/api/lab/interview", { as: P.lead, body: { proposal: "promotion-criteria-third-window", persona_id: "P03", question: "Anything not recorded?" } });
    expect(r.headers.get("x-staysignal-label")).toBe(LAB_LABEL);
    expect(r.headers.get("x-staysignal-source")).toBe("unrecorded");
    expect(await r.text()).toBe(UNRECORDED_INTERVIEW);
    const qs = await json<{ demo: boolean; recorded: { persona_id: string; question: string; provenance: string }[] }>("/api/lab/interviews/promotion-criteria-third-window", { as: P.lead });
    expect(qs.demo).toBe(true);
    for (const q of qs.recorded) {
      const a = await call("/api/lab/interview", { as: P.lead, body: { proposal: "promotion-criteria-third-window", persona_id: q.persona_id, question: q.question } });
      expect(a.headers.get("x-staysignal-source")).toBe("recorded");
      expect(a.headers.get("x-staysignal-provenance")).toBe(q.provenance);
    }
    expect(live).toEqual([]);
  });
});
