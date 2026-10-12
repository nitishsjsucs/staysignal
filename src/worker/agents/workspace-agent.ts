// WorkspaceAgent (SPEC 14.5): one shared instance ("larkspur") holding forecast runs and the published pointer,
// pending approvals, review tasks, the hash-chained action log and approval audit, computed results, engine jobs,
// incidents and routine runs. Clients never write state; every action checks the principal's scopes and writes the log
// in the same synchronous block. The Worker calls these methods over Durable Object RPC after authenticating; browser
// connections call the @callable wrappers, which read the principal the Worker verified at connect time.
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import type { RunBrief } from "../../shared/contracts";
import { syntheticNow } from "../../shared/clock";
import { isReadOnly, type Principal } from "../../shared/policy/roles";
import { hasScope } from "../../shared/policy/roles";
import { DEMO, jobKeyInput, type JobSpec, runIdFor } from "../../shared/routines/definitions";
import type { ReviewDraft, ToolResult } from "../../shared/tools/registry";
import { PRINCIPAL_HEADER } from "../auth/principal";
import { APPROVAL_MESSAGES, type ApprovalRefusalCode, approvalRefusal, type PendingApproval } from "../store/approvals";
import { chainHash, sha256HexSync, verifyChain } from "../store/chain";
import { GENESIS_HASH, WORKSPACE_DDL } from "../store/schema.sql";
import { warehouseFor } from "../warehouse/client";

export interface RunBriefState {
  runId: string;
  status: string;
  cutoff: string;
  version: number;
  mapping: string;
}

export interface WorkspaceState {
  published: { runId: string; cutoff: string; version: number } | null;
  recentRuns: RunBriefState[];
  routineRuns: { routineId: string; status: string; step: string; updatedAt: string }[];
  pendingApprovals: { subjectId: string; kind: string; proposer: string; title: string }[];
  openIncidents: { incidentId: string; runId: string; checks: string[] }[];
  auditHead: { seq: number; hash: string; anchoredAt: string | null };
  mapping: { payroll: string };
  demoEpoch: number;
  epochStartMs: number;
}

export interface ActionRow {
  seq: number;
  action_id: string;
  kind: string;
  actor: string;
  actor_kind: string;
  routine_run_id: string | null;
  payload_json: string;
  reason: string | null;
  reversible: "pointer" | "compensating" | "none";
  reverses_seq: number | null;
  prev_hash: string;
  hash: string;
  created_at: string;
}

export type ActionOutcome<T = unknown> = { ok: true; value: T; auditHead: WorkspaceState["auditHead"] } | { ok: false; code: string; message: string; auditHead: WorkspaceState["auditHead"] };

const LEASE_MS = 120_000;

export class WorkspaceAgent extends Agent<Env, WorkspaceState> {
  override initialState: WorkspaceState = {
    published: null,
    recentRuns: [],
    routineRuns: [],
    pendingApprovals: [],
    openIncidents: [],
    auditHead: { seq: 0, hash: GENESIS_HASH, anchoredAt: null },
    mapping: { payroll: "payroll@1" },
    demoEpoch: 1,
    epochStartMs: 0,
  };

