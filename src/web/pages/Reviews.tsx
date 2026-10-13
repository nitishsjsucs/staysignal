// Reviews and routines (SPEC 14.8, beat 5): an agent-drafted People Partner review becomes the submitter's proposal;
// a different lead approves it, which creates owned tasks with evidence and an audit record; rollback is one click with
// a reason. The audit timeline shows every action and whether the hash chain and its anchor verify.
import { useEffect, useState } from "react";
import type { ReviewDraft } from "../../shared/tools/registry";
import { getJSON, hasScope, invalidate, isRefusal, type Me, postJSON, type Refusal, useQuery } from "../api";
import { ApproveReject, RollbackControl } from "../components/Actions";
import { navigate, useLocation, useView } from "../router";
import { StatusPill, SyntheticChip } from "../components/ui";
import { PageHead } from "./Forecast";

interface Review {
  review_id: string;
  draft_id: string;
  cohort_id: string;
  proposer: string;
  state: string;
  created_at: string;
  title: string;
  draft: ReviewDraft;
  tasks: { task_id: string; category: string; owner_role: string; status: string; blocking_items_json: string; evidence_json: string }[];
}

interface Action {
  seq: number;
  kind: string;
  actor: string;
  actor_kind: string;
  payload_json: string;
  reason: string | null;
  reversible: string;
  reverses_seq: number | null;
  hash: string;
  created_at: string;
}

interface Verify {
  ok: boolean;
  action_log: { ok: boolean; rows: number };
  approval_audit: { ok: boolean; rows: number };
  anchor: { day: string; matches: boolean } | null;
}

const KIND_LABEL: Record<string, string> = {
  genesis: "Workspace created",
  "run.publish": "Run published",
  "run.register": "Candidate run scored",
  "run.hold": "Run held",
  "review.submit": "Review submitted",
  "review.approve": "Review approved; tasks created",
  "review.reject": "Review rejected",
  "approval.refused": "Approval refused",
  rollback: "Rollback",
  "mapping.propose": "Mapping change proposed",
  "mapping.activate": "Mapping activated",
  "replay.record": "Replay recorded",
  "source.arrived": "Source arrived",
};

