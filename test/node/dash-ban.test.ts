// The 27B's chat requests ban en and em dash tokens at sampling time (the Lab recorder's list), because the public
// hygiene tier rejects those characters in committed recordings and a recorded turn is never hand-edited.
import { readFileSync } from "node:fs";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { NO_DASH_TOKEN_IDS, openAiCompatible } from "../../src/worker/agents/providers";

function capture(): { bodies: Record<string, unknown>[]; fetchFn: typeof fetch } {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const reply = { id: "c1", object: "chat.completion", created: 0, model: "default_model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { bodies, fetchFn };
}

describe("the mlx provider's dash ban", () => {
  it("bans the same tokens as the Lab recorder", () => {
    const sim = readFileSync("sim/src/staysignal_sim/client.py", "utf8");
    const block = /NO_DASH_TOKEN_IDS = \(([\s\S]*?)\)/.exec(sim)?.[1] ?? "";
    expect([...block.matchAll(/\d+/g)].map((m) => Number(m[0]))).toEqual([...NO_DASH_TOKEN_IDS]);
  });

  it("sends every dash token with a bias of -100 on the 27B", async () => {
    const { bodies, fetchFn } = capture();
    await generateText({ model: openAiCompatible("mlx", "http://127.0.0.1:8186/v1", fetchFn), prompt: "hi", temperature: 0 });
    const bias = bodies[0]?.logit_bias as Record<string, number>;
    expect(Object.keys(bias)).toHaveLength(NO_DASH_TOKEN_IDS.length);
    expect(new Set(Object.values(bias))).toEqual(new Set([-100]));
    expect(bodies[0]?.model).toBe("default_model");
  });

  it("leaves the 1.7B's requests alone (a different tokenizer)", async () => {
    const { bodies, fetchFn } = capture();
    await generateText({ model: openAiCompatible("llama", "http://127.0.0.1:8187/v1", fetchFn), prompt: "hi", temperature: 0 });
    expect(bodies[0]).not.toHaveProperty("logit_bias");
  });
});
