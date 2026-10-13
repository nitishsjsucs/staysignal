// The demo-turn recorder (SPEC 14.2, ADR 0010): what it writes for a turn, what it refuses to write, and that the
// recorded provider replays the written steps in order (tool calls with their arguments, then the text).
import { generateText, isStepCount, type Tool } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { labelFor, toRecording, type TurnReply } from "../../scripts/demo-record.ts";
import type { RecordedTurn } from "../../src/worker/agents/recorded-provider";
import { recordedModel } from "../../src/worker/agents/providers";

const q = { id: "beat-1-forecast", beat: "1", principal: "pa-lead@larkspur.example", question: "Forecast voluntary departures in Engineering over the next 90 days." };
const steps = [{ tool_calls: [{ tool: "forecast_departures", args: { cohort: "Engineering", horizon_days: 90 }, result_id: "res_x" }] }, { text: "About {{r1.expected}} voluntary departures." }];
const reply = (over: Partial<TurnReply>): TurnReply => ({ text: steps[1]!.text!, grounding: "passed", refusal: null, tool_calls: [{ tool: "forecast_departures", result_id: "res_x", refused: null }], model_steps: steps, ...over });

describe("demo:record", () => {
  it("writes the model's steps labeled with the model and the date", () => {
    const r = toRecording(q, reply({}), "mlx", "2026-10-14");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.recording).toMatchObject({ id: "beat-1-forecast", question: q.question, recorded_at: "2026-10-14", provider: "mlx", steps });
    expect(r.recording.model).toMatch(/Qwen3\.6-27B/);
    expect(r.recording.label).toBe("Model text replayed from a recorded 27B turn (2026-10-14); tools ran live");
    expect(labelFor("llama", "2026-10-13")).toContain("Qwen3-1.7B");
  });

  it("keeps a repaired answer and refuses template answers, missing steps and unexpected refusals", () => {
    expect(toRecording(q, reply({ grounding: "repaired" }), "mlx", "2026-10-14").ok).toBe(true);
    expect(toRecording(q, reply({ grounding: "template" }), "mlx", "2026-10-14")).toMatchObject({ ok: false, reason: expect.stringContaining("grounding template") });
    expect(toRecording(q, reply({ model_steps: undefined }), "mlx", "2026-10-14").ok).toBe(false);
    expect(toRecording(q, reply({ refusal: { code: "SMALL_COHORT", layer: "prerouter" } }), "mlx", "2026-10-14")).toMatchObject({ ok: false, reason: expect.stringContaining("unexpected refusal") });
  });

  it("records nothing for the boundary question, which the pre-router refuses before any model call", () => {
    const r = toRecording({ ...q, expect: "refusal" }, reply({ refusal: { code: "INDIVIDUAL_LEVEL", layer: "prerouter" }, model_steps: undefined }), "mlx", "2026-10-14");
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("as expected") });
  });

  it("replays the recorded steps in order through the recorded provider while the tool runs", async () => {
    const turn: RecordedTurn = { id: q.id, question: q.question, model: "test", recorded_at: "2026-10-14", label: "x", steps };
    const seen: unknown[] = [];
    const tools: Record<string, Tool> = {
      forecast_departures: { description: "d", inputSchema: z.object({ cohort: z.string(), horizon_days: z.number() }), execute: async (args: unknown) => (seen.push(args), { alias: "r1" }) } as unknown as Tool,
    };
    const res = await generateText({ model: recordedModel(turn), messages: [{ role: "user", content: q.question }], tools, stopWhen: isStepCount(6) });
    expect(seen).toEqual([{ cohort: "Engineering", horizon_days: 90 }]);
    expect(res.text).toBe(steps[1]!.text);
  });
});