function ReviewStepper({ reviewId }: { reviewId: string }) {
  const { data } = useQuery<{ transitions: { from: string; to: string; by: string; at: string; code: string | null }[] }>(`/api/reviews/${encodeURIComponent(reviewId)}`);
  const ts = data?.transitions ?? [];
  const states = ["draft", "submitted", ...ts.map((t) => t.to).filter((s) => s !== "submitted")];
  return (
    <div className="stepper" data-testid="review-stepper">
      {states.map((s, i) => {
        const t = ts.find((x) => x.to === s && (s !== "refused" || true));
        const cls = s === "refused" ? "failed" : s === "rolled_back" ? "held" : "done";
        return (
          <div key={`${s}${i}`} className={`step ${cls}`}>
            <span className="step-dot" aria-hidden="true" />
            <span className="step-label">{s.replace("_", " ")}</span>
            <span className="step-note">{t ? `${t.by.split("@")[0]}${t.code ? ` · ${t.code}` : ""}` : s === "draft" ? "agent draft" : ""}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ReviewsPage({ me }: { me: Me }) {
  const view = useView();
  const reviews = useQuery<{ reviews: Review[] }>("/api/reviews");
  const audit = useQuery<{ actions: Action[] }>(hasScope(me, "audit:read") || hasScope(me, "rollback") ? "/api/audit" : null);
  const verify = useQuery<Verify>(hasScope(me, "audit:read") ? "/api/audit/verify" : null);
  const cohorts = useQuery<{ cohorts: { id: string; name: string; kind: string; n: number }[] }>("/api/cohorts");
  const [cohort, setCohort] = useState<string>("group:Platform Engineering");
  const [draft, setDraft] = useState<{ result_id: string; data: ReviewDraft } | Refusal | null>(null);
  const [submitOut, setSubmitOut] = useState<{ ok: boolean; code?: string; message?: string } | null>(null);
  const canPropose = hasScope(me, "review:propose") || hasScope(me, "review:propose:assigned");
  // A draft prepared in the chat dock arrives as ?draft=<result ID> and opens here, ready to submit.
  const draftParam = new URLSearchParams(useLocation().search).get("draft");
  const shownId = draft && !isRefusal(draft) ? draft.result_id : null;
  useEffect(() => {
    if (!draftParam || !/^res_[a-z2-7]{26}$/.test(draftParam) || draftParam === shownId) return;
    let alive = true;
    getJSON<{ result_id: string; data: ReviewDraft }>(`/api/results/${draftParam}`).then(
      (r) => {
        if (!alive) return;
        setSubmitOut(null);
        setDraft({ result_id: r.result_id, data: r.data });
        setCohort(r.data.cohort_id);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [draftParam, shownId]);
  const prepare = async () => {
    setSubmitOut(null);
    setDraft(await postJSON(`/api/reviews/draft`, { cohort, horizon: view.horizon }));
  };
  const submit = async (id: string) => {
    const out = await postJSON<{ ok: boolean; code?: string; message?: string }>(`/api/reviews/${encodeURIComponent(id)}/submit`, {});
    setSubmitOut(out);
    invalidate();
  };
  const reversed = new Set((audit.data?.actions ?? []).filter((a) => a.kind === "rollback").map((a) => a.reverses_seq));
  const list = reviews.data?.reviews ?? [];
  const groupish = (cohorts.data?.cohorts ?? []).filter((c) => c.kind === "group" || c.kind === "organization");
  return (
    <>
      <PageHead title="Reviews" sub="Agents draft; a human submits and becomes the proposer of record; a different human with approval rights approves. Every action is in a hash-chained log and can be reversed." />
      <div className="grid">
        <section className="card span-12" aria-label="Prepare a review" data-testid="prepare-review">
          <div className="card-head">
            <div>
              <h2 className="card-title">Prepare a People Partner review</h2>
              <div className="card-sub">Three group-level checks with evidence links: compensation position, career progression, hiring coverage. Never about individuals.</div>
            </div>
            <SyntheticChip />
          </div>
          {canPropose ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <select className="select" value={cohort} onChange={(e) => setCohort(e.target.value)} aria-label="Review cohort">
                {groupish.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.n})
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn-primary" onClick={() => void prepare()} data-testid="draft-review">
                Draft review
              </button>
            </div>
          ) : (
            <p style={{ color: "var(--ink-3)" }}>Your role does not propose reviews.</p>
          )}
          {draft && isRefusal(draft) ? <p style={{ marginTop: 8 }}>{draft.message}</p> : null}
          {draft && !isRefusal(draft) ? (
            <div style={{ marginTop: 12 }} data-testid="draft">
              <div className="grid">
                {draft.data.checks.map((c) => (
                  <div key={c.category} className="stat span-4" style={{ gridColumn: "span 4" }}>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>{c.question}</div>
                    <dl className="kv" style={{ marginTop: 8 }}>
                      {Object.entries(c.facts).map(([k, v]) => (
                        <div key={k} style={{ display: "contents" }}>
                          <dt>{k.replace(/_/g, " ")}</dt>
                          <dd className="num">{typeof v === "number" && v < 1 && v > 0 && k.includes("share") ? `${(v * 100).toFixed(1)}%` : String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                    <div style={{ marginTop: 6, fontSize: 11 }}>
                      Evidence:{" "}
                      {c.evidence.map((id) => (
                        <a
                          key={id}
                          href={`/r/${id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/r/${id}`);
                          }}
                        >
                          <code>{id.slice(0, 12)}</code>{" "}
                        </a>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "8px 0" }}>Blocking item: {draft.data.blocking_items.join("; ")}.</p>
              <button type="button" className="btn btn-primary" onClick={() => void submit(draft.data.draft_id)} data-testid="submit-review">
                Submit as {me.principal.id.split("@")[0]}
              </button>
              {submitOut ? submitOut.ok ? <StatusPill status="good">Submitted; you are the proposer of record</StatusPill> : <StatusPill status="critical">{submitOut.code}</StatusPill> : null}
            </div>
          ) : null}
        </section>
        <section className="card span-12" aria-label="Reviews" data-testid="review-list">
          <div className="card-head">
            <div>
              <h2 className="card-title">Where is each review in its lifecycle, and who acted?</h2>
              <div className="card-sub">Draft, submitted, approved or refused, tasks, rolled back</div>
            </div>
          </div>
          {list.length === 0 ? <p style={{ color: "var(--ink-3)" }}>No reviews yet. Draft one above: it stays a draft until you submit it, and a different person with approval rights decides.</p> : null}
          <div className="list">
            {[...list].reverse().map((r) => {
              const approveSeq = (audit.data?.actions ?? []).find((a) => a.kind === "review.approve" && JSON.parse(a.payload_json).review_id === r.review_id)?.seq;
              return (
                <div key={r.review_id} className="list-item" style={{ flexDirection: "column", alignItems: "stretch" }} data-testid={`review-${r.review_id}`}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {r.review_id}: {r.draft.cohort}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
                        Proposer of record {r.proposer} · {r.created_at}
                      </div>
                    </div>
                    <StatusPill status={r.state === "approved" ? "good" : r.state === "submitted" ? "warning" : r.state === "rolled_back" ? "held" : "info"}>{r.state.replace("_", " ")}</StatusPill>
                  </div>
                  <ReviewStepper reviewId={r.review_id} />
                  {r.state === "submitted" && hasScope(me, "review:approve") ? <ApproveReject subjectId={r.review_id} testid="review-approve" /> : null}
                  {r.tasks.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Task</th>
                            <th>Category</th>
                            <th>Owner</th>
                            <th>Status</th>
                            <th>Blocking item</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.tasks.map((t) => (
                            <tr key={t.task_id}>
                              <td>{t.task_id}</td>
                              <td>{t.category}</td>
                              <td>{t.owner_role.replace("people_partner:", "")}</td>
                              <td>{t.status}</td>
                              <td className="wrap">{(JSON.parse(t.blocking_items_json) as string[]).join("; ")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {approveSeq && r.state === "approved" && hasScope(me, "rollback") && !reversed.has(approveSeq) ? <RollbackControl seq={approveSeq} label="Roll back approval" defaultReason="approved against the wrong cohort" /> : null}
                </div>
              );
            })}
          </div>
        </section>
        {audit.data ? (
          <section className="card span-12" aria-label="Audit" data-testid="audit">
            <div className="card-head">
              <div>
                <h2 className="card-title">Who did what, when, and is the log intact?</h2>
                <div className="card-sub">Append-only, hash-chained action log; the head is anchored daily outside the Durable Object</div>
              </div>
              {verify.data ? <StatusPill status={verify.data.ok ? "good" : "critical"}>{verify.data.ok ? `Chain verified (${verify.data.action_log.rows} actions)` : "Chain does not verify"}</StatusPill> : null}
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>When (synthetic clock)</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Reason</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {[...audit.data.actions].reverse().slice(0, 40).map((a) => (
                    <tr key={a.seq}>
                      <td className="num">{a.seq}</td>
                      <td>{a.created_at.replace("T", " ").replace("Z", "")}</td>
                      <td>
                        {KIND_LABEL[a.kind] ?? a.kind}
                        {a.kind === "approval.refused" ? ` (${JSON.parse(a.payload_json).code})` : ""}
                        {a.reverses_seq ? ` of #${a.reverses_seq}` : ""}
                      </td>
                      <td>{a.actor.replace("@larkspur.example", "")}</td>
                      <td>{a.reason ?? ""}</td>
                      <td className="mono">{a.hash.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}