  override async onStart(): Promise<void> {
    for (const ddl of WORKSPACE_DDL) this.ctx.storage.sql.exec(ddl);
    const seeded = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM forecast_runs`[0]?.n ?? 0;
    if (seeded === 0) await this.seed();
    else this.refreshState();
  }

  override validateStateChange(_next: WorkspaceState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("WorkspaceAgent state is server-authoritative");
  }

  override shouldConnectionBeReadonly(_c: Connection, ctx: ConnectionContext): boolean {
    const p = principalFromHeader(ctx.request);
    return !p || isReadOnly(p);
  }

  override onConnect(connection: Connection, ctx: ConnectionContext): void {
    const p = principalFromHeader(ctx.request);
    if (!p) {
      connection.close(4401, "unauthenticated");
      return;
    }
    connection.setState({ principal: p });
  }

  // ---------- clock, ids, state ----------

  now(): string {
    return syntheticNow(Date.now(), this.state.epochStartMs || Date.now());
  }

  private meta(key: string): string | null {
    return this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  private nextId(prefix: string): string {
    const n = Number(this.meta(`seq:${prefix}`) ?? "0") + 1;
    this.setMeta(`seq:${prefix}`, String(n));
    return `${prefix}-${String(n).padStart(4, "0")}`;
  }

  refreshState(): void {
    const pub = this.sql<{ run_id: string }>`SELECT run_id FROM published_pointer WHERE scope = 'company'`[0];
    const runs = this.sql<{ run_id: string; status: string; cutoff: string; version: number; mapping: string }>`SELECT run_id, status, cutoff, version, mapping FROM forecast_runs ORDER BY cutoff DESC, version DESC LIMIT 10`;
    const pubRun = pub ? this.sql<{ run_id: string; cutoff: string; version: number }>`SELECT run_id, cutoff, version FROM forecast_runs WHERE run_id = ${pub.run_id}`[0] : undefined;
    const routines = this.sql<{ routine_id: string; status: string; steps_json: string; updated_at: string }>`SELECT routine_id, status, steps_json, updated_at FROM routine_runs ORDER BY created_at DESC LIMIT 10`;
    const pending = this.sql<{ subject_id: string; subject_kind: string; proposer: string; payload_json: string }>`SELECT subject_id, subject_kind, proposer, payload_json FROM approvals WHERE status = 'pending' ORDER BY created_at`;
    const incidents = this.sql<{ incident_id: string; run_id: string; payload_json: string }>`SELECT incident_id, run_id, payload_json FROM incidents WHERE status = 'open' ORDER BY created_at`;
    const head = this.sql<{ seq: number; hash: string }>`SELECT seq, hash FROM action_log ORDER BY seq DESC LIMIT 1`[0];
    const anchor = this.sql<{ day: string }>`SELECT day FROM anchors WHERE chain = 'action_log' ORDER BY day DESC LIMIT 1`[0];
    const mapping = this.sql<{ version: string }>`SELECT version FROM mapping_pointer WHERE source = 'payroll'`[0];
    this.setState({
      ...this.state,
      published: pubRun ? { runId: pubRun.run_id, cutoff: pubRun.cutoff, version: pubRun.version } : null,
      recentRuns: runs.map((r) => ({ runId: r.run_id, status: r.status, cutoff: r.cutoff, version: r.version, mapping: r.mapping })),
      routineRuns: routines.map((r) => {
        const steps = JSON.parse(r.steps_json) as { step: string }[];
        return { routineId: r.routine_id, status: r.status, step: steps[steps.length - 1]?.step ?? "", updatedAt: r.updated_at };
      }),
      pendingApprovals: pending.map((a) => ({ subjectId: a.subject_id, kind: a.subject_kind, proposer: a.proposer, title: String((JSON.parse(a.payload_json) as { title?: string }).title ?? a.subject_id) })),
      openIncidents: incidents.map((i) => ({ incidentId: i.incident_id, runId: i.run_id, checks: ((JSON.parse(i.payload_json) as { failing?: string[] }).failing ?? []) })),
      auditHead: { seq: head?.seq ?? 0, hash: head?.hash ?? GENESIS_HASH, anchoredAt: anchor?.day ?? null },
      mapping: { payroll: mapping?.version ?? "payroll@1" },
    });
  }

  private async seed(): Promise<void> {
    const wh = warehouseFor(this.env);
    const index = await wh.runs();
    if (!this.state.epochStartMs) this.setState({ ...this.state, epochStartMs: Date.now() });
    this.appendAction({ kind: "genesis", actor: "system", actor_kind: "routine", payload: { label: "synthetic", note: "StaySignal workspace for Larkspur Systems (synthetic)" }, reversible: "none" });
    for (const r of index.runs) this.insertRun(r);
    this.sql`INSERT OR REPLACE INTO mapping_pointer (source, version, action_seq) VALUES ('payroll', 'payroll@1', 1)`;
    const seq = this.appendAction({ kind: "run.publish", actor: "system", actor_kind: "routine", payload: { run_id: index.published, previous_run_id: null, policy: "seed" }, reversible: "none" });
    this.sql`INSERT OR REPLACE INTO published_pointer (scope, run_id, action_seq) VALUES ('company', ${index.published}, ${seq})`;
    this.refreshState();
  }

  private insertRun(r: RunBrief): void {
    this.sql`INSERT OR REPLACE INTO forecast_runs (run_id, version, run_key, cutoff, vintage, model_version, metric_def, mapping, status, result_hash, manifest_json, incident_id)
      VALUES (${r.run_id}, ${r.version}, ${r.run_key}, ${r.cutoff}, ${r.vintage}, ${r.model}, ${r.metric_def}, ${r.mapping}, ${r.status}, ${r.result_hash}, ${JSON.stringify(r)}, ${r.incident_id ?? null})`;
  }

  // ---------- action log ----------

  appendAction(a: { kind: string; actor: string; actor_kind: "human" | "agent" | "routine"; payload: unknown; reason?: string | null; reversible: ActionRow["reversible"]; reverses_seq?: number | null; routine_run_id?: string | null }): number {
    const last = this.sql<{ seq: number; hash: string }>`SELECT seq, hash FROM action_log ORDER BY seq DESC LIMIT 1`[0];
    const seq = (last?.seq ?? 0) + 1;
    const row = {
      seq,
      action_id: `act_${String(seq).padStart(6, "0")}`,
      kind: a.kind,
      actor: a.actor,
      actor_kind: a.actor_kind,
      routine_run_id: a.routine_run_id ?? null,
      payload_json: JSON.stringify(a.payload ?? {}),
      reason: a.reason ?? null,
      reversible: a.reversible,
      reverses_seq: a.reverses_seq ?? null,
      prev_hash: last?.hash ?? GENESIS_HASH,
      created_at: this.now(),
    };
    const hash = chainHash(row.prev_hash, row);
    this.sql`INSERT INTO action_log (seq, action_id, kind, actor, actor_kind, routine_run_id, payload_json, reason, reversible, reverses_seq, prev_hash, hash, created_at)
      VALUES (${row.seq}, ${row.action_id}, ${row.kind}, ${row.actor}, ${row.actor_kind}, ${row.routine_run_id}, ${row.payload_json}, ${row.reason}, ${row.reversible}, ${row.reverses_seq}, ${row.prev_hash}, ${hash}, ${row.created_at})`;
    return seq;
  }

  private appendApprovalAudit(a: { subject_kind: string; subject_id: string; proposer: string; decision: string; refusal_code: string | null; decided_by: string; decided_role: string; reason: string | null; workflow_instance_id: string | null }): number {
    const last = this.sql<{ seq: number; hash: string }>`SELECT seq, hash FROM approval_audit ORDER BY seq DESC LIMIT 1`[0];
    const row = { seq: (last?.seq ?? 0) + 1, ...a, prev_hash: last?.hash ?? GENESIS_HASH, decided_at: this.now() };
    const hash = chainHash(row.prev_hash, row);
    this.sql`INSERT INTO approval_audit (seq, workflow_instance_id, subject_kind, subject_id, proposer, decision, refusal_code, decided_by, decided_role, reason, prev_hash, hash, decided_at)
      VALUES (${row.seq}, ${row.workflow_instance_id}, ${row.subject_kind}, ${row.subject_id}, ${row.proposer}, ${row.decision}, ${row.refusal_code}, ${row.decided_by}, ${row.decided_role}, ${row.reason}, ${row.prev_hash}, ${hash}, ${row.decided_at})`;
    return row.seq;
  }

  auditLog(since = 0): ActionRow[] {
    return this.sql<ActionRow>`SELECT * FROM action_log WHERE seq > ${since} ORDER BY seq`;
  }

  approvalAuditLog(): Record<string, unknown>[] {
    return this.sql`SELECT * FROM approval_audit ORDER BY seq`;
  }

  verifyAudit(): { ok: boolean; action_log: ReturnType<typeof verifyChain>; approval_audit: ReturnType<typeof verifyChain>; anchor: { day: string; head_seq: number; head_hash: string; matches: boolean } | null } {
    const log = verifyChain(this.sql`SELECT * FROM action_log ORDER BY seq`, GENESIS_HASH);
    const appr = verifyChain(this.sql`SELECT * FROM approval_audit ORDER BY seq`, GENESIS_HASH);
    const a = this.sql<{ day: string; head_seq: number; head_hash: string }>`SELECT day, head_seq, head_hash FROM anchors WHERE chain = 'action_log' ORDER BY day DESC LIMIT 1`[0];
    let anchor = null;
    if (a) {
      const row = this.sql<{ hash: string }>`SELECT hash FROM action_log WHERE seq = ${a.head_seq}`[0];
      anchor = { ...a, matches: row?.hash === a.head_hash };
    }
    return { ok: log.ok && appr.ok && (anchor === null || anchor.matches), action_log: log, approval_audit: appr, anchor };
  }

  /** Records today's chain heads; the caller also writes them outside the Durable Object (var/anchors, R2). */
  anchor(day: string, where: string): { day: string; heads: { chain: string; head_seq: number; head_hash: string }[] } {
    const heads = [];
    for (const chain of ["action_log", "approval_audit"]) {
      const h = chain === "action_log" ? this.sql<{ seq: number; hash: string }>`SELECT seq, hash FROM action_log ORDER BY seq DESC LIMIT 1`[0] : this.sql<{ seq: number; hash: string }>`SELECT seq, hash FROM approval_audit ORDER BY seq DESC LIMIT 1`[0];
      if (!h) continue;
      this.sql`INSERT OR REPLACE INTO anchors (day, chain, head_seq, head_hash, anchored_in) VALUES (${day}, ${chain}, ${h.seq}, ${h.hash}, ${where})`;
      heads.push({ chain, head_seq: h.seq, head_hash: h.hash });
    }
    this.refreshState();
    return { day, heads };
  }

  // ---------- results, drafts, traces ----------

  storeResult(result: ToolResult<unknown>, owner: string): void {
    this.sql`INSERT OR IGNORE INTO results (result_id, tool, owner, payload_json, created_at) VALUES (${result.result_id}, ${result.tool}, ${owner}, ${JSON.stringify(result)}, ${this.now()})`;
  }

  getResult(resultId: string): ToolResult<unknown> | null {
    const r = this.sql<{ payload_json: string }>`SELECT payload_json FROM results WHERE result_id = ${resultId}`[0];
    return r ? (JSON.parse(r.payload_json) as ToolResult<unknown>) : null;
  }

  saveDraft(draft: ReviewDraft, owner: string): void {
    this.sql`INSERT OR REPLACE INTO drafts (draft_id, cohort_id, created_by, payload_json, created_at) VALUES (${draft.draft_id}, ${draft.cohort_id}, ${owner}, ${JSON.stringify(draft)}, ${this.now()})`;
  }

  getDraft(draftId: string): ReviewDraft | null {
    const r = this.sql<{ payload_json: string }>`SELECT payload_json FROM drafts WHERE draft_id = ${draftId}`[0];
    return r ? (JSON.parse(r.payload_json) as ReviewDraft) : null;
  }

  storeTrace(traceId: string, owner: string, payload: unknown): void {
    this.sql`INSERT OR REPLACE INTO traces (trace_id, owner, payload_json, created_at) VALUES (${traceId}, ${owner}, ${JSON.stringify(payload)}, ${this.now()})`;
  }

  getTrace(traceId: string): { owner: string; created_at: string; payload_json: string } | null {
    const r = this.sql<{ owner: string; created_at: string; payload_json: string }>`SELECT owner, created_at, payload_json FROM traces WHERE trace_id = ${traceId}`[0];
    return r ? { owner: r.owner, created_at: r.created_at, payload_json: r.payload_json } : null;
  }

  /** The most recent traces, of one owner or of everyone (the caller checks the scope, SPEC 14.12). */
  listTraces(owner: string | null, limit: number): { trace_id: string; owner: string; created_at: string; payload_json: string }[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = owner
      ? this.sql<{ trace_id: string; owner: string; created_at: string; payload_json: string }>`SELECT trace_id, owner, created_at, payload_json FROM traces WHERE owner = ${owner} ORDER BY created_at DESC, trace_id LIMIT ${n}`
      : this.sql<{ trace_id: string; owner: string; created_at: string; payload_json: string }>`SELECT trace_id, owner, created_at, payload_json FROM traces ORDER BY created_at DESC, trace_id LIMIT ${n}`;
    return rows.map((r) => ({ trace_id: r.trace_id, owner: r.owner, created_at: r.created_at, payload_json: r.payload_json }));
  }

  // ---------- runs ----------

  listRuns(): RunBrief[] {
    return this.sql<{ manifest_json: string; status: string; incident_id: string | null }>`SELECT manifest_json, status, incident_id FROM forecast_runs ORDER BY cutoff, version`.map((r) => ({ ...(JSON.parse(r.manifest_json) as RunBrief), status: r.status as RunBrief["status"], ...(r.incident_id ? { incident_id: r.incident_id } : {}) }));
  }

  publishedRunId(): string | null {
    return this.sql<{ run_id: string }>`SELECT run_id FROM published_pointer WHERE scope = 'company'`[0]?.run_id ?? null;
  }

  activeMapping(): string {
    return this.sql<{ version: string }>`SELECT version FROM mapping_pointer WHERE source = 'payroll'`[0]?.version ?? "payroll@1";
  }

  nextRunVersion(cutoff: string): number {
    return (this.sql<{ v: number | null }>`SELECT MAX(version) AS v FROM forecast_runs WHERE cutoff = ${cutoff}`[0]?.v ?? 0) + 1;
  }

  registerRun(brief: RunBrief, routineId: string | null): void {
    this.insertRun({ ...brief, status: "candidate" });
    this.appendAction({ kind: "run.register", actor: "routine", actor_kind: "routine", routine_run_id: routineId, payload: { run_id: brief.run_id, result_hash: brief.result_hash, mapping: brief.mapping }, reversible: "none" });
    this.refreshState();
  }

  holdRun(runId: string, failing: string[], routineId: string | null): string {
    const incidentId = this.nextId("INC-2026-10-05");
    this.sql`UPDATE forecast_runs SET status = 'held', incident_id = ${incidentId} WHERE run_id = ${runId}`;
    this.sql`INSERT OR REPLACE INTO incidents (incident_id, run_id, status, payload_json, created_at) VALUES (${incidentId}, ${runId}, 'open', ${JSON.stringify({ failing, run_id: runId })}, ${this.now()})`;
    this.appendAction({ kind: "run.hold", actor: "routine", actor_kind: "routine", routine_run_id: routineId, payload: { run_id: runId, incident_id: incidentId, failing }, reversible: "none" });
    this.refreshState();
    return incidentId;
  }

  updateIncident(incidentId: string, patch: Record<string, unknown>): void {
    const r = this.sql<{ payload_json: string }>`SELECT payload_json FROM incidents WHERE incident_id = ${incidentId}`[0];
    if (!r) return;
    const next = { ...(JSON.parse(r.payload_json) as Record<string, unknown>), ...patch };
    this.sql`UPDATE incidents SET payload_json = ${JSON.stringify(next)} WHERE incident_id = ${incidentId}`;
    this.refreshState();
  }

  getIncident(incidentId: string): Record<string, unknown> | null {
    const r = this.sql<{ payload_json: string; status: string; run_id: string; created_at: string }>`SELECT payload_json, status, run_id, created_at FROM incidents WHERE incident_id = ${incidentId}`[0];
    return r ? { incident_id: incidentId, status: r.status, run_id: r.run_id, created_at: r.created_at, ...(JSON.parse(r.payload_json) as Record<string, unknown>) } : null;
  }

  listIncidents(): Record<string, unknown>[] {
    return this.sql<{ incident_id: string }>`SELECT incident_id FROM incidents ORDER BY created_at`.map((r) => this.getIncident(r.incident_id) as Record<string, unknown>);
  }

  /** Publication is a pointer move (ADR 0005); the previous run stays in the history and rollback restores it. */
  publishRun(runId: string, actor: string, actorKind: "human" | "routine", policy: string, routineId: string | null): number {
    const prev = this.publishedRunId();
    const status = this.sql<{ status: string }>`SELECT status FROM forecast_runs WHERE run_id = ${runId}`[0]?.status;
    if (status === "held") throw new Error("a held run can never be published");
    const seq = this.appendAction({ kind: "run.publish", actor, actor_kind: actorKind, routine_run_id: routineId, payload: { run_id: runId, previous_run_id: prev, policy }, reversible: "pointer" });
    this.sql`INSERT OR REPLACE INTO published_pointer (scope, run_id, action_seq) VALUES ('company', ${runId}, ${seq})`;
    this.sql`UPDATE forecast_runs SET status = 'published' WHERE run_id = ${runId}`;
    if (prev && prev !== runId) this.sql`UPDATE forecast_runs SET status = 'superseded' WHERE run_id = ${prev} AND status = 'published'`;
    this.refreshState();
    return seq;
  }

  /** Publication without throwing: a held run is refused with HELD_RUN (ADR 0005). */
  tryPublishRun(runId: string, actor: string, policy: string): { ok: true; seq: number } | { ok: false; code: string } {
    const status = this.sql<{ status: string }>`SELECT status FROM forecast_runs WHERE run_id = ${runId}`[0]?.status;
    if (status === undefined) return { ok: false, code: "NOT_FOUND" };
    if (status === "held") return { ok: false, code: "HELD_RUN" };
    return { ok: true, seq: this.publishRun(runId, actor, "human", policy, null) };
  }

  recordReplay(runId: string, replay: { replay_hash: string; equal: boolean; duration_ms: number; detail: unknown }): void {
    this.sql`INSERT INTO replays (run_id, replay_hash, equal, duration_ms, detail_json, created_at) VALUES (${runId}, ${replay.replay_hash}, ${replay.equal ? 1 : 0}, ${replay.duration_ms}, ${JSON.stringify(replay.detail)}, ${this.now()})`;
    this.appendAction({ kind: "replay.record", actor: "routine", actor_kind: "routine", payload: { run_id: runId, replay_hash: replay.replay_hash, equal: replay.equal, duration_ms: replay.duration_ms }, reversible: "none" });
    this.refreshState();
  }

  listReplays(runId: string): Record<string, unknown>[] {
    return this.sql<{ replay_hash: string; equal: number; duration_ms: number; detail_json: string; created_at: string }>`SELECT replay_hash, equal, duration_ms, detail_json, created_at FROM replays WHERE run_id = ${runId} ORDER BY created_at`.map((r) => ({
      run_id: runId,
      replay_hash: r.replay_hash,
      equal: r.equal === 1,
      duration_ms: r.duration_ms,
      created_at: r.created_at,
      ...(JSON.parse(r.detail_json) as Record<string, unknown>),
    }));
  }

  // ---------- reviews and approvals ----------

  private subjectHash(kind: string, payload: unknown): string {
    return sha256HexSync(`${kind}|${JSON.stringify(payload)}`);
  }

  submitReview(p: Principal, draftId: string): ActionOutcome<{ review_id: string }> {
    const head = () => this.state.auditHead;
    if (!hasScope(p, "review:propose") && !hasScope(p, "review:propose:assigned")) return { ok: false, code: "NOT_PERMITTED", message: "Your role cannot submit reviews.", auditHead: head() };
    if (p.kind !== "human") return { ok: false, code: "AGENT_PRINCIPAL", message: APPROVAL_MESSAGES.AGENT_PRINCIPAL, auditHead: head() };
    const draft = this.getDraft(draftId);
    if (!draft) return { ok: false, code: "NOT_FOUND", message: "No such draft.", auditHead: head() };
    const reviewId = this.nextId("REV");
    const payload = { title: `People Partner review: ${draft.cohort}`, draft };
    this.sql`INSERT INTO reviews (review_id, draft_id, cohort_id, proposer, state, payload_json, created_at) VALUES (${reviewId}, ${draftId}, ${draft.cohort_id}, ${p.id}, 'submitted', ${JSON.stringify(payload)}, ${this.now()})`;
    this.sql`INSERT INTO approvals (subject_id, subject_kind, proposer, proposer_kind, required_scope, status, payload_json, subject_hash, workflow_instance_id, created_at)
      VALUES (${reviewId}, 'review', ${p.id}, 'human', 'review:approve', 'pending', ${JSON.stringify(payload)}, ${this.subjectHash("review", draft)}, NULL, ${this.now()})`;
    this.appendAction({ kind: "review.submit", actor: p.id, actor_kind: "human", payload: { review_id: reviewId, draft_id: draftId, cohort_id: draft.cohort_id, proposer_of_record: p.id }, reversible: "none" });
    this.refreshState();
    return { ok: true, value: { review_id: reviewId }, auditHead: this.state.auditHead };
  }

  proposeMapping(proposal: { proposal_id: string; source: string; from: string; to: string; diff: unknown; evidence: unknown; incident_id: string }, routineId: string | null): void {
    const payload = { title: `Payroll mapping change ${proposal.from} to ${proposal.to}`, ...proposal };
    const instance = routineId ? (this.sql<{ workflow_instance_id: string | null }>`SELECT workflow_instance_id FROM routine_runs WHERE routine_id = ${routineId}`[0]?.workflow_instance_id ?? null) : null;
    this.sql`INSERT OR IGNORE INTO approvals (subject_id, subject_kind, proposer, proposer_kind, required_scope, status, payload_json, subject_hash, workflow_instance_id, created_at)
      VALUES (${proposal.proposal_id}, 'mapping', 'agent:staysignal', 'agent', 'mapping:approve', 'pending', ${JSON.stringify(payload)}, ${this.subjectHash("mapping", proposal.diff)}, ${instance}, ${this.now()})`;
    this.appendAction({ kind: "mapping.propose", actor: "agent:staysignal", actor_kind: "agent", routine_run_id: routineId, payload: { proposal_id: proposal.proposal_id, from: proposal.from, to: proposal.to, incident_id: proposal.incident_id, note: "generated deterministically from evidence; the agent is the proposer of record (ADR 0006 exception)" }, reversible: "none" });
    this.refreshState();
  }

  getApproval(subjectId: string): (PendingApproval & { payload: Record<string, unknown>; decided_at: string | null; created_at: string }) | null {
    const r = this.sql<PendingApproval & { payload_json: string; decided_at: string | null; created_at: string }>`SELECT * FROM approvals WHERE subject_id = ${subjectId}`[0];
    return r ? { ...r, payload: JSON.parse(r.payload_json) as Record<string, unknown> } : null;
  }

  listApprovals(): ReturnType<WorkspaceAgent["getApproval"]>[] {
    return this.sql<{ subject_id: string }>`SELECT subject_id FROM approvals ORDER BY created_at`.map((r) => this.getApproval(r.subject_id));
  }

  private currentSubjectHash(a: PendingApproval & { payload: Record<string, unknown> }): string {
    if (a.subject_kind === "review") {
      const draftId = (a.payload.draft as ReviewDraft | undefined)?.draft_id ?? "";
      return this.subjectHash("review", this.getDraft(draftId));
    }
    if (a.subject_kind === "mapping") return this.subjectHash("mapping", a.payload.diff);
    return a.subject_hash;
  }

  approve(p: Principal, subjectId: string, reason: string | null): ActionOutcome<{ subject_id: string; task_ids?: string[]; action_seq: number }> {
    const a = this.getApproval(subjectId);
    if (!a) return { ok: false, code: "NOT_FOUND", message: "No such subject.", auditHead: this.state.auditHead };
    const refusal = approvalRefusal(p, a, this.currentSubjectHash(a));
    if (refusal) return this.refuseApproval(p, a, refusal, reason);
    this.appendApprovalAudit({ subject_kind: a.subject_kind, subject_id: subjectId, proposer: a.proposer, decision: "approved", refusal_code: null, decided_by: p.id, decided_role: p.role, reason, workflow_instance_id: a.workflow_instance_id ?? null });
    this.sql`UPDATE approvals SET status = 'approved', decided_at = ${this.now()} WHERE subject_id = ${subjectId}`;
    let taskIds: string[] | undefined;
    let seq: number;
    if (a.subject_kind === "review") {
      const draft = a.payload.draft as ReviewDraft;
      seq = this.appendAction({ kind: "review.approve", actor: p.id, actor_kind: "human", payload: { review_id: subjectId, cohort_id: draft.cohort_id, proposer: a.proposer }, reason, reversible: "compensating" });
      taskIds = [];
      const owner = ownerRoleFor(draft.cohort_id);
      for (const check of draft.checks) {
        const taskId = this.nextId("TASK");
        taskIds.push(taskId);
        const blocking = check.category === "compensation" ? draft.blocking_items : [];
        this.sql`INSERT INTO review_tasks (task_id, review_id, cohort_ref, category, owner_role, checks_json, evidence_json, blocking_items_json, status, created_by_seq)
          VALUES (${taskId}, ${subjectId}, ${draft.cohort_id}, ${check.category}, ${owner}, ${JSON.stringify(check)}, ${JSON.stringify(check.evidence)}, ${JSON.stringify(blocking)}, 'open', ${seq})`;
      }
      this.sql`UPDATE reviews SET state = 'approved' WHERE review_id = ${subjectId}`;
    } else if (a.subject_kind === "mapping") {
      const prev = this.activeMapping();
      const to = String(a.payload.to);
      seq = this.appendAction({ kind: "mapping.activate", actor: p.id, actor_kind: "human", payload: { proposal_id: subjectId, source: "payroll", from: prev, to, proposer: a.proposer }, reason, reversible: "pointer" });
      this.sql`INSERT OR REPLACE INTO mapping_pointer (source, version, action_seq) VALUES ('payroll', ${to}, ${seq})`;
    } else {
      const runId = String(a.payload.run_id);
      seq = this.publishRun(runId, p.id, "human", "publish:approve", null);
    }
    this.refreshState();
    return { ok: true, value: { subject_id: subjectId, ...(taskIds ? { task_ids: taskIds } : {}), action_seq: seq }, auditHead: this.state.auditHead };
  }

  /** Sends the approval wake-up to the waiting workflow after the decision is written (ADR 0016). */
  async wakeApproval(subjectId: string): Promise<void> {
    const a = this.getApproval(subjectId);
    if (!a?.workflow_instance_id || a.status === "pending") return;
    try {
      await this.sendWorkflowEvent("ROUTINE_WORKFLOW", a.workflow_instance_id, { type: `approve_${a.subject_kind}_${subjectId}`, payload: { subject_id: subjectId } });
    } catch {
      // the gate re-checks SQLite on its next wake or timeout
    }
  }

  reject(p: Principal, subjectId: string, reason: string | null): ActionOutcome<{ subject_id: string }> {
    const a = this.getApproval(subjectId);
    if (!a) return { ok: false, code: "NOT_FOUND", message: "No such subject.", auditHead: this.state.auditHead };
    const refusal = approvalRefusal(p, a, this.currentSubjectHash(a));
    if (refusal && refusal !== "STALE_SUBJECT") return this.refuseApproval(p, a, refusal, reason);
    this.appendApprovalAudit({ subject_kind: a.subject_kind, subject_id: subjectId, proposer: a.proposer, decision: "rejected", refusal_code: null, decided_by: p.id, decided_role: p.role, reason, workflow_instance_id: a.workflow_instance_id ?? null });
    this.sql`UPDATE approvals SET status = 'rejected', decided_at = ${this.now()} WHERE subject_id = ${subjectId}`;
    if (a.subject_kind === "review") this.sql`UPDATE reviews SET state = 'rejected' WHERE review_id = ${subjectId}`;
    this.appendAction({ kind: `${a.subject_kind}.reject`, actor: p.id, actor_kind: "human", payload: { subject_id: subjectId }, reason, reversible: "none" });
    this.refreshState();
    return { ok: true, value: { subject_id: subjectId }, auditHead: this.state.auditHead };
  }

  private refuseApproval(p: Principal, a: PendingApproval, code: ApprovalRefusalCode, reason: string | null): ActionOutcome<never> {
    if (code !== "NOT_PENDING") {
      this.appendApprovalAudit({ subject_kind: a.subject_kind, subject_id: a.subject_id, proposer: a.proposer, decision: "refused", refusal_code: code, decided_by: p.id, decided_role: p.role, reason, workflow_instance_id: null });
      this.appendAction({ kind: "approval.refused", actor: p.id, actor_kind: p.kind === "human" ? "human" : "agent", payload: { subject_id: a.subject_id, subject_kind: a.subject_kind, code }, reason, reversible: "none" });
      this.refreshState();
    }
    return { ok: false, code, message: APPROVAL_MESSAGES[code], auditHead: this.state.auditHead };
  }

  /** Rollback adds a new action that reverses an earlier one; nothing is deleted (SPEC 14.8). */
  rollback(p: Principal, seq: number, reason: string): ActionOutcome<{ action_seq: number; reverses_seq: number }> {
    if (!hasScope(p, "rollback")) return { ok: false, code: "WRONG_ROLE", message: APPROVAL_MESSAGES.WRONG_ROLE, auditHead: this.state.auditHead };
    if (!reason || !reason.trim()) return { ok: false, code: "REASON_REQUIRED", message: "A rollback needs a reason.", auditHead: this.state.auditHead };
    const target = this.sql<ActionRow>`SELECT * FROM action_log WHERE seq = ${seq}`[0];
    if (!target) return { ok: false, code: "NOT_FOUND", message: "No such action.", auditHead: this.state.auditHead };
    const already = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM action_log WHERE reverses_seq = ${seq}`[0]?.n ?? 0;
    if (already > 0) return { ok: false, code: "ALREADY_REVERSED", message: "That action has already been rolled back.", auditHead: this.state.auditHead };
    const payload = JSON.parse(target.payload_json) as Record<string, unknown>;
    let effect: Record<string, unknown> = {};
    let kind = target.kind;
    if (target.kind === "rollback") {
      // rolling back a rollback re-applies the original action
      const original = this.sql<ActionRow>`SELECT * FROM action_log WHERE seq = ${target.reverses_seq}`[0];
      if (!original) return { ok: false, code: "NOT_FOUND", message: "Original action missing.", auditHead: this.state.auditHead };
      kind = original.kind;
      effect = this.applyReversal(original, JSON.parse(original.payload_json) as Record<string, unknown>, true);
    } else if (target.reversible === "none") {
      return { ok: false, code: "NOT_REVERSIBLE", message: "That action cannot be reversed.", auditHead: this.state.auditHead };
    } else {
      effect = this.applyReversal(target, payload, false);
    }
    const newSeq = this.appendAction({ kind: "rollback", actor: p.id, actor_kind: "human", payload: { reverses_kind: target.kind, original_kind: kind, effect }, reason, reversible: "compensating", reverses_seq: seq });
    this.fixPointerSeq(effect, newSeq);
    this.refreshState();
    return { ok: true, value: { action_seq: newSeq, reverses_seq: seq }, auditHead: this.state.auditHead };
  }

