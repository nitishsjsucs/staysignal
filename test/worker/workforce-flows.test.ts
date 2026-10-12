// The workforce_flows tool on the semantic catalog (SPEC 7.3, 14.3, 17.5): cohort flows from a compiled catalog entry,
// with links under 10 merged, sides under 10 withheld, People Partners scoped server-side, and nothing per person.
import { describe, expect, it } from "vitest";
import type { FlowLink, WorkforceFlowsData } from "../../src/shared/contracts";
import { flowSide } from "../../src/shared/tools/registry";
import { json, P } from "../helpers/api";

type Res = { refused?: boolean; code?: string; result_id?: string; provenance?: { catalog_entry?: string }; data?: WorkforceFlowsData };

const flows = (cohort: string, as: string, extra = "") => json<Res>(`/api/workforce/flows?cohort=${encodeURIComponent(cohort)}${extra}`, { as });

function balanced(d: WorkforceFlowsData): void {
  const inn = d.links.filter((l) => l.target === d.cohort.name && l.source !== "Start of window");
  const out = d.links.filter((l) => l.source === d.cohort.name && l.target !== "End of window");
  const sum = (ls: FlowLink[]) => ls.reduce((s, l) => s + (l.value ?? 0), 0);
  if (d.joined !== null) expect(sum(inn)).toBe(d.joined);
  if (d.left !== null) expect(sum(out)).toBe(d.left);
  if (d.headcount_end !== null) expect(d.headcount_end).toBe(d.headcount_start + (d.joined ?? 0) - (d.left ?? 0));
}

describe("workforce_flows", () => {
  it("serves company and organization flows over the last 12 months from the catalog", async () => {
    const r = await flows("company", P.analyst);
    expect(r.result_id).toMatch(/^res_/);
    expect(r.provenance?.catalog_entry).toBe("workforce_flows|company|none");
    const d = r.data!;
    expect([d.from, d.to]).toEqual(["2025-10", "2026-09"]);
    expect(d.level).toBe("company");
    expect(d.headcount_start).toBeGreaterThan(1500);
    expect(d.links.every((l) => l.value === null || l.value >= 10)).toBe(true);
    expect(d.links.some((l) => l.target === "Voluntary exits")).toBe(true);
    // exits other than voluntary are one band, never by type
    expect(d.links.some((l) => /involuntary|retire/i.test(`${l.source} ${l.target}`))).toBe(false);
    balanced(d);
    const org = await flows("org:Engineering", P.lead);
    expect(org.data!.level).toBe("organization");
    expect(org.data!.headcount_start).toBeLessThan(d.headcount_start);
    balanced(org.data!);
  });

  it("merges small links into one link of 10 or more on each side", async () => {
    const r = await flows("group:Platform Engineering", P.analyst);
    const d = r.data!;
    expect(d.level).toBe("group");
    for (const l of d.links) expect(l.value === null || l.value >= 10).toBe(true);
    balanced(d);
  });

  it("scopes People Partners to their organizations, server-side", async () => {
    const own = await flows("org:Engineering", P.hrbpEng);
    expect(own.data?.cohort.name).toBe("Engineering");
    expect((await flows("org:Sales", P.hrbpEng)).code).toBe("NOT_ASSIGNED");
    expect((await flows("company", P.hrbpEng)).code).toBe("NOT_ASSIGNED");
    // the same cohort read by an analyst and a People Partner has equal values (the scope only filters rows)
    const analyst = await flows("org:Engineering", P.analyst);
    expect(own.data!.links).toEqual(analyst.data!.links);
    expect(own.result_id).not.toBe(analyst.result_id); // results are keyed by the audience class
  });

  it("refuses teams, aggregate roles below the company, and windows the fixtures do not hold", async () => {
    expect((await flows("org:Engineering", P.dataEng)).code).toBe("NOT_PERMITTED");
    expect((await flows("company", P.dataEng)).result_id).toBeTruthy();
    expect((await flows("company", P.analyst, "&from=2024-01&to=2024-12")).code).toBe("OUT_OF_SCOPE");
    expect((await flows("company", P.analyst, "&from=2023-01&to=2023-12")).code).toBe("OUT_OF_SCOPE");
  });

  it("never returns a person-level field", async () => {
    const r = await flows("company", P.analyst);
    expect(JSON.stringify(r)).not.toMatch(/\bE\d{6}\b|\ber_[a-z2-7]{26}\b|employee/);
  });
});

describe("flowSide (disclosure merging)", () => {
  const side = (vals: number[]) => flowSide(vals.map((v, i) => ({ label: `f${i}`, value: v })), "withheld");
  it("shows links of 10 or more and merges the rest", () => {
    expect(side([40, 12, 30])).toEqual({ links: [{ label: "f0", value: 40 }, { label: "f2", value: 30 }, { label: "f1", value: 12 }], total: 82 });
    expect(side([40, 12, 3, 4])).toEqual({ links: [{ label: "f0", value: 40 }, { label: "Other (merged)", value: 19, merged_from: ["f2", "f3", "f1"] }], total: 59 });
    expect(side([40, 6, 5])).toEqual({ links: [{ label: "f0", value: 40 }, { label: "Other (merged)", value: 11, merged_from: ["f1", "f2"] }], total: 51 });
  });
  it("merges a small bucket with the smallest shown link so nothing under 10 is shown or recoverable", () => {
    const s = side([40, 12, 3]);
    expect(s.links).toEqual([{ label: "f0", value: 40 }, { label: "Other (merged)", value: 15, merged_from: ["f2", "f1"] }]);
    expect(s.total).toBe(55);
  });
  it("withholds a side whose total is under 10, and drops zeros", () => {
    expect(side([3, 0, 4])).toEqual({ links: [{ label: "withheld", value: null }], total: null });
    expect(side([0, 0])).toEqual({ links: [], total: 0 });
    expect(side([25, 0, 11])).toEqual({ links: [{ label: "f0", value: 25 }, { label: "f2", value: 11 }], total: 36 });
  });
});
