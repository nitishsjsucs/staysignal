// SPEC 15.8: the persona interview. Lab readers only; in fixtures mode (CI, production) a recorded answer or a labeled
// placeholder; locally in engine mode the engine's stream passes through, and an engine error or a stopped model falls
// back before anything was streamed. Every answer carries the Lab label.
import { describe, expect, it } from "vitest";
import { findRecordedAnswer, LAB_LABEL, liveAnswer, PLACEHOLDER_ANSWER } from "../../src/worker/lab-interview";
import { call, json, P } from "../helpers/api";

const req = { proposal: "promotion-criteria-third-window", persona_id: "P03", question: "What would you ask first?" };

describe("POST /api/lab/interview", () => {
  it("answers a Lab reader with the labeled placeholder when no live model or recorded answer exists", async () => {
    const r = await call("/api/lab/interview", { as: P.lead, body: req });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-staysignal-label")).toBe(LAB_LABEL);
    expect(r.headers.get("x-staysignal-source")).toBe("placeholder");
    expect(await r.text()).toBe(PLACEHOLDER_ANSWER);
  });

  it("refuses roles without lab:read and malformed requests", async () => {
    expect(await json("/api/lab/interview", { as: P.dataEng, body: req })).toMatchObject({ refused: true, code: "NOT_PERMITTED" });
    expect((await call("/api/lab/interview", { as: P.lead, body: { ...req, persona_id: "Jane" } })).status).toBe(400);
    expect((await call("/api/lab/interview", { as: P.lead, body: { ...req, question: "x".repeat(301) } })).status).toBe(400);
  });
});

describe("live answers and the fallback", () => {
  it("streams the engine's answer through, labeled live", async () => {
    const fake = (async () => new Response("I would ask about June.", { status: 200 })) as unknown as typeof fetch;
    const r = await liveAnswer("http://engine", req, "mlx", fake);
    expect(r.headers.get("x-staysignal-source")).toBe("live");
    expect(r.headers.get("x-staysignal-model")).toContain("27B");
    expect(await r.text()).toBe("I would ask about June.");
  });

  it("falls back when the model server is down or the engine is unreachable", async () => {
    const down = (async () => new Response("no model", { status: 503 })) as unknown as typeof fetch;
    const gone = (async () => {
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    for (const f of [down, gone]) {
      const r = await liveAnswer("http://engine", req, "mlx", f);
      expect(r.headers.get("x-staysignal-source")).toBe("placeholder");
    }
  });

  it("finds a recorded answer for the same persona and question, ignoring case and punctuation", () => {
    const answers = [{ ...req, question: "What would you ask FIRST", answer: "a", model: "m", recorded_at: "2026-10-14" }];
    expect(findRecordedAnswer(req, answers)?.answer).toBe("a");
    expect(findRecordedAnswer({ ...req, persona_id: "P04" }, answers)).toBeNull();
  });
});
