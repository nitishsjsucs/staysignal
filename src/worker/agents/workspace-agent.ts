// WorkspaceAgent (SPEC 14.5): one shared instance ("larkspur"), or one per visitor's sandbox ("sbx-<id>") in the public
// demo (ADR 0018), holding forecast runs and the published pointer,
// pending approvals, review tasks, the hash-chained action log and approval audit, computed results, engine jobs,
// incidents and routine runs. Clients never write state; every action checks the principal's scopes and writes the log
// in the same synchronous block. The Worker calls these methods over Durable Object RPC after authenticating; browser
// connections call the @callable wrappers, which read the principal the Worker verified at connect time.
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import type { MemoryCommit, MemoryFileDoc, MemoryFileInfo, MemoryNoteInput, MemoryWriteOutcome, QualityFixture, RunBrief } from "../../shared/contracts";
import { syntheticNow } from "../../shared/clock";
import { isReadOnly, type Principal, ROLES, type Role } from "../../shared/policy/roles";
import { hasScope } from "../../shared/policy/roles";
import { DEMO, jobKeyInput, type JobSpec, runIdFor } from "../../shared/routines/definitions";
import type { ReviewDraft, ToolResult } from "../../shared/tools/registry";
import { PRINCIPAL_HEADER } from "../auth/principal";
import { APPROVAL_MESSAGES, type ApprovalRefusalCode, approvalRefusal, type PendingApproval } from "../store/approvals";
import { chainHash, sha256HexSync, verifyChain } from "../store/chain";
import { GENESIS_HASH, WORKSPACE_DDL } from "../store/schema.sql";
import { parseConfig } from "../config";
import { warehouseFor } from "../warehouse/client";
import { FixturesWarehouse } from "../warehouse/fixtures";
import { canonicalJson } from "../../shared/canonical-json";
import type { AliasMap } from "../../shared/grounding/aliases";
import { agentPrincipal } from "../../shared/policy/roles";
import type { ToolContext } from "../../shared/tools/registry";
import { type Merged, mergeRuns } from "./investigation/merge";
import { runSpecialist, type SpecialistRun } from "./investigation/run";
import { type InvestigationBrief, specialist } from "./investigation/specialists";
import { decisionMemoryNote } from "../memory/notes";
import { blobHash, commitHash, short, treeHash } from "../memory/githash";
import { NoteRejected, writeNote } from "../../shared/memory/write";
import { type MemoryHit, parseAliases, parseNote, searchMemory } from "../../shared/memory/search";
import { writeMemoryNote } from "../memory/writer";
import { CAPS, UNITS } from "../../shared/demo/budget";
import { type AdmitVerdict, UnitMeter } from "../demo/meter";
import { guardFrames } from "../demo/frames";

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
const SANDBOX_PREFIX = "sbx-";

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

  private meter: UnitMeter | null = null;
  private expCache: number | null | undefined = undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // the public demo bounds every WebSocket frame and the frames of each connection (ADR 0018); a sandbox's browser
    // connections only receive state, so every frame they send (state, RPC, anything) is dropped before the SDK sees it
    if ((env as unknown as Record<string, string | undefined>).SS_AUTH_MODE === "demo") guardFrames(this, { filter: (_c, message) => (this.sandboxed ? null : message) });
  }

  override async onStart(): Promise<void> {
    if (this.sandboxed) {
      // a sandbox is seeded only by initSandbox; one woken after its destruction (a late workflow step) seeds nothing,
      // fails every call, and destroys itself shortly after
      if (this.sandboxExp() === null) return this.scheduleOrphanCleanup();
      // a deploy during a sandbox's life may add tables; every statement is idempotent
      for (const ddl of WORKSPACE_DDL) this.ctx.storage.sql.exec(ddl);
      this.refreshState();
      return;
    }
    for (const ddl of WORKSPACE_DDL) this.ctx.storage.sql.exec(ddl);
    const seeded = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM forecast_runs`[0]?.n ?? 0;
    if (seeded === 0) await this.seed();
    else this.refreshState();
  }

  // ---------- the public demo's sandbox lifecycle (ADR 0018) ----------

  /** This instance is a visitor's sandbox in the public demo. */
  get sandboxed(): boolean {
    return this.name.startsWith(SANDBOX_PREFIX);
  }

  /** The sandbox's expiry (seconds since the epoch), or null when it was never initialized or has been destroyed. */
  private sandboxExp(): number | null {
    if (this.expCache !== undefined) return this.expCache;
    const hasMeta = this.ctx.storage.sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0;
    const v = hasMeta ? this.meta("sandbox_exp") : null;
    this.expCache = v === null ? null : Number(v);
    return this.expCache;
  }

  private async cancelExpiry(): Promise<void> {
    for (const s of await this.listSchedules()) if (s.callback === "expireSandbox") await this.cancelSchedule(s.id);
  }

  private async scheduleOrphanCleanup(): Promise<void> {
    if ((await this.listSchedules()).some((s) => s.callback === "expireSandbox")) return;
    await this.schedule(CAPS.orphanCleanupSeconds, "expireSandbox", "orphan", { idempotent: true });
  }

  /** Starts a sandbox from the committed demo state; idempotent. The alarm at the expiry destroys it. */
  async initSandbox(expSeconds: number): Promise<{ exp: number }> {
    if (!this.sandboxed) throw new Error("not a sandbox");
    const existing = this.sandboxExp();
    if (existing !== null) return { exp: existing };
    for (const ddl of WORKSPACE_DDL) this.ctx.storage.sql.exec(ddl);
    this.setMeta("sandbox_exp", String(expSeconds));
    this.expCache = expSeconds;
    await this.seed();
    // the memory store is imported now rather than on the first read, so no single request pays for it
    await this.ensureMemory();
    await this.cancelExpiry();
    await this.schedule(new Date(expSeconds * 1000), "expireSandbox", "expiry");
    return { exp: expSeconds };
  }

  /** Every request of a sandbox is admitted here first: it must be live and within its units (ADR 0018). */
  admit(units: number): AdmitVerdict {
    if (!this.sandboxed) return { ok: true, used: 0 };
    const now = Date.now();
    const exp = this.sandboxExp();
    if (exp === null || exp * 1000 <= now) return { ok: false, code: "SANDBOX_EXPIRED", retryAfterSeconds: 0 };
    this.meter ??= new UnitMeter(Number(this.meta("units_reserved") ?? "0"), (reserved) => this.setMeta("units_reserved", String(reserved)));
    return this.meter.admit(units, now);
  }

  /** Reset: the visitor moved to a fresh sandbox, so this one stops admitting and is destroyed in a few seconds. */
  async retireSandbox(): Promise<void> {
    if (!this.sandboxed || this.sandboxExp() === null) return;
    const now = Math.floor(Date.now() / 1000);
    this.setMeta("sandbox_exp", String(now));
    this.expCache = now;
    await this.cancelExpiry();
    await this.schedule(5, "expireSandbox", "retired");
  }

  /** The alarm callback: deletes everything this sandbox stored. */
  async expireSandbox(): Promise<void> {
    if (!this.sandboxed) return;
    await this.destroy();
  }

  /** Bytes this object stores (the budget test reads it). */
  storedBytes(): number {
    return this.ctx.storage.sql.databaseSize;
  }

  override validateStateChange(_next: WorkspaceState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("WorkspaceAgent state is server-authoritative");
  }

  override shouldConnectionBeReadonly(_c: Connection, ctx: ConnectionContext): boolean {
    const p = principalFromHeader(ctx.request);
    // a sandbox's connections only receive state: every action goes through the admitted HTTP API (the frame guard
    // drops their frames, and each callable refuses in a sandbox as well, since read-only blocks only setState)
    return !p || isReadOnly(p) || this.sandboxed;
  }

  /** A public-demo reason longer than CAPS.maxReasonChars, refused before anything is written (ADR 0018). */
  private reasonTooLong(reason: string | null | undefined): ActionOutcome<never> | null {
    if (!this.sandboxed || typeof reason !== "string" || reason.length <= CAPS.maxReasonChars) return null;
    return { ok: false, code: "REASON_TOO_LONG", message: `Reasons are limited to ${CAPS.maxReasonChars} characters in the public demo.`, auditHead: this.state.auditHead };
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

  // ---------- the daily neuron budget (SPEC 14.11) ----------

  /** Reserves neurons for one model turn if they fit under today's cap (UTC day); otherwise changes nothing. A
   * Durable Object runs one call at a time and nothing here awaits, so concurrent turns can never exceed the cap. */
  reserveNeurons(neurons: number, cap: number): { ok: boolean; used: number; cap: number; day: string } {
    const day = new Date().toISOString().slice(0, 10);
    const want = Math.ceil(neurons);
    if (!Number.isFinite(want) || want < 0 || !Number.isFinite(cap)) return { ok: false, used: 0, cap, day };
    const used = this.sql<{ neurons: number }>`SELECT neurons FROM ai_usage WHERE day = ${day}`[0]?.neurons ?? 0;
    if (used + want > cap) return { ok: false, used, cap, day };
    this.sql`INSERT INTO ai_usage (day, neurons) VALUES (${day}, ${want}) ON CONFLICT(day) DO UPDATE SET neurons = neurons + ${want}`;
    return { ok: true, used: used + want, cap, day };
  }

  /** Replaces a reservation with what the call used; unknown usage keeps the reservation (the safe side). */
  settleNeurons(day: string, reserved: number, actual: number | null): void {
    if (actual === null || !Number.isFinite(actual)) return;
    this.sql`UPDATE ai_usage SET neurons = MAX(0, neurons - ${Math.ceil(reserved)} + ${Math.ceil(actual)}) WHERE day = ${day}`;
  }

  neuronUsage(day: string): number {
    return this.sql<{ neurons: number }>`SELECT neurons FROM ai_usage WHERE day = ${day}`[0]?.neurons ?? 0;
  }

  // ---------- multi-agent investigation (SPEC 14.6) ----------

  /** Tools as the agent principal, inside this Durable Object: results are stored here and shared. */
  private agentToolContext(): ToolContext {
    return {
      principal: agentPrincipal(),
      warehouse: warehouseFor(this.env, {
        memoryFiles: () => this.memoryFilesLocal(),
        memoryFile: (path) => this.memoryFileLocal(path),
        memoryLog: () => this.memoryLogLocal(),
        memorySearch: (q) => this.memorySearchLocal(q),
      }),
      workspace: {
        storeResult: async (r, owner) => this.storeResult(r, owner),
        saveDraft: async (d, owner) => this.saveDraft(d, owner),
        publishedRunId: async () => this.publishedRunId(),
        routineCheckResults: async () => this.routineCheckResults(),
      },
      sha256: async (t) => sha256HexSync(t),
      canonical: canonicalJson,
      publishedRunId: this.publishedRunId(),
    };
  }

  startInvestigation(b: Omit<InvestigationBrief, "investigation_id">): string {
    const id = this.nextId("IVG");
    const brief: InvestigationBrief = { investigation_id: id, ...b };
    this.sql`INSERT INTO investigations (investigation_id, routine_id, run_id, incident_id, status, brief_json, runs_json, merged_json, created_at, updated_at)
      VALUES (${id}, ${b.routine_id}, ${b.run_id}, ${b.incident_id}, 'running', ${JSON.stringify(brief)}, '[]', NULL, ${this.now()}, ${this.now()})`;
    return id;
  }

  private investigationRow(id: string): { brief: InvestigationBrief; runs: SpecialistRun[]; merged: Merged | null; status: string; created_at: string; updated_at: string } | null {
    const r = this.sql<{ brief_json: string; runs_json: string; merged_json: string | null; status: string; created_at: string; updated_at: string }>`SELECT brief_json, runs_json, merged_json, status, created_at, updated_at FROM investigations WHERE investigation_id = ${id}`[0];
    return r ? { brief: JSON.parse(r.brief_json) as InvestigationBrief, runs: JSON.parse(r.runs_json) as SpecialistRun[], merged: r.merged_json ? (JSON.parse(r.merged_json) as Merged) : null, status: r.status, created_at: r.created_at, updated_at: r.updated_at } : null;
  }

  private aliasesOf(runs: SpecialistRun[]): AliasMap {
    return new Map(runs.flatMap((r) => r.aliases).map((a) => [a.alias, a]));
  }

  /** One specialist, in its own workflow step (a fresh CPU budget on Workers Free); idempotent per specialist. */
  async runSpecialist(id: string, name: string): Promise<{ specialist: string; outcome: string; findings: number }> {
    const row = this.investigationRow(id);
    const def = specialist(name);
    if (!row || !def) throw new Error(`no investigation ${id} or specialist ${name}`);
    const done = row.runs.find((r) => r.specialist === def.name);
    if (done) return { specialist: done.specialist, outcome: done.outcome, findings: done.report.findings.length };
    const run = await runSpecialist(this.agentToolContext(), parseConfig(this.env).llm, def, row.brief, this.aliasesOf(row.runs));
    const runs = [...row.runs, run];
    this.sql`UPDATE investigations SET runs_json = ${JSON.stringify(runs)}, updated_at = ${this.now()} WHERE investigation_id = ${id}`;
    return { specialist: run.specialist, outcome: run.outcome, findings: run.report.findings.length };
  }

  mergeInvestigation(id: string): { findings: number; critical: number; proposals: string[] } {
    const row = this.investigationRow(id);
    if (!row) throw new Error(`no investigation ${id}`);
    const merged = row.merged ?? mergeRuns(row.runs, this.aliasesOf(row.runs));
    this.sql`UPDATE investigations SET merged_json = ${JSON.stringify(merged)}, status = 'done', updated_at = ${this.now()} WHERE investigation_id = ${id}`;
    this.refreshState();
    return { findings: merged.findings.length, critical: merged.findings.filter((f) => f.severity === "critical").length, proposals: merged.proposals.map((p) => p.generator) };
  }

  /** The routine drafts the generator's output as an approval; the investigation's proposal then names it. */
  linkInvestigationProposal(id: string, generator: string, subjectId: string): void {
    const row = this.investigationRow(id);
    if (!row?.merged) return;
    const merged: Merged = { ...row.merged, proposals: row.merged.proposals.map((p) => (p.generator === generator ? { ...p, subject_id: subjectId } : p)) };
    this.sql`UPDATE investigations SET merged_json = ${JSON.stringify(merged)}, updated_at = ${this.now()} WHERE investigation_id = ${id}`;
  }

  getInvestigation(id: string): Record<string, unknown> | null {
    const row = this.investigationRow(id);
    if (!row) return null;
    return {
      investigation_id: id,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
      brief: row.brief,
      label: "synthetic",
      specialists: row.runs.map((r) => ({ specialist: r.specialist, title: r.title, provider: r.provider, outcome: r.outcome, ms: r.ms, calls: r.calls, problems: r.problems, findings: r.report.findings.length })),
      merged: row.merged,
    };
  }

  listInvestigations(): Record<string, unknown>[] {
    return this.sql<{ investigation_id: string }>`SELECT investigation_id FROM investigations ORDER BY created_at DESC, investigation_id DESC`.map((r) => this.getInvestigation(r.investigation_id) as Record<string, unknown>);
  }

  /** The agent's memory write (SPEC 14.10), committed at the synthetic time; never throws. The engine's git memory
   * locally; this Durable Object's git-style store everywhere else (CI, the fixtures deployment). */
  async memoryNote(note: MemoryNoteInput): Promise<MemoryWriteOutcome> {
    if (parseConfig(this.env).dataMode === "engine") return writeMemoryNote(this.env, note, this.now());
    return this.memoryWriteLocal(note, this.now());
  }

  // ---------- the production memory store: git-style history, not git (SPEC 14.10) ----------

  private memoryRows(): { path: string; text: string; blob: string; commit_id: string; date: string }[] {
    return this.sql<{ path: string; text: string; blob: string; commit_id: string; date: string }>`SELECT path, text, blob, commit_id, date FROM memory_files ORDER BY path`;
  }

  /** Starts the store from the committed memory export, keeping its history (imported commits) on first use. */
  private async ensureMemory(): Promise<void> {
    if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory_files`[0]?.n) return;
    const fx = new FixturesWarehouse().memoryFixture();
    if (!fx) return;
    const blobs = await Promise.all(Object.values(fx.files).map((f) => blobHash(f.text)));
    if (this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM memory_files`[0]?.n) return; // imported while hashing
    Object.entries(fx.files).forEach(([path, f], i) => {
      this.sql`INSERT INTO memory_files (path, text, blob, commit_id, date) VALUES (${path}, ${f.text}, ${blobs[i]!}, ${f.commit}, ${f.date})`;
    });
    for (const c of [...fx.log].reverse()) {
      this.sql`INSERT INTO memory_commits (commit_id, parent, tree, message, date, files_json, imported) VALUES (${c.commit}, NULL, NULL, ${c.message}, ${c.date}, ${JSON.stringify(c.files)}, 1)`;
    }
  }

  async memoryWriteLocal(note: MemoryNoteInput, at: string): Promise<MemoryWriteOutcome> {
    await this.ensureMemory();
    const rows = this.memoryRows();
    let result: ReturnType<typeof writeNote>;
    try {
      result = writeNote(Object.fromEntries(rows.map((r) => [r.path, r.text])), note, at);
    } catch (e) {
      return { written: false, reason: e instanceof NoteRejected ? e.message : `memory write failed: ${String(e)}` };
    }
    const paths = Object.keys(result.changed).sort();
    if (!paths.length) return { written: true, id: result.id, commit: null, files: [] };
    const blobs = Object.fromEntries(rows.map((r) => [r.path, r.blob]));
    for (const p of paths) blobs[p] = await blobHash(result.changed[p]!);
    const parent = this.sql<{ commit_id: string }>`SELECT commit_id FROM memory_commits ORDER BY seq DESC LIMIT 1`[0]?.commit_id ?? null;
    const tree = await treeHash(blobs);
    const commit = await commitHash(tree, parent, at, result.message);
    for (const p of paths) {
      this.sql`INSERT INTO memory_files (path, text, blob, commit_id, date) VALUES (${p}, ${result.changed[p]!}, ${blobs[p]!}, ${short(commit)}, ${at})
        ON CONFLICT(path) DO UPDATE SET text = excluded.text, blob = excluded.blob, commit_id = excluded.commit_id, date = excluded.date`;
    }
    this.sql`INSERT INTO memory_commits (commit_id, parent, tree, message, date, files_json, imported) VALUES (${short(commit)}, ${parent}, ${tree}, ${result.message}, ${at}, ${JSON.stringify(paths)}, 0)`;
    return { written: true, id: result.id, commit: short(commit), files: paths };
  }

  async memoryFilesLocal(): Promise<MemoryFileInfo[]> {
    await this.ensureMemory();
    return this.memoryRows()
      .filter((r) => r.path.endsWith(".md"))
      .map((r) => {
        const n = parseNote(r.text);
        return { path: r.path, id: (n.meta.id as string | undefined) ?? null, type: (n.meta.type as string | undefined) ?? null, title: n.title, bullets: n.bullets.length, commit: r.commit_id, date: r.date };
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.path.localeCompare(b.path)));
  }

  async memoryFileLocal(path: string): Promise<MemoryFileDoc | null> {
    await this.ensureMemory();
    const r = this.sql<{ text: string; commit_id: string; date: string }>`SELECT text, commit_id, date FROM memory_files WHERE path = ${path}`[0];
    return r && path.endsWith(".md") ? { path, ...parseNote(r.text), commit: r.commit_id, date: r.date } : null;
  }

  async memoryLogLocal(limit = 50): Promise<MemoryCommit[]> {
    await this.ensureMemory();
    return this.sql<{ commit_id: string; date: string; message: string; files_json: string }>`SELECT commit_id, date, message, files_json FROM memory_commits ORDER BY seq DESC LIMIT ${limit}`.map((c) => ({ commit: c.commit_id, date: c.date, message: c.message, files: JSON.parse(c.files_json) as string[] }));
  }

  async memorySearchLocal(query: string): Promise<MemoryHit[]> {
    await this.ensureMemory();
    const rows = this.memoryRows();
    const files = Object.fromEntries(rows.map((r) => [r.path, { text: r.text, commit: r.commit_id, date: r.date }]));
    return searchMemory(files, parseAliases(files["index/aliases.yml"]?.text ?? ""), query);
  }

  /** Records a human decision or rollback in memory after it is written (see memory/notes.ts). */
  async rememberAction(seq: number, role: Role): Promise<MemoryWriteOutcome> {
    const a = this.sql<ActionRow>`SELECT * FROM action_log WHERE seq = ${seq}`[0];
    const note = a ? decisionMemoryNote({ seq: a.seq, kind: a.kind, actor_kind: a.actor_kind, payload: JSON.parse(a.payload_json) as Record<string, unknown>, reverses_seq: a.reverses_seq }, ROLES[role]?.label ?? role) : null;
    return note ? this.memoryNote(note) : { written: false, reason: "nothing to record for this action" };
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
    const long = this.reasonTooLong(reason);
    if (long) return long;
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

  reject(p: Principal, subjectId: string, reason: string | null): ActionOutcome<{ subject_id: string; action_seq: number }> {
    const long = this.reasonTooLong(reason);
    if (long) return long;
    const a = this.getApproval(subjectId);
    if (!a) return { ok: false, code: "NOT_FOUND", message: "No such subject.", auditHead: this.state.auditHead };
    const refusal = approvalRefusal(p, a, this.currentSubjectHash(a));
    if (refusal && refusal !== "STALE_SUBJECT") return this.refuseApproval(p, a, refusal, reason);
    this.appendApprovalAudit({ subject_kind: a.subject_kind, subject_id: subjectId, proposer: a.proposer, decision: "rejected", refusal_code: null, decided_by: p.id, decided_role: p.role, reason, workflow_instance_id: a.workflow_instance_id ?? null });
    this.sql`UPDATE approvals SET status = 'rejected', decided_at = ${this.now()} WHERE subject_id = ${subjectId}`;
    if (a.subject_kind === "review") this.sql`UPDATE reviews SET state = 'rejected' WHERE review_id = ${subjectId}`;
    const seq = this.appendAction({ kind: `${a.subject_kind}.reject`, actor: p.id, actor_kind: "human", payload: { subject_id: subjectId }, reason, reversible: "none" });
    this.refreshState();
    return { ok: true, value: { subject_id: subjectId, action_seq: seq }, auditHead: this.state.auditHead };
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
    const long = this.reasonTooLong(reason);
    if (long) return long;
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
    if (parseConfig(this.env).runner === "inline") {
      // a fixtures deployment has no runner: the job is completed from its committed fixture as it is enqueued, and
      // the workflow's gate finds it done before it waits (ADR 0016)
      const result = new FixturesWarehouse().job(key);
      const ok = result !== null;
      this.sql`INSERT INTO engine_jobs (job_key, kind, params_json, status, lease_owner, lease_expires_at, attempt, result_json, workflow_instance_id, demo_epoch, created_at)
        VALUES (${key}, ${spec.kind}, ${JSON.stringify(spec.params)}, ${ok ? "done" : "failed"}, NULL, NULL, 1, ${JSON.stringify(ok ? result : { error: "no fixture for this job" })}, ${workflowInstanceId}, ${this.state.demoEpoch}, ${this.now()})`;
      return { job_key: key, status: ok ? "done" : "failed", result: ok ? result : { error: "no fixture for this job" } };
    }
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

  /** Results of the routine's completed check runs, in the order they ran (merged after the published results). */
  routineCheckResults(): QualityFixture["results"] {
    const out: QualityFixture["results"] = [];
    for (const j of this.sql<{ result_json: string | null }>`SELECT result_json FROM engine_jobs WHERE kind = 'run_checks' AND status = 'done' ORDER BY created_at, rowid`) {
      const r = j.result_json ? (JSON.parse(j.result_json) as { results?: QualityFixture["results"] }) : null;
      for (const x of r?.results ?? []) if (!out.some((y) => y.check_id === x.check_id && y.date === x.date && y.status === x.status)) out.push(x);
    }
    return out;
  }

  listJobs(): Record<string, unknown>[] {
    return this.sql`SELECT job_key, kind, params_json, status, attempt, created_at FROM engine_jobs ORDER BY created_at`;
  }

  // ---------- routines ----------

  async startRoutine(p: Principal | null, source: string, period: string): Promise<{ routine_id: string; workflow_instance_id: string } | { refused: true; code: string; message: string }> {
    const exp = this.sandboxed ? this.sandboxExp() : null;
    if (this.sandboxed) {
      const runs = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM routine_runs`[0]?.n ?? 0;
      if (runs >= CAPS.routinesPerSandbox) return { refused: true, code: "ROUTINE_LIMIT", message: "This sandbox has already run the payroll simulation. Reset the sandbox to run it again." };
      // the request paid for a write; the routine's workflow steps cost the rest of its units
      const v = this.admit(UNITS.routine - UNITS.write);
      if (!v.ok) return { refused: true, code: v.code, message: v.code === "RATE_LIMITED" ? "The demo is busy, try again later." : "This sandbox has used its request allowance. Reset it to start a fresh one." };
    }
    const routineId = this.nextId("RTN");
    const trigger = { kind: "source_arrival", source, period, by: p?.id ?? "runner", arrived_at: DEMO.arrivedAt };
    this.sql`INSERT INTO routine_runs (routine_id, kind, status, trigger_json, steps_json, workflow_instance_id, demo_epoch, created_at, updated_at)
      VALUES (${routineId}, 'source_arrival_refresh', 'running', ${JSON.stringify(trigger)}, '[]', NULL, ${this.state.demoEpoch}, ${this.now()}, ${this.now()})`;
    this.appendAction({ kind: "source.arrived", actor: p?.id ?? "runner", actor_kind: p ? "human" : "routine", routine_run_id: routineId, payload: { ...trigger, label: p ? "simulated arrival (synthetic)" : "arrival" }, reversible: "none" });
    // in a sandbox the instance ID carries the sandbox's name, and the approval wait ends before the sandbox does
    const approvalTimeoutSeconds = exp !== null ? Math.max(60, exp - Math.floor(Date.now() / 1000) - 120) : null;
    const instanceId = await this.runWorkflow(
      "ROUTINE_WORKFLOW",
      { routine_id: routineId, source, period, epoch: this.state.demoEpoch, ...(approvalTimeoutSeconds ? { approval_timeout_s: approvalTimeoutSeconds } : {}) },
      { id: this.sandboxed ? `routine-${this.name}-${routineId}-e${this.state.demoEpoch}` : `routine-${routineId}-e${this.state.demoEpoch}` },
    );
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

  /** The principal of the calling browser connection. A sandbox's connections never act over RPC: the public demo's
   * actions go through the admitted HTTP API, which spends the sandbox's units and bounds the reasons. */
  private callerPrincipal(): Principal {
    if (this.sandboxed) throw new Error("not available in the public demo: actions go through the HTTP API");
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
    const p = this.callerPrincipal();
    const out = this.approve(p, subjectId, reason);
    if (out.ok) {
      await this.wakeApproval(subjectId);
      await this.rememberAction(out.value.action_seq, p.role);
    }
    return out;
  }

  @callable()
  async rejectCallable(subjectId: string, reason: string | null) {
    const p = this.callerPrincipal();
    const out = this.reject(p, subjectId, reason);
    if (out.ok) {
      await this.wakeApproval(subjectId);
      await this.rememberAction(out.value.action_seq, p.role);
    }
    return out;
  }

  @callable()
  async rollbackCallable(seq: number, reason: string) {
    const p = this.callerPrincipal();
    const out = this.rollback(p, seq, reason);
    if (out.ok) await this.rememberAction(out.value.action_seq, p.role);
    return out;
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
