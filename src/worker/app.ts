// The Worker's HTTP API (SPEC 16.2): every route authenticates first, then calls the governed tool registry or the
// WorkspaceAgent. Responses use the envelope { result_id, label: "synthetic", provenance, rounding, data }; a refusal
// is an answer ({ refused: true, code, message }), not an error.
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { canonicalJson } from "../shared/canonical-json";
import type { FunnelData, FunnelPoint, HistoryFixture, QualityFixture } from "../shared/contracts";
import { authorizeCohort, canUseTool, MIN_COMPARISON } from "../shared/policy/authorize";
import { DEMO } from "../shared/routines/definitions";
import { isRefusal, type Refusal, refuse } from "../shared/policy/refusals";
import { hasScope, LOCAL_PRINCIPALS, type Principal } from "../shared/policy/roles";
import { audienceOf, cohortMeta, getTool, orgSlug, resolveCohort, runTool, type ToolContext, type ToolResult } from "../shared/tools/registry";
import type { AnalystAgent } from "./agents/analyst-agent";
import { workspace, workspaceStub } from "./agents/workspace-port";
import { AuthError } from "./auth/access";
import { mintDevToken } from "./auth/dev-login";
import { agentInstanceName } from "./auth/hmac";
import { authenticate, DEV_COOKIE, runnerId } from "./auth/principal";
import { type AppConfig, isLocalHost, parseConfig } from "./config";
import { sha256HexSync } from "./store/chain";
import { warehouseFor } from "./warehouse/client";
import { FixturesWarehouse } from "./warehouse/fixtures";

type Vars = { principal: Principal; config: AppConfig };
export type AppEnv = { Bindings: Env; Variables: Vars };

export function toolContext(env: Env, p: Principal): ToolContext {
  return { principal: p, warehouse: warehouseFor(env), workspace: workspaceStub(env), sha256: async (t) => sha256HexSync(t), canonical: canonicalJson };
}

export function envelope<T>(r: ToolResult<T>) {
  return { result_id: r.result_id, label: "synthetic" as const, provenance: r.provenance, rounding: r.rounding, suppressed_cells: r.suppressed_cells, data: r.values };
}

/** A stored result is served only to a principal who could have computed the same output: the tool's scopes, the
 * cohort rules for the cohort it names, and the same audience class (SPEC 17.1). Knowing a result ID grants nothing. */
async function resultDenied(env: Env, p: Principal, r: ToolResult<unknown>): Promise<Refusal | null> {
  const prov = r.provenance;
  const def = getTool(prov.tool);
  if (!def || !canUseTool(p, def)) return refuse("NOT_PERMITTED");
  if ((prov.audience ?? "all") !== audienceOf(p)) return refuse("NOT_PERMITTED", "This result was computed for a different role.");
  if (prov.args.by === "team" && !hasScope(p, "forecast:read:team")) return refuse("NOT_PERMITTED", "Team-level values are available to People Analysts only.");
  const cohort = typeof prov.args.cohort === "string" ? prov.args.cohort : null;
  if (!cohort) return null;
  const wh = warehouseFor(env);
  const published = (await (await workspace(env)).publishedRunId()) ?? (await wh.runs()).published;
  const own = prov.run_id ? await wh.forecast(prov.run_id) : null;
  if (own?.run.status === "held" && !hasScope(p, "forecast:read:all") && !hasScope(p, "quality:read")) return refuse("NOT_PERMITTED", "Held runs are visible to analysts and data engineers only.");
  const fx = own ?? (await wh.forecast(published));
  const co = fx ? resolveCohort(cohort, fx.cohorts) : null;
  if (!fx || !co) return refuse("NOT_PERMITTED");
  return authorizeCohort(p, prov.tool, cohortMeta(co, fx.cohorts));
}

interface TraceSpan {
  kind: string;
  name: string;
  start_ms: number;
  dur_ms: number;
  tokens?: unknown;
  outcome?: string;
  result_ids?: string[];
}

/** A trace as a principal may see it (SPEC 14.12): analysts their own, leads every trace in full (locally), the
 * auditor every trace as metadata only (no question text, no tool arguments, no violation text). */