  private applyReversal(action: ActionRow, payload: Record<string, unknown>, reapply: boolean): Record<string, unknown> {
    if (action.kind === "run.publish") {
      const to = reapply ? String(payload.run_id) : (payload.previous_run_id as string | null);
      if (!to) return { note: "no previous run" };
      const current = this.publishedRunId();
      this.sql`INSERT OR REPLACE INTO published_pointer (scope, run_id, action_seq) VALUES ('company', ${to}, ${action.seq})`;
      this.sql`UPDATE forecast_runs SET status = 'published' WHERE run_id = ${to}`;
      if (current && current !== to) this.sql`UPDATE forecast_runs SET status = 'superseded' WHERE run_id = ${current}`;
      return { pointer: "published", from: current, to };
    }
    if (action.kind === "mapping.activate") {
      const to = String(reapply ? payload.to : payload.from);
      this.sql`INSERT OR REPLACE INTO mapping_pointer (source, version, action_seq) VALUES ('payroll', ${to}, ${action.seq})`;
      return { pointer: "mapping", to };
    }
    if (action.kind === "review.approve") {
      const status = reapply ? "open" : "cancelled";
      this.sql`UPDATE review_tasks SET status = ${status} WHERE created_by_seq = ${action.seq}`;
      this.sql`UPDATE reviews SET state = ${reapply ? "approved" : "rolled_back"} WHERE review_id = ${String(payload.review_id)}`;
      const tasks = this.sql<{ task_id: string }>`SELECT task_id FROM review_tasks WHERE created_by_seq = ${action.seq}`.map((t) => t.task_id);
      return { tasks, status };
    }
    return {};
  }

