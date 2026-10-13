// C19, C21 (in part), C35: the source-arrival routine end to end with the fixture runner: the September payroll lands,
// checks fail, the candidate run is held with an incident, the deterministic mapping proposal waits for a data engineer,
// the repair rebuilds and publishes version 3 within tolerance, and the replay matches. A held run can never publish.
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { FIXTURES } from "../../src/worker/generated/fixtures-index";
import { json, P } from "../helpers/api";

const ws = () => getAgentByName(env.WORKSPACE_AGENT, "larkspur");

async function runJobs(until: () => Promise<boolean>, timeoutMs = 45_000): Promise<string[]> {
  const done: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await until()) return done;
    const w = await ws();
    const lease = (await w.leaseJob("test-runner")) as unknown as { job: { job_key: string; kind: string } | null };
    if (lease.job) {
      const out = FIXTURES[`jobs/${lease.job.job_key}.json`];
      await w.completeJob(lease.job.job_key, out ?? { error: "missing fixture" }, out !== undefined);
      done.push(lease.job.kind);
    } else {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`timed out; jobs done: ${done.join(", ")}`);
}

describe("source arrival routine", () => {
  it("holds the candidate, waits for the mapping approval, repairs, publishes and replays", async () => {
    const start = await json<{ routine_id: string }>("/api/demo/arrival", { as: P.analyst, body: {} });
    expect(start.routine_id).toMatch(/^RTN-/);
    const held = await runJobs(async () => {
      const a = (await (await ws()).listApprovals()) as unknown as ({ subject_kind: string; status: string } | null)[];
      return a.some((x) => x?.subject_kind === "mapping" && x.status === "pending");
    });
    expect(held).toEqual(["ingest_source", "run_checks", "score_forecast", "rca_probe", "propose_mapping"]);
    const runs = await json<{ published: string; runs: { run_id: string; status: string; incident_id?: string }[] }>("/api/runs", { as: P.analyst });
    const cand = runs.runs.find((r) => r.run_id === "R-2026-10-01#2")!;
    expect(cand.status).toBe("held");
    expect(runs.published).toBe("R-2026-10-01#1");
    const incident = await json<{ failing: string[]; probe: { path: string[]; ranking: { node: string }[] } }>(`/api/quality/incidents/${cand.incident_id}`, { as: P.dataEng });
    expect(incident.failing).toEqual(["C01", "C02", "C03"]);
    expect(incident.probe.path[0]).toBe("stg_payroll__lines");
    expect(["stg_payroll__lines", "stg_map__pay_basis"]).toContain(incident.probe.ranking[0]!.node);
    expect(await (await ws()).tryPublishRun("R-2026-10-01#2", P.lead, "publish:approve")).toEqual({ ok: false, code: "HELD_RUN" });

    const mapping = await json<{ proposals: { subject_id: string; proposer: string; payload: { to: string } }[] }>("/api/mappings/payroll", { as: P.dataEng });
    const proposal = mapping.proposals[0]!;
    expect(proposal.proposer).toBe("agent:staysignal");
    expect((await json<{ code?: string }>(`/api/approvals/${proposal.subject_id}/approve`, { as: P.analyst, body: {} })).code).toBe("WRONG_ROLE");
    const ok = await json<{ ok: boolean }>(`/api/approvals/${proposal.subject_id}/approve`, { as: P.dataEng, body: { reason: "ANN means annual in the vendor dictionary" } });
    expect(ok.ok).toBe(true);
    const repair = await runJobs(async () => ((await (await ws()).listReplays("R-2026-10-01#3")) as unknown as unknown[]).length > 0);
    expect(repair).toEqual(["score_forecast", "run_checks", "what_changed", "replay"]);
    const after = await json<{ published: string; runs: { run_id: string; status: string }[]; mapping: string }>("/api/runs", { as: P.analyst });
    expect(after.published).toBe("R-2026-10-01#3");
    expect(after.mapping).toBe("payroll@2");
    expect(after.runs.find((r) => r.run_id === "R-2026-10-01#1")?.status).toBe("superseded");
    const replays = await json<{ replays: { equal: boolean }[] }>("/api/runs/R-2026-10-01%233/replays", { as: P.dataEng });
    expect(replays.replays[0]?.equal).toBe(true);
    expect((await json<{ ok: boolean }>("/api/audit/verify", { as: P.auditor })).ok).toBe(true);
    const forecast = await json<{ data: { run_id: string } }>("/api/forecast?cohort=Engineering&horizon=3", { as: P.analyst });
    expect(forecast.data.run_id).toBe("R-2026-10-01#3");
    // the held run was investigated by the three specialists; the failing checks lead, and the mapping proposal the
    // routine drafted is linked to the investigation's pointer at the generator (SPEC 14.6)
    const investigated = ((await (await ws()).listIncidents()) as unknown as { investigation_id?: string; proposal_id?: string }[]).find((i) => i.investigation_id);
    const inv = (await (await ws()).getInvestigation(investigated!.investigation_id!)) as unknown as { specialists: { specialist: string }[]; merged: { findings: { severity: string; specialist: string }[]; proposals: { subject_id: string | null }[] } };
    expect(inv.specialists.map((s) => s.specialist)).toEqual(["data_quality", "model", "composition"]);
    expect(inv.merged.findings[0]).toMatchObject({ severity: "critical", specialist: "data_quality" });
    expect(inv.merged.proposals[0]?.subject_id).toBe(investigated!.proposal_id);
    // the routine ends by recording itself in memory; fixtures mode has no writable memory, so it says why it skipped
    type Routine = { status: string; steps: { step: string; outcome: string; reason?: string }[] };
    let routine: Routine | undefined;
    await runJobs(async () => {
      routine = ((await (await ws()).listRoutines()) as unknown as Routine[])[0];
      return routine?.status === "done";
    });
    // the routine records itself in the git-style memory store (SPEC 14.10): an investigation note, read back through
    // the same memory API, after the data engineer's decision note
    expect(routine!.steps.at(-1)).toMatchObject({ step: "memory_note", outcome: "written", note_id: expect.stringMatching(/^INV-\d{4}-\d{2}-\d{2}-01$/), commit: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const log = await json<{ commits: { message: string }[] }>("/api/memory/log", { as: P.analyst });
    expect(log.commits.map((c) => c.message).slice(0, 2)).toEqual([expect.stringMatching(/^memory: investigation INV-/), expect.stringMatching(/^memory: decision DEC-/)]);
    expect(log.commits.at(-1)?.message).toBe("memory: seed");
  });
});