function traceView(p: Principal, row: { trace_id: string; owner: string; created_at: string; payload_json: string }) {
  const t = JSON.parse(row.payload_json) as { question?: string; provider?: string; recorded?: boolean; grounding?: string; spans?: TraceSpan[]; tool_calls?: { tool: string; args?: unknown; result_id?: string | null }[]; violations?: string[] };
  const full = hasScope(p, "forecast:read:all");
  const spans = (t.spans ?? []).map((s) => ({ kind: s.kind, name: s.name, start_ms: s.start_ms, dur_ms: s.dur_ms, ...(s.tokens ? { tokens: s.tokens } : {}), ...(s.outcome ? { outcome: s.outcome } : {}), ...(s.result_ids ? { result_ids: s.result_ids } : {}) }));
  return {
    trace_id: row.trace_id,
    owner: row.owner,
    created_at: row.created_at,
    provider: t.provider ?? null,
    recorded: Boolean(t.recorded),
    grounding: t.grounding ?? null,
    question: full ? (t.question ?? null) : null,
    tool_calls: (t.tool_calls ?? []).map((tc) => ({ tool: tc.tool, result_id: tc.result_id ?? null, ...(full ? { args: tc.args ?? {} } : {}) })),
    violations: full ? (t.violations ?? []) : [],
    spans,
    metadata_only: !full,
    label: "synthetic" as const,
  };
}

/** People Partners read their own organizations' group notes; decisions, investigations and the timeline are
 * company-wide records (SPEC 14.1 `memory:read:assigned`). */
function memoryVisible(p: Principal, path: string): boolean {
  if (hasScope(p, "memory:read")) return true;
  if (!path.startsWith("teams/")) return true;
  return p.assignedOrgs.map(orgSlug).includes(path.split("/")[1] ?? "");
}