  private fixPointerSeq(effect: Record<string, unknown>, seq: number): void {
    if (effect.pointer === "published") this.sql`UPDATE published_pointer SET action_seq = ${seq} WHERE scope = 'company'`;
    if (effect.pointer === "mapping") this.sql`UPDATE mapping_pointer SET action_seq = ${seq} WHERE source = 'payroll'`;
  }

  listReviews(): Record<string, unknown>[] {
    return this.sql<{ review_id: string; draft_id: string; cohort_id: string; proposer: string; state: string; payload_json: string; created_at: string }>`SELECT * FROM reviews ORDER BY created_at`.map((r) => ({
      review_id: r.review_id,
      draft_id: r.draft_id,
      cohort_id: r.cohort_id,
      proposer: r.proposer,
      state: r.state,
      created_at: r.created_at,
      ...(JSON.parse(r.payload_json) as Record<string, unknown>),
      tasks: this.sql`SELECT task_id, category, owner_role, status, blocking_items_json, evidence_json FROM review_tasks WHERE review_id = ${r.review_id} ORDER BY task_id`,
    }));
  }

  reviewTransitions(reviewId: string): { from: string; to: string; by: string; at: string; code: string | null }[] {
    const out: { from: string; to: string; by: string; at: string; code: string | null }[] = [];
    let state = "draft";
    for (const a of this.sql<ActionRow>`SELECT * FROM action_log ORDER BY seq`) {
      const pl = JSON.parse(a.payload_json) as Record<string, unknown>;
      if (a.kind === "review.submit" && pl.review_id === reviewId) {
        out.push({ from: state, to: "submitted", by: a.actor, at: a.created_at, code: null });
        state = "submitted";
      } else if (a.kind === "approval.refused" && pl.subject_id === reviewId) {
        out.push({ from: state, to: "refused", by: a.actor, at: a.created_at, code: String(pl.code) });
      } else if (a.kind === "review.approve" && pl.review_id === reviewId) {
        out.push({ from: state, to: "approved", by: a.actor, at: a.created_at, code: null });
        state = "approved";
        out.push({ from: state, to: "task", by: "workspace", at: a.created_at, code: null });
        state = "task";
      } else if (a.kind === "review.reject" && pl.subject_id === reviewId) {
        out.push({ from: state, to: "rejected", by: a.actor, at: a.created_at, code: null });
        state = "rejected";
      } else if (a.kind === "rollback" && (pl.effect as { tasks?: unknown } | undefined)?.tasks) {
        const target = this.sql<ActionRow>`SELECT * FROM action_log WHERE seq = ${a.reverses_seq}`[0];
        if (target && (JSON.parse(target.payload_json) as Record<string, unknown>).review_id === reviewId) {
          out.push({ from: state, to: "rolled_back", by: a.actor, at: a.created_at, code: null });
          state = "rolled_back";
        }
      }
    }
    return out;
  }

