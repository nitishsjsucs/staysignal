// C77 and SPEC 17.7: the action audit is served to leads (proxy screens: tenure band and location) and to the auditor
// (also the audit-only age screen and the proxy strength); every other role is refused. Aggregates only.
import { describe, expect, it } from "vitest";
import type { ActionAuditDoc } from "../../src/shared/contracts";
import { json, P } from "../helpers/api";

type Res = Partial<ActionAuditDoc> & { code?: string; audience?: string };

describe("action audit", () => {
  it("gives leads the proxy screens only", async () => {
    const r = await json<Res>("/api/audit/actions", { as: P.lead });
    expect(r.audience).toBe("lead");
    expect(Object.keys(r.screens!).sort()).toEqual(["location", "tenure_band"]);
    expect(r.proxy_strength).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/age40|40 or over/);
  });

  it("gives the auditor the age screen and the proxy strength", async () => {
    const r = await json<Res>("/api/audit/actions", { as: P.auditor });
    expect(Object.keys(r.screens!).sort()).toEqual(["age40", "location", "tenure_band"]);
    expect(r.proxy_strength?.tenure_band_auc).toBeGreaterThan(0.5);
    for (const s of Object.values(r.screens!)) for (const row of s.rows) if (!row.too_small) expect(row.people).toBeGreaterThanOrEqual(10);
  });

  it("refuses analysts, People Partners and data engineers", async () => {
    for (const who of [P.analyst, P.hrbpEng, P.dataEng]) expect((await json<Res>("/api/audit/actions", { as: who })).code).toBe("NOT_PERMITTED");
  });

  it("serves aggregates only", async () => {
    const r = await json<Res>("/api/audit/actions", { as: P.auditor });
    expect(JSON.stringify(r)).not.toMatch(/\bE\d{6}\b|\ber_[a-z2-7]{26}\b|employee_number/);
  });
});
