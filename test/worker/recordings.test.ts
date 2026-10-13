// C62 (SPEC 20): recorded turns replay and resolve. Every demo/recordings file replays through the recorded provider
// with the tools running live: the label names the model and date, grounding passes, the recomputed result IDs equal
// the recorded ones and every alias resolves. Also the recorder's source: the dev turn returns the model's steps only
// when asked, and only on localhost.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { RecordedTurn } from "../../src/worker/agents/recorded-provider";
import { RECORDINGS } from "../../src/worker/generated/recordings-index";
import { call, json, P, tokenFor } from "../helpers/api";

type Turn = {
  text: string;
  grounding: string;
  recorded: boolean;
  label: string | null;
  aliases: Record<string, string>;
  tool_calls: { tool: string; result_id: string | null }[];
  model_steps?: { tool_calls?: { tool: string; args: Record<string, unknown>; result_id?: string | null }[]; text?: string }[];
};

const Q = "Forecast voluntary departures in Engineering over the next 90 days.";

describe("the recorder's view of a turn (dev, localhost only)", () => {
  it("returns the model's steps when asked: the tool call with its arguments and result, then the accepted text", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: Q, provider: "stub", capture_steps: true } });
    expect(t.grounding).toBe("passed");
    expect(t.model_steps).toHaveLength(2);
    const [first, last] = t.model_steps!;
    expect(first!.tool_calls?.[0]).toMatchObject({ tool: "forecast_departures", args: { cohort: "Engineering", horizon_days: 90 } });
    expect(first!.tool_calls?.[0]?.result_id).toBe(t.tool_calls[0]?.result_id);
    expect(last).toEqual({ text: t.text });
  });

  it("leaves the steps out unless asked", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.lead, body: { question: Q, provider: "stub" } });
    expect(t.model_steps).toBeUndefined();
  });

  it("is not served off localhost", async () => {
    const r = await exports.default.fetch(
      new Request("http://staysignal.example/api/dev/agent/turn", { method: "POST", headers: { Authorization: `Bearer ${await tokenFor(P.lead)}`, "content-type": "application/json" }, body: JSON.stringify({ question: Q, provider: "stub", capture_steps: true }) }),
    );
    expect(r.status).not.toBe(200);
    expect(await r.text()).not.toContain("model_steps");
  });
});

describe("committed recorded turns (demo/recordings)", () => {
  const recs = RECORDINGS as RecordedTurn[];

  it("each names its model and date and ends with the model's text", () => {
    for (const rec of recs) {
      expect(rec.id).toMatch(/^[a-z0-9-]+$/);
      expect(rec.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rec.label).toContain(rec.recorded_at);
      expect(rec.label).toMatch(/^Recorded from .+ on this laptop, \d{4}-\d{2}-\d{2}; replayed\. Numbers compute live from the warehouse\.$/);
      expect(rec.model.length).toBeGreaterThan(0);
      expect(rec.steps[rec.steps.length - 1]?.text?.length ?? 0).toBeGreaterThan(0);
    }
    expect(new Set(recs.map((r) => r.question.toLowerCase())).size).toBe(recs.length);
  });

  for (const rec of recs) {
    it(`replays ${rec.id} with live tools, the recorded result IDs and grounding passed`, async () => {
      const as = rec.principal ?? P.lead;
      const t = await json<Turn>("/api/dev/agent/turn", { as, body: { question: rec.question, provider: "recorded" } });
      expect(t.recorded).toBe(true);
      expect(t.label).toBe(rec.label);
      expect(t.grounding).toBe("passed");
      const recorded = rec.steps.flatMap((s) => s.tool_calls ?? []);
      expect(t.tool_calls.map((c) => c.tool)).toEqual(recorded.map((c) => c.tool));
      recorded.forEach((c, i) => {
        if (c.result_id) expect(t.tool_calls[i]?.result_id).toBe(c.result_id);
      });
      for (const id of Object.values(t.aliases)) {
        const r = await call(`/api/results/${id}`, { as });
        expect(r.status, `alias result ${id}`).toBe(200);
      }
    });
  }
});