  // ---------- engine jobs (ADR 0002) ----------

  enqueueJob(spec: JobSpec, workflowInstanceId: string | null): { job_key: string; status: string; result: unknown } {
    const key = sha256HexSync(jobKeyInput(spec));
    const existing = this.sql<{ status: string; result_json: string | null }>`SELECT status, result_json FROM engine_jobs WHERE job_key = ${key}`[0];
    if (existing) return { job_key: key, status: existing.status, result: existing.result_json ? JSON.parse(existing.result_json) : null };
    this.sql`INSERT INTO engine_jobs (job_key, kind, params_json, status, lease_owner, lease_expires_at, attempt, result_json, workflow_instance_id, demo_epoch, created_at)
      VALUES (${key}, ${spec.kind}, ${JSON.stringify(spec.params)}, 'queued', NULL, NULL, 0, NULL, ${workflowInstanceId}, ${this.state.demoEpoch}, ${this.now()})`;
    return { job_key: key, status: "queued", result: null };
  }

  getJob(key: string): { job_key: string; kind: string; params: unknown; status: string; result: unknown; attempt: number } | null {
    const r = this.sql<{ job_key: string; kind: string; params_json: string; status: string; result_json: string | null; attempt: number }>`SELECT * FROM engine_jobs WHERE job_key = ${key}`[0];
    return r ? { job_key: r.job_key, kind: r.kind, params: JSON.parse(r.params_json), status: r.status, result: r.result_json ? JSON.parse(r.result_json) : null, attempt: r.attempt } : null;
  }

