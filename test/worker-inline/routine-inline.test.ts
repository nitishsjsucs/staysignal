// The fixtures deployment has no runner (SS_RUNNER=inline, SPEC 18, 23.2 path A): every engine job is completed from
// its committed fixture as it is enqueued, and the routine still holds the candidate, waits for the data engineer's
// mapping approval, repairs, publishes version 3 and records the replay, with nothing ever leased.
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { json, P } from "../helpers/api";

const ws = () => getAgentByName(env.WORKSPACE_AGENT, "larkspur");

async function until(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

describe("inline job completion (fixtures deployment)", () => {
  it("runs the whole routine with no runner", async () => {
    await json("/api/demo/arrival", { as: P.analyst, body: {} });
    await until(async () => {
      const a = (await (await ws()).listApprovals()) as unknown as ({ subject_kind: string; status: string } | null)[];
      return a.some((x) => x?.subject_kind === "mapping" && x.status === "pending");
    });
    const runs = await json<{ runs: { run_id: string; status: string }[] }>("/api/runs", { as: P.analyst });
    expect(runs.runs.find((r) => r.run_id === "R-2026-10-01#2")?.status).toBe("held");
    const mapping = await json<{ proposals: { subject_id: string }[] }>("/api/mappings/payroll", { as: P.dataEng });
    expect((await json<{ ok: boolean }>(`/api/approvals/${mapping.proposals[0]!.subject_id}/approve`, { as: P.dataEng, body: { reason: "ANN means annual" } })).ok).toBe(true);
    await until(async () => ((await (await ws()).listReplays("R-2026-10-01#3")) as unknown as unknown[]).length > 0);
    const after = await json<{ published: string }>("/api/runs", { as: P.analyst });
    expect(after.published).toBe("R-2026-10-01#3");
    const jobs = (await (await ws()).listJobs()) as unknown as { status: string; attempt: number }[];
    expect(jobs.length).toBe(9);
    expect(jobs.every((j) => j.status === "done" && j.attempt === 1)).toBe(true);
    // nothing is left to lease
    expect(((await (await ws()).leaseJob("nobody")) as unknown as { job: unknown }).job).toBeNull();
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
    await until(async () => {
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