export function buildApp() {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("config", parseConfig(c.env));
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, service: "staysignal", authMode: c.var.config.authMode, dataMode: c.var.config.dataMode, llm: c.var.config.llm, label: "synthetic" }));

  // ---------- local development sign-in (dev mode on localhost only) ----------
  app.get("/dev/principals", (c) => {
    if (c.var.config.authMode !== "dev" || !isLocalHost(new URL(c.req.url))) return c.json({ error: "not found" }, 404);
    return c.json({ principals: LOCAL_PRINCIPALS });
  });

  app.get("/dev/login", async (c) => {
    const url = new URL(c.req.url);
    if (c.var.config.authMode !== "dev" || !isLocalHost(url)) return c.json({ error: "not found" }, 404);
    const id = url.searchParams.get("principal") ?? "";
    if (!LOCAL_PRINCIPALS.some((p) => p.id === id)) return c.json({ error: "unknown principal" }, 400);
    const token = await mintDevToken(c.var.config, id);
    c.header("Set-Cookie", `${DEV_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800`);
    return c.json({ ok: true, principal: id, token });
  });

  // ---------- authentication for everything below ----------
  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/health") return next();
    try {
      c.set("principal", await authenticate(c.req.raw, c.var.config));
    } catch (e) {
      const reason = e instanceof AuthError ? e.reason : "invalid";
      return c.json({ error: "unauthenticated", reason }, 401);
    }
    return next();
  });

  app.get("/api/me", (c) => c.json({ principal: c.var.principal, label: "synthetic" }));

  const tool = (name: string, args: Record<string, unknown>) => async (c: { env: Env; var: Vars }) => {
    const out = await runTool(toolContext(c.env, c.var.principal), name, args);
    return out;
  };

  const respond = async (c: { env: Env; var: Vars; json: (o: unknown, s?: number) => Response }, name: string, args: Record<string, unknown>) => {
    const out = await tool(name, args)(c);
    if (isRefusal(out)) return c.json(out);
    return c.json(envelope(out as ToolResult<unknown>));
  };

  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

  app.get("/api/forecast", (c) => respond(c, "forecast_departures", { cohort: c.req.query("cohort") ?? "Larkspur", horizon_months: num(c.req.query("horizon")), horizon_days: num(c.req.query("horizon_days")), cause: c.req.query("cause") || undefined, run: c.req.query("run") || undefined }));
  app.get("/api/forecast/breakdown", (c) => respond(c, "forecast_breakdown", { cohort: c.req.query("cohort") ?? "Larkspur", by: c.req.query("by") ?? "group", horizon_months: num(c.req.query("horizon")) }));
  app.get("/api/forecast/history", (c) => respond(c, "forecast_history", { cohort: c.req.query("cohort") ?? "Larkspur", horizon_months: num(c.req.query("horizon")) }));
  app.get("/api/backtest/summary", (c) => respond(c, "backtest_summary", { level: c.req.query("level") || undefined, horizon_months: num(c.req.query("horizon")), model: c.req.query("model") || undefined }));
  app.get("/api/changes", (c) => respond(c, "explain_change", { cohort: c.req.query("cohort") ?? "Larkspur", horizon_months: num(c.req.query("horizon")), from_run: c.req.query("from") || undefined, to_run: c.req.query("to") || undefined }));
  app.get("/api/profile", (c) => respond(c, "cohort_profile", { cohort: c.req.query("cohort") ?? "Larkspur" }));
  app.get("/api/memory/search", (c) => respond(c, "search_memory", { query: c.req.query("q") ?? "" }));
  app.get("/api/memory/files", async (c) => {
    if (!canUseTool(c.var.principal, getTool("search_memory")!)) return c.json(refuse("NOT_PERMITTED"));
    const files = (await warehouseFor(c.env).memoryFiles()) ?? [];
    return c.json({ label: "synthetic", files: files.filter((f) => memoryVisible(c.var.principal, f.path)) });
  });
  app.get("/api/memory/file", async (c) => {
    const path = c.req.query("path") ?? "";
    if (!canUseTool(c.var.principal, getTool("search_memory")!) || !memoryVisible(c.var.principal, path)) return c.json(refuse("NOT_PERMITTED"));
    const doc = await warehouseFor(c.env).memoryFile(path);
    return doc ? c.json({ label: "synthetic", ...doc }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/memory/log", async (c) => {
    if (!canUseTool(c.var.principal, getTool("search_memory")!)) return c.json(refuse("NOT_PERMITTED"));
    return c.json({ label: "synthetic", commits: (await warehouseFor(c.env).memoryLog()) ?? [] });
  });
  app.get("/api/workforce/flows", (c) => respond(c, "workforce_flows", { cohort: c.req.query("cohort") ?? "Larkspur", from: c.req.query("from") || undefined, to: c.req.query("to") || undefined }));
  app.get("/api/lineage", (c) => respond(c, "trace_lineage", { check_id: c.req.query("check") || undefined, node: c.req.query("node") || undefined }));

  app.get("/api/cohorts", async (c) => {
    const ws = await workspace(c.env);
    const runId = (await ws.publishedRunId()) ?? (await warehouseFor(c.env).runs()).published;
    const fx = await warehouseFor(c.env).forecast(runId);
    const p = c.var.principal;
    const all = fx?.cohorts ?? [];
    const visible = all.filter((co) => {
      if (co.kind === "org_level" || co.kind === "org_tenure") return false;
      const meta = cohortMeta(co, all);
      return authorizeCohort(p, "forecast_departures", meta) === null;
    });
    return c.json({ label: "synthetic", run_id: runId, cohorts: visible.map((co) => ({ id: co.cohort_id, name: co.kind === "company" ? "Larkspur (company)" : co.name, kind: co.kind, n: co.n, parent: co.parent })) });
  });

  // Recorded evaluation for the Trust page (SPEC 10, 16.1): cohort aggregates only, filtered by the same cohort rules
  // as the forecast tools; summaries that pool organizations are shown only to roles that may read the company.
  app.get("/api/evaluation", async (c) => {
    const wh = warehouseFor(c.env);
    const ev = await wh.evaluation();
    if (!ev) return c.json({ error: "no recorded evaluation" }, 404);
    const p = c.var.principal;
    const ws = await workspace(c.env);
    const runId = (await ws.publishedRunId()) ?? (await wh.runs()).published;
    const all = (await wh.forecast(runId))?.cohorts ?? [];
    const allowed = (cohortId: string): boolean => {
      const co = all.find((x) => x.cohort_id === cohortId);
      return Boolean(co && authorizeCohort(p, "forecast_history", cohortMeta(co, all)) === null);
    };
    const company = allowed("company");
    const entries = ev.backtest.entries.filter((e) => allowed(e.cohort));
    const levels = Object.fromEntries(Object.entries(ev.backtest.levels).filter(([, v]) => company && (v.level === "company" || hasScope(p, "forecast:read:all"))));
    const comparison = company ? { ...ev.comparison, summary: Object.fromEntries(Object.entries(ev.comparison.summary).filter(([, v]) => v.level === "company" || hasScope(p, "forecast:read:all"))) } : null;
    return c.json({ ...ev, backtest: { ...ev.backtest, levels, entries }, calibration: company ? ev.calibration : null, comparison, effects: company ? (ev.effects ?? null) : null });
  });

  // the research benchmark (SPEC 11): pre-registered cells and hypotheses on synthetic research worlds, not Larkspur's
  // cohorts, so every signed-in role may read it
  app.get("/api/research", async (c) => {
    const doc = await warehouseFor(c.env).research();
    return doc ? c.json(doc) : c.json({ error: "no recorded research run" }, 404);
  });

  // the funnel plot (SPEC 16.2): each cohort's observed over expected in the latest mature quarterly backtest window,
  // against its expected count; groups and above with n >= 50, scoped like every comparison over time (17.5)
  app.get("/api/workforce/funnel", async (c) => {
    const h = ["1", "3", "6"].includes(c.req.query("horizon") ?? "") ? (c.req.query("horizon") as string) : "3";
    const wh = warehouseFor(c.env);
    const hist = await wh.history();
    if (!hist) return c.json({ error: "no recorded backtests" }, 404);
    const p = c.var.principal;
    const runId = (await (await workspace(c.env)).publishedRunId()) ?? (await wh.runs()).published;
    const all = (await wh.forecast(runId))?.cohorts ?? [];
    const meta = (id: string) => all.find((x) => x.cohort_id === id);
    const allowed = (id: string): boolean => {
      const co = meta(id);
      return Boolean(co && authorizeCohort(p, "forecast_history", cohortMeta(co, all)) === null);
    };
    const mature = (hist.series.company?.[h] ?? []).filter((x) => x.actual_status === "mature" && !x.omitted_reason).map((x) => x.origin).sort();
    const origin = mature[mature.length - 1] ?? null;
    const points: FunnelPoint[] = [];
    for (const [cohort, byH] of Object.entries(hist.series)) {
      const co = meta(cohort);
      if (!co || !["company", "organization", "group"].includes(co.kind) || !allowed(cohort)) continue;
      const x = byH[h]?.find((y) => y.origin === origin);
      const n = x?.n ?? co.n;
      if (!x || x.actual_status !== "mature" || x.omitted_reason || n < MIN_COMPARISON || !(x.expected > 0) || x.actual === null) continue;
      points.push({ cohort, name: co.kind === "company" ? "Larkspur (company)" : co.name, level: co.kind as FunnelPoint["level"], n, expected: x.expected, observed: x.actual, oe: x.actual / x.expected });
    }
    points.sort((a, b) => a.cohort.localeCompare(b.cohort));
    const data: FunnelData = { label: "synthetic", horizon: Number(h), origin, design: "pseudo-real-time quarterly backtest: model and data as known at the origin; observed departures in the mature window", points };
    return c.json(data);
  });

  app.get("/api/trust", async (c) => {
    const cohortQ = c.req.query("cohort") ?? "company";
    const h = c.req.query("horizon") ?? "3";
    const wh = warehouseFor(c.env);
    const hist = (await wh.history()) as (HistoryFixture & { trust?: Record<string, Record<string, { oe: number | null; coverage80: { held: number; windows: number }; effective_windows: number }>> }) | null;
    const ws = await workspace(c.env);
    const q = await wh.quality();
    const results = q?.results ?? [];
    const lastDay = results.reduce((m, r) => (r.date > m ? r.date : m), "");
    const latest = results.filter((r) => r.date === lastDay);
    const incidents = ((await ws.listIncidents()) as unknown as { status: string; failing?: string[] }[]).filter((i) => i.status === "open");
    const failing = new Set<string>([...latest.filter((r) => r.status === "fail").map((r) => r.check_id), ...incidents.flatMap((i) => i.failing ?? [])]);
    const f01 = latest.find((r) => r.check_id === "F01");
    const t = hist?.trust?.[cohortQ]?.[h] ?? null;
    return c.json({
      label: "synthetic",
      cohort: cohortQ,
      horizon: Number(h),
      backtest: t ? { oe: t.oe, coverage80: t.coverage80, effective_windows: t.effective_windows } : null,
      freshness: { status: f01?.status ?? "pass", detail: f01 ? "HRIS batch newer than 36 hours on the synthetic clock" : "no check result", date: lastDay },
      checks: { passing: latest.filter((r) => r.status === "pass").length - [...failing].filter((id) => latest.find((r) => r.check_id === id && r.status === "pass")).length, total: latest.length, failing: [...failing].sort() },
      note: "Pseudo-real-time quarterly backtests on the synthetic world; coverage is claimed at organization level and above.",
    });
  });

  app.get("/api/quality/checks", async (c) => {
    if (!hasScope(c.var.principal, "quality:read")) return c.json({ refused: true, code: "NOT_PERMITTED", message: "Your role does not include data quality." });
    const q = (await warehouseFor(c.env).quality()) as QualityFixture | null;
    const ws = await workspace(c.env);
    const results = [...(q?.results ?? [])];
    for (const x of (await ws.routineCheckResults()) as QualityFixture["results"]) if (!results.some((y) => y.check_id === x.check_id && y.date === x.date && y.status === x.status)) results.push(x);
    return c.json({ label: "synthetic", checks: q?.checks ?? [], results, incidents: await ws.listIncidents() });
  });

  app.get("/api/quality/incidents/:id", async (c) => c.json((await (await workspace(c.env)).getIncident(c.req.param("id"))) ?? { error: "not found" }));

  // multi-agent investigations (SPEC 14.6): cohort-level findings, each citing the result IDs that back it
  const mayInvestigate = (p: Principal) => hasScope(p, "quality:read") || hasScope(p, "investigate:run");
  app.get("/api/investigations", async (c) => {
    if (!mayInvestigate(c.var.principal)) return c.json(refuse("NOT_PERMITTED", "Investigations are for analysts, leads and data engineers."));
    return c.json({ label: "synthetic", investigations: await (await workspace(c.env)).listInvestigations() });
  });
  app.get("/api/investigations/:id", async (c) => {
    if (!mayInvestigate(c.var.principal)) return c.json(refuse("NOT_PERMITTED", "Investigations are for analysts, leads and data engineers."));
    const inv = await (await workspace(c.env)).getInvestigation(c.req.param("id"));
    return inv ? c.json(inv) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/runs", async (c) => {
    const ws = await workspace(c.env);
    return c.json({ label: "synthetic", published: await ws.publishedRunId(), runs: await ws.listRuns(), mapping: await ws.activeMapping() });
  });
  app.get("/api/runs/:id/replays", async (c) => c.json({ label: "synthetic", replays: await (await workspace(c.env)).listReplays(c.req.param("id")) }));

  app.get("/api/results/:id", async (c) => {
    const r = await (await workspace(c.env)).getResult(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    const denied = await resultDenied(c.env, c.var.principal, r);
    if (denied) return c.json(denied, 403);
    return c.json(envelope(r));
  });

  app.get("/api/traces", async (c) => {
    const p = c.var.principal;
    if (!hasScope(p, "trace:read:all") && !hasScope(p, "trace:read:own")) return c.json(refuse("NOT_PERMITTED"));
    const rows = await (await workspace(c.env)).listTraces(hasScope(p, "trace:read:all") ? null : p.id, Number(c.req.query("limit") ?? 50));
    return c.json({ label: "synthetic", traces: rows.map((r) => traceView(p, r)) });
  });
  app.get("/api/traces/:id", async (c) => {
    const p = c.var.principal;
    const t = await (await workspace(c.env)).getTrace(c.req.param("id"));
    if (!t) return c.json({ error: "not found" }, 404);
    if (!hasScope(p, "trace:read:all") && !(hasScope(p, "trace:read:own") && t.owner === p.id)) return c.json(refuse("NOT_PERMITTED"));
    return c.json(traceView(p, { trace_id: c.req.param("id"), ...t }));
  });

  app.post("/api/reviews/draft", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { cohort?: string; horizon?: number };
    return respond(c, "prepare_review", { cohort: body.cohort ?? "Platform Engineering", horizon_months: body.horizon });
  });
  app.post("/api/reviews/:draftId/submit", async (c) => c.json(await (await workspace(c.env)).submitReview(c.var.principal, c.req.param("draftId"))));
  app.get("/api/reviews", async (c) => c.json({ label: "synthetic", reviews: await (await workspace(c.env)).listReviews() }));
  app.get("/api/reviews/:id", async (c) => {
    const ws = await workspace(c.env);
    const reviews = (await ws.listReviews()) as { review_id: string; state: string }[];
    const r = reviews.find((x) => x.review_id === c.req.param("id"));
    return r ? c.json({ ...r, transitions: await ws.reviewTransitions(r.review_id) }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/approvals", async (c) => c.json({ label: "synthetic", approvals: await (await workspace(c.env)).listApprovals() }));
  app.post("/api/approvals/:id/approve", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ws = await workspace(c.env);
    const out = await ws.approve(c.var.principal, c.req.param("id"), body.reason ?? null);
    if (out.ok) {
      await ws.wakeApproval(c.req.param("id"));
      await ws.rememberAction(out.value.action_seq, c.var.principal.role);
    }
    return c.json(out);
  });
  app.post("/api/approvals/:id/reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ws = await workspace(c.env);
    const out = await ws.reject(c.var.principal, c.req.param("id"), body.reason ?? null);
    if (out.ok) {
      await ws.wakeApproval(c.req.param("id"));
      await ws.rememberAction(out.value.action_seq, c.var.principal.role);
    }
    return c.json(out);
  });
  app.post("/api/actions/:seq/rollback", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ws = await workspace(c.env);
    const out = await ws.rollback(c.var.principal, Number(c.req.param("seq")), body.reason ?? "");
    if (out.ok) await ws.rememberAction(out.value.action_seq, c.var.principal.role);
    return c.json(out);
  });
  app.get("/api/audit", async (c) => c.json({ label: "synthetic", actions: await (await workspace(c.env)).auditLog(Number(c.req.query("since") ?? 0)), approvals: await (await workspace(c.env)).approvalAuditLog() }));
  // the action audit (SPEC 17.7): proxy screens (tenure band, location) for leads and the auditor, the audit-only age
  // screen for the auditor only (audit:attributes); everyone else is refused
  app.get("/api/audit/actions", async (c) => {
    const p = c.var.principal;
    const attributes = hasScope(p, "audit:attributes");
    if (!attributes && !hasScope(p, "review:approve")) return c.json(refuse("NOT_PERMITTED", "The action audit is for People Analytics leads and the auditor."));
    const doc = await warehouseFor(c.env).actionAudit();
    if (!doc) return c.json(refuse("OUT_OF_SCOPE", "No action audit has been recorded."));
    const screens = Object.fromEntries(Object.entries(doc.screens).filter(([, s]) => s.kind === "proxy" || attributes));
    return c.json({ ...doc, screens, proxy_strength: attributes ? doc.proxy_strength : null, audience: attributes ? "auditor" : "lead" });
  });
  // the Scenario Lab (SPEC 15): hypothesis generation with synthetic personas, recorded sessions only; it never feeds a
  // forecast number or review evidence (ADR 0008)
  app.get("/api/lab", async (c) => {
    if (!hasScope(c.var.principal, "lab:read")) return c.json(refuse("NOT_PERMITTED", "The Scenario Lab needs lab:read."));
    const doc = await warehouseFor(c.env).labIndex();
    return doc ? c.json(doc) : c.json(refuse("OUT_OF_SCOPE", "No Lab session has been recorded."));
  });
  app.get("/api/lab/:proposal", async (c) => {
    if (!hasScope(c.var.principal, "lab:read")) return c.json(refuse("NOT_PERMITTED", "The Scenario Lab needs lab:read."));
    const doc = await warehouseFor(c.env).lab(c.req.param("proposal"));
    return doc ? c.json(doc) : c.json({ error: "no recorded session for this proposal" }, 404);
  });
  app.get("/api/audit/verify", async (c) => c.json(await (await workspace(c.env)).verifyAudit()));

  // ---------- routines and the demo arrival ----------
  app.post("/api/demo/arrival", async (c) => {
    if (!c.var.config.demo && c.var.config.authMode !== "dev") return c.json({ error: "demo only" }, 404);
    if (!hasScope(c.var.principal, "forecast:read:all") && !hasScope(c.var.principal, "quality:read")) return c.json({ refused: true, code: "NOT_PERMITTED", message: "Your role cannot trigger arrivals." });
    return c.json(await (await workspace(c.env)).startRoutine(c.var.principal, DEMO.arrival.source, DEMO.arrival.period));
  });
  app.get("/api/routines", async (c) => c.json({ label: "synthetic", routines: await (await workspace(c.env)).listRoutines() }));
  app.get("/api/routines/:id", async (c) => c.json((await (await workspace(c.env)).getRoutine(c.req.param("id"))) ?? { error: "not found" }));
  app.get("/api/mappings/payroll", async (c) => {
    const ws = await workspace(c.env);
    const approvals = ((await ws.listApprovals()) as unknown as ({ subject_kind: string } | null)[]).filter((a) => a?.subject_kind === "mapping");
    return c.json({ label: "synthetic", active: await ws.activeMapping(), proposals: approvals });
  });
  app.get("/api/jobs", async (c) => c.json({ jobs: await (await workspace(c.env)).listJobs() }));

  // ---------- the agent turn over HTTP (dev and evals, localhost only) ----------
  app.post("/api/dev/agent/turn", async (c) => {
    if (c.var.config.authMode !== "dev" || !isLocalHost(new URL(c.req.url))) return c.json({ error: "not found" }, 404);
    const body = (await c.req.json()) as { question: string; provider?: string; history?: { role: "user" | "assistant"; content: string }[] };
    const name = await agentInstanceName(c.var.config.hmacKey, c.var.principal.id);
    const agent = await getAgentByName<Env, AnalystAgent>(c.env.ANALYST_AGENT, name);
    const history = (body.history ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-12);
    return c.json(await agent.turn(c.var.principal, body.question, body.provider as never, history));
  });

  // ---------- runner protocol (ADR 0002) ----------
  app.use("/internal/*", async (c, next) => {
    const cfg = c.var.config;
    const auth = c.req.header("Authorization") ?? "";
    if (cfg.runnerToken && auth === `Bearer ${cfg.runnerToken}`) return next();
    try {
      const p = await authenticate(c.req.raw, cfg);
      if (p.id === runnerId(cfg)) return next();
    } catch {
      // fall through
    }
    return c.json({ error: "unauthenticated" }, 401);
  });
  app.post("/internal/runner/lease", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { owner?: string };
    return c.json(await (await workspace(c.env)).leaseJob(body.owner ?? "runner"));
  });
  app.post("/internal/runner/heartbeat", async (c) => {
    const body = (await c.req.json()) as { job_key: string; owner: string };
    return c.json({ ok: await (await workspace(c.env)).heartbeat(body.job_key, body.owner) });
  });
  app.post("/internal/runner/complete", async (c) => {
    const text = await c.req.text();
    if (text.length > 256 * 1024) return c.json({ error: "result over 256 KiB" }, 413);
    const body = JSON.parse(text) as { job_key: string; result: unknown; ok?: boolean };
    return c.json(await (await workspace(c.env)).completeJob(body.job_key, body.result, body.ok !== false));
  });
  app.get("/internal/fixtures/job/:key", (c) => {
    const fx = warehouseFor(c.env);
    if (!(fx instanceof FixturesWarehouse)) return c.json({ error: "fixtures mode only" }, 404);
    const job = fx.job(c.req.param("key"));
    return job ? c.json(job) : c.json({ error: "no fixture for this job" }, 404);
  });
  app.post("/internal/sources/arrived", async (c) => {
    const body = (await c.req.json()) as { source: string; period: string };
    return c.json(await (await workspace(c.env)).startRoutine(null, body.source, body.period));
  });

  return app;
}