  /** Leases at most one job (120-second lease); expired leases are re-leased with attempt + 1, at most 3 attempts. */
  leaseJob(owner: string): { job: { job_key: string; kind: string; params: unknown; attempt: number } | null; next_poll_ms: number } {
    const now = Date.now();
    const open = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM engine_jobs WHERE status IN ('queued', 'leased')`[0]?.n ?? 0;
    const r = this.sql<{ job_key: string; kind: string; params_json: string; attempt: number }>`SELECT job_key, kind, params_json, attempt FROM engine_jobs
      WHERE (status = 'queued' OR (status = 'leased' AND lease_expires_at < ${now})) AND attempt < 3 ORDER BY created_at, job_key LIMIT 1`[0];
    if (!r) return { job: null, next_poll_ms: open > 0 ? 2000 : 30000 };
    this.sql`UPDATE engine_jobs SET status = 'leased', lease_owner = ${owner}, lease_expires_at = ${now + LEASE_MS}, attempt = attempt + 1 WHERE job_key = ${r.job_key}`;
    return { job: { job_key: r.job_key, kind: r.kind, params: JSON.parse(r.params_json), attempt: r.attempt + 1 }, next_poll_ms: 2000 };
  }

  heartbeat(key: string, owner: string): boolean {
    const r = this.sql<{ lease_owner: string | null }>`SELECT lease_owner FROM engine_jobs WHERE job_key = ${key} AND status = 'leased'`[0];
    if (!r || r.lease_owner !== owner) return false;
    this.sql`UPDATE engine_jobs SET lease_expires_at = ${Date.now() + LEASE_MS} WHERE job_key = ${key}`;
    return true;
  }

  /** Completion writes the job row first; the caller then sends the workflow wake-up (ADR 0016). Idempotent. */
  async completeJob(key: string, result: unknown, ok = true): Promise<{ accepted: boolean; workflow_instance_id: string | null }> {
    const r = this.sql<{ status: string; workflow_instance_id: string | null }>`SELECT status, workflow_instance_id FROM engine_jobs WHERE job_key = ${key}`[0];
    if (!r) return { accepted: false, workflow_instance_id: null };
    if (r.status === "done" || r.status === "failed") return { accepted: false, workflow_instance_id: r.workflow_instance_id };
    this.sql`UPDATE engine_jobs SET status = ${ok ? "done" : "failed"}, result_json = ${JSON.stringify(result)}, lease_owner = NULL WHERE job_key = ${key}`;
    if (r.workflow_instance_id) {
      try {
        await this.sendWorkflowEvent("ROUTINE_WORKFLOW", r.workflow_instance_id, { type: `job_${key}`, payload: { job_key: key } });
      } catch {
        // a lost wake-up costs one bounded wait; the gate re-checks SQLite
      }
    }
    return { accepted: true, workflow_instance_id: r.workflow_instance_id };
  }

  listJobs(): Record<string, unknown>[] {
    return this.sql`SELECT job_key, kind, params_json, status, attempt, created_at FROM engine_jobs ORDER BY created_at`;
  }

  // ---------- routines ----------

  async startRoutine(p: Principal | null, source: string, period: string): Promise<{ routine_id: string; workflow_instance_id: string }> {
    const routineId = this.nextId("RTN");
    const trigger = { kind: "source_arrival", source, period, by: p?.id ?? "runner", arrived_at: DEMO.arrivedAt };
    this.sql`INSERT INTO routine_runs (routine_id, kind, status, trigger_json, steps_json, workflow_instance_id, demo_epoch, created_at, updated_at)
      VALUES (${routineId}, 'source_arrival_refresh', 'running', ${JSON.stringify(trigger)}, '[]', NULL, ${this.state.demoEpoch}, ${this.now()}, ${this.now()})`;
    this.appendAction({ kind: "source.arrived", actor: p?.id ?? "runner", actor_kind: p ? "human" : "routine", routine_run_id: routineId, payload: { ...trigger, label: p ? "simulated arrival (synthetic)" : "arrival" }, reversible: "none" });
    const instanceId = await this.runWorkflow("ROUTINE_WORKFLOW", { routine_id: routineId, source, period, epoch: this.state.demoEpoch }, { id: `routine-${routineId}-e${this.state.demoEpoch}` });
    this.sql`UPDATE routine_runs SET workflow_instance_id = ${instanceId} WHERE routine_id = ${routineId}`;
    this.refreshState();
    return { routine_id: routineId, workflow_instance_id: instanceId };
  }

  routineStep(routineId: string, step: string, outcome: string, detail: Record<string, unknown> = {}, status?: string): void {
    const r = this.sql<{ steps_json: string }>`SELECT steps_json FROM routine_runs WHERE routine_id = ${routineId}`[0];
    if (!r) return;
    const steps = JSON.parse(r.steps_json) as Record<string, unknown>[];
    steps.push({ step, outcome, at: this.now(), ...detail });
    this.sql`UPDATE routine_runs SET steps_json = ${JSON.stringify(steps)}, updated_at = ${this.now()} WHERE routine_id = ${routineId}`;
    if (status) this.sql`UPDATE routine_runs SET status = ${status} WHERE routine_id = ${routineId}`;
    this.refreshState();
  }

  getRoutine(routineId: string): Record<string, unknown> | null {
    const r = this.sql<{ routine_id: string; kind: string; status: string; trigger_json: string; steps_json: string; workflow_instance_id: string | null; created_at: string; updated_at: string }>`SELECT * FROM routine_runs WHERE routine_id = ${routineId}`[0];
    return r ? { ...r, trigger: JSON.parse(r.trigger_json), steps: JSON.parse(r.steps_json) } : null;
  }

  listRoutines(): Record<string, unknown>[] {
    return this.sql<{ routine_id: string }>`SELECT routine_id FROM routine_runs ORDER BY created_at DESC`.map((r) => this.getRoutine(r.routine_id) as Record<string, unknown>);
  }

  epoch(): number {
    return this.state.demoEpoch;
  }

  routineRunId(cutoff: string): string {
    return runIdFor(cutoff, this.nextRunVersion(cutoff));
  }

  // ---------- callables for browser connections (principal from the verified connect header) ----------

  private callerPrincipal(): Principal {
    const { connection } = getCurrentAgent();
    const p = (connection?.state as { principal?: Principal } | null | undefined)?.principal;
    if (!p) throw new Error("unauthenticated connection");
    return p;
  }

  @callable()
  async submitReviewCallable(draftId: string) {
    return this.submitReview(this.callerPrincipal(), draftId);
  }

  @callable()
  async approveCallable(subjectId: string, reason: string | null) {
    const out = this.approve(this.callerPrincipal(), subjectId, reason);
    if (out.ok) await this.wakeApproval(subjectId);
    return out;
  }

  @callable()
  async rejectCallable(subjectId: string, reason: string | null) {
    const out = this.reject(this.callerPrincipal(), subjectId, reason);
    if (out.ok) await this.wakeApproval(subjectId);
    return out;
  }

  @callable()
  async rollbackCallable(seq: number, reason: string) {
    return this.rollback(this.callerPrincipal(), seq, reason);
  }
}

export function principalFromHeader(request: Request | undefined): Principal | null {
  const raw = request?.headers.get(PRINCIPAL_HEADER);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Principal;
  } catch {
    return null;
  }
}

/** The People Partner role that owns a cohort's tasks (synthetic role mailboxes). */
export function ownerRoleFor(cohortId: string): string {
  const eng = ["Engineering", "Platform Engineering", "Infrastructure", "Data", "Product Engineering", "Security Engineering", "Product & Design", "Product Management", "Design"];
  const name = cohortId.split(":")[1] ?? "";
  return eng.includes(name) ? "people_partner:hrbp-engineering@larkspur.example" : "people_partner:hrbp-gtm@larkspur.example";
}
