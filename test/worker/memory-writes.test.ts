// The agent's memory writes (SPEC 14.10): what a routine commits, and how the write reaches the engine. Only the
// runner token writes; fixtures mode skips with a reason; a failed write never throws into the routine.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decisionMemoryNote } from "../../src/worker/memory/notes";
import { writeMemoryNote } from "../../src/worker/memory/writer";
import { routineMemoryNote } from "../../src/worker/workflows/routine-workflow";

const engineEnv = (token: string | null) => ({ ...env, SS_DATA_MODE: "engine", SS_ENGINE_URL: "http://engine.test", ...(token ? { SS_RUNNER_TOKEN: token } : { SS_RUNNER_TOKEN: undefined }) }) as unknown as Env;
const PERSON = /\bE\d{6}\b|\ber_[a-z2-7]{20,}\b/;

describe("routine memory notes", () => {
  it("a held, repaired run becomes an investigation citing the run, incident, proposal and publish action", () => {
    const n = routineMemoryNote({ routineId: "RT-0001", failing: ["C01"], incidentId: "INC-0001", lineage: ["payroll", "stg_payroll", "pit"], proposalId: "MAP-0001", decision: "approved", out: { run_id: "R-2026-10-01#3", published: true, seq: 14, replay_equal: true }, investigationId: "IVG-0001" });
    expect(n.kind).toBe("investigation");
    expect(n.title).toBe("Run held by check C01");
    const text = n.bullets.join(" ");
    for (const cite of ["RT-0001", "INC-0001", "MAP-0001", "IVG-0001", "R-2026-10-01#3", "action 14", "payroll > stg_payroll > pit", "matched"]) expect(text).toContain(cite);
    expect(text).not.toMatch(PERSON);
  });

  it("a rejected proposal is recorded without a publish line; a clean run is one timeline bullet", () => {
    const rejected = routineMemoryNote({ routineId: "RT-0002", failing: ["C01", "S03"], incidentId: "INC-0002", lineage: ["payroll"], proposalId: "MAP-0002", decision: "rejected", out: null });
    expect(rejected.bullets).toHaveLength(3);
    expect(rejected.bullets[0]).toContain("checks C01, S03 failed");
    expect(rejected.bullets[2]).toContain("decision: rejected");
    const clean = routineMemoryNote({ routineId: "RT-0003", failing: [], incidentId: null, lineage: [], proposalId: null, decision: null, out: { run_id: "R-2026-10-01#2", published: false, seq: null, replay_equal: null } });
    expect(clean).toEqual({ kind: "timeline", bullets: ["Routine RT-0003: checks passed. Run R-2026-10-01#2 changed beyond tolerance and waits for a publish approval."] });
  });
});

describe("decision memory notes", () => {
  it("approvals and rejections become decision notes citing the action, with the role and never the reason", () => {
    const review = decisionMemoryNote({ seq: 21, kind: "review.approve", actor_kind: "human", payload: { review_id: "REV-0001", cohort_id: "group:Platform Engineering", proposer: "pa-analyst@larkspur.example" }, reverses_seq: null }, "People Analytics lead");
    expect(review).toMatchObject({ kind: "decision", title: "Review REV-0001 for Platform Engineering approved" });
    expect(review!.bullets[0]).toBe("A People Analytics lead approved review REV-0001 for Platform Engineering (action 21); its checks became tasks for the owning team.");
    const mapping = decisionMemoryNote({ seq: 9, kind: "mapping.activate", actor_kind: "human", payload: { proposal_id: "MAP-0001", source: "payroll", from: "payroll@1", to: "payroll@2" }, reverses_seq: null }, "Data engineer");
    expect(mapping!.title).toBe("Payroll mapping payroll@2 activated");
    const rejected = decisionMemoryNote({ seq: 30, kind: "review.reject", actor_kind: "human", payload: { subject_id: "REV-0002" }, reverses_seq: null }, "People Analytics lead");
    expect(rejected).toMatchObject({ kind: "decision", title: "Review REV-0002 rejected" });
    for (const n of [review, mapping, rejected]) expect(JSON.stringify(n)).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/); // no email address
  });

  it("a rollback is a timeline bullet; routine actions are left to the routine's own note", () => {
    expect(decisionMemoryNote({ seq: 25, kind: "rollback", actor_kind: "human", payload: { reverses_kind: "review.approve" }, reverses_seq: 21 }, "People Analytics lead")).toEqual({ kind: "timeline", bullets: ["A People Analytics lead rolled back action 21, a review approval (action 25)."] });
    expect(decisionMemoryNote({ seq: 12, kind: "run.publish", actor_kind: "routine", payload: { run_id: "R-2026-10-01#3" }, reverses_seq: null }, "agent")).toBeNull();
    expect(decisionMemoryNote({ seq: 3, kind: "review.submit", actor_kind: "human", payload: {}, reverses_seq: null }, "People analyst")).toBeNull();
  });
});

describe("writeMemoryNote", () => {
  afterEach(() => vi.restoreAllMocks());
  const note = { kind: "timeline" as const, bullets: ["Run published (synthetic)."] };

  it("skips in fixtures mode and without a runner token, without calling out", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await writeMemoryNote(env, note, "2026-10-05T14:00:00Z")).toEqual({ written: false, reason: "fixtures mode serves the committed memory read-only" });
    expect(await writeMemoryNote(engineEnv(null), note, "2026-10-05T14:00:00Z")).toEqual({ written: false, reason: "no runner token configured" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("posts the note with the runner token and the synthetic time", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ label: "synthetic", id: null, commit: "0123456789abcdef", files: ["timeline/daily/2026-10-05.md"] }));
    const out = await writeMemoryNote(engineEnv("tok"), note, "2026-10-05T14:00:00Z");
    expect(out).toEqual({ written: true, id: null, commit: "0123456789abcdef", files: ["timeline/daily/2026-10-05.md"] });
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("http://engine.test/memory/note");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
    expect(JSON.parse(init?.body as string)).toEqual({ ...note, at: "2026-10-05T14:00:00Z" });
  });

  it("reports a refusal or an unreachable engine instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ detail: "a memory note never names a person (cohort-level content only)" }, { status: 400 }));
    expect(await writeMemoryNote(engineEnv("tok"), note, "2026-10-05T14:00:00Z")).toEqual({ written: false, reason: "engine refused the note (400: a memory note never names a person (cohort-level content only))" });
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connection refused"));
    expect(await writeMemoryNote(engineEnv("tok"), note, "2026-10-05T14:00:00Z")).toEqual({ written: false, reason: "engine unreachable (connection refused)" });
  });
});
