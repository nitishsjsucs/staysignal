// SPEC 14.12: every answer stores a trace; analysts read their own traces, leads every trace, the auditor every
// trace as metadata only (no question text, no tool arguments), and roles without a trace scope read none.
import { describe, expect, it } from "vitest";
import { json, P } from "../helpers/api";

type View = { trace_id: string; owner: string; question: string | null; metadata_only: boolean; spans: { kind: string; dur_ms: number }[]; tool_calls: { tool: string; args?: unknown }[] };
type List = { traces?: View[]; code?: string };

describe("traces", () => {
  it("scopes trace reads by role", async () => {
    await json("/api/dev/agent/turn", { as: P.analyst, body: { question: "Forecast voluntary departures in Sales over the next 90 days." } });
    await json("/api/dev/agent/turn", { as: P.lead, body: { question: "Forecast voluntary departures in Marketing over the next 90 days." } });

    const own = (await json<List>("/api/traces", { as: P.analyst })).traces!;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((t) => t.owner === P.analyst)).toBe(true);
    expect(own[0]!.spans.map((s) => s.kind)).toContain("tool_call");

    const all = (await json<List>("/api/traces", { as: P.lead })).traces!;
    expect(new Set(all.map((t) => t.owner))).toEqual(new Set([P.analyst, P.lead]));
    expect(all.find((t) => t.owner === P.analyst)?.question).toMatch(/Sales/);

    const meta = (await json<List>("/api/traces", { as: P.auditor })).traces!;
    expect(meta.length).toBe(all.length);
    expect(meta.every((t) => t.metadata_only && t.question === null && t.tool_calls.every((c) => c.args === undefined))).toBe(true);

    expect((await json<List>("/api/traces", { as: P.hrbpEng })).code).toBe("NOT_PERMITTED");
    const leadTrace = all.find((t) => t.owner === P.lead)!;
    expect((await json<{ code?: string }>(`/api/traces/${leadTrace.trace_id}`, { as: P.analyst })).code).toBe("NOT_PERMITTED");
    expect((await json<View>(`/api/traces/${leadTrace.trace_id}`, { as: P.lead })).question).toMatch(/Marketing/);
  });
});
