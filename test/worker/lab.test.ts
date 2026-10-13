// SPEC 15, ADR 0008: the Scenario Lab's recorded sessions behind lab:read, labeled on every response, and never a
// source of review evidence or forecast numbers.
import { describe, expect, it } from "vitest";
import { call, json, P } from "../helpers/api";

const LABEL = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.";

type LabDoc = { label: string; proposal: string; placeholder: boolean; personas: { handle: string }[]; analysis: { label: string; network: { nodes: { id: string }[] } }; sanity: { label: string; persona_agreement: { n_cells: number } } };

describe("Scenario Lab API", () => {
  it("lists the recorded sessions, both marked placeholder until the 27B recordings exist", async () => {
    const idx = await json<{ label: string; proposals: { id: string; placeholder: boolean }[] }>("/api/lab", { as: P.analyst });
    expect(idx.label).toBe(LABEL);
    expect(idx.proposals.map((p) => p.id)).toEqual(["infra-data-merge", "promotion-criteria-third-window"]);
    expect(idx.proposals.every((p) => p.placeholder)).toBe(true);
  });

  it("serves a session with its analysis and sanity panel, labeled, with anonymous network nodes", async () => {
    const doc = await json<LabDoc>("/api/lab/promotion-criteria-third-window", { as: P.hrbpEng });
    expect(doc.label).toBe(LABEL);
    expect(doc.analysis.label).toBe(LABEL);
    expect(doc.sanity.label).toBe("A consistency check, not validation");
    expect(doc.personas).toHaveLength(16);
    expect(doc.analysis.network.nodes.every((n) => /^(N\d+|PO)$/.test(n.id))).toBe(true);
  });

  it("refuses roles without lab:read and unknown or malformed proposals", async () => {
    expect(await json<{ code: string }>("/api/lab", { as: P.dataEng })).toMatchObject({ refused: true, code: "NOT_PERMITTED" });
    expect(await json<{ code: string }>("/api/lab/infra-data-merge", { as: P.auditor })).toMatchObject({ refused: true, code: "NOT_PERMITTED" });
    expect((await call("/api/lab/no-such-proposal", { as: P.analyst })).status).toBe(404);
    expect((await call("/api/lab/..%2Fruns", { as: P.analyst })).status).toBe(404);
  });

  it("is never review evidence: a drafted review cites no Lab document", async () => {
    const r = await call("/api/reviews/draft", { as: P.lead, method: "POST", body: { cohort: "group:Platform Engineering" } });
    const text = await r.text();
    expect(text).not.toMatch(/\/api\/lab|lab\/|Scenario Lab|synthetic persona/i);
  });
});
