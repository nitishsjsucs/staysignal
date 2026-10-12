// The Worker's HTTP API (SPEC 16.2): every route authenticates first, then calls the governed tool registry or the
// WorkspaceAgent. Responses use the envelope { result_id, label: "synthetic", provenance, rounding, data }; a refusal
// is an answer ({ refused: true, code, message }), not an error.
import { getAgentByName } from "agents";
import { Hono } from "hono";
import { canonicalJson } from "../shared/canonical-json";
import type { QualityFixture } from "../shared/contracts";
import { DEMO } from "../shared/routines/definitions";
import { isRefusal } from "../shared/policy/refusals";
import { hasScope, LOCAL_PRINCIPALS, type Principal } from "../shared/policy/roles";
import { runTool, type ToolContext, type ToolResult } from "../shared/tools/registry";
import type { AnalystAgent } from "./agents/analyst-agent";
import { workspace, workspaceStub } from "./agents/workspace-port";
import { AuthError } from "./auth/access";
import { mintDevToken } from "./auth/dev-login";
import { agentInstanceName } from "./auth/hmac";
import { authenticate, DEV_COOKIE } from "./auth/principal";
import { type AppConfig, isLocalHost, parseConfig } from "./config";
import { sha256HexSync } from "./store/chain";
import { warehouseFor } from "./warehouse/client";
import { FixturesWarehouse } from "./warehouse/fixtures";

type Vars = { principal: Principal; config: AppConfig };
export type AppEnv = { Bindings: Env; Variables: Vars };

export function toolContext(env: Env, p: Principal): ToolContext {
  return { principal: p, warehouse: warehouseFor(env), workspace: workspaceStub(env), sha256: async (t) => sha256HexSync(t), canonical: canonicalJson };
}

function envelope<T>(r: ToolResult<T>) {
  return { result_id: r.result_id, label: "synthetic" as const, provenance: r.provenance, rounding: r.rounding, suppressed_cells: r.suppressed_cells, data: r.values };
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
  app.get("/api/changes", (c) => respond(c, "explain_change", { cohort: c.req.query("cohort") ?? "Larkspur", horizon_months: num(c.req.query("horizon")), from_run: c.req.query("from") || undefined, to_run: c.req.query("to") || undefined }));
  app.get("/api/profile", (c) => respond(c, "cohort_profile", { cohort: c.req.query("cohort") ?? "Larkspur" }));
  app.get("/api/lineage", (c) => respond(c, "trace_lineage", { check_id: c.req.query("check") || undefined, node: c.req.query("node") || undefined }));

  app.get("/api/quality/checks", async (c) => {
    if (!hasScope(c.var.principal, "quality:read")) return c.json({ refused: true, code: "NOT_PERMITTED", message: "Your role does not include data quality." });
    const q = (await warehouseFor(c.env).quality()) as QualityFixture | null;
    const ws = await workspace(c.env);
    const extra = ((await ws.listJobs()) as unknown as { job_key: string; kind: string; status: string }[]).filter((j) => j.kind === "run_checks" && j.status === "done");
    const results = [...(q?.results ?? [])];
    for (const j of extra) {
      const full = (await ws.getJob(String(j.job_key))) as unknown as { result: unknown } | null;
      const r = full?.result as { results?: QualityFixture["results"] } | null;
      for (const x of r?.results ?? []) if (!results.some((y) => y.check_id === x.check_id && y.date === x.date && y.status === x.status)) results.push(x);
    }
    return c.json({ label: "synthetic", checks: q?.checks ?? [], results, incidents: await ws.listIncidents() });
  });

  app.get("/api/quality/incidents/:id", async (c) => c.json((await (await workspace(c.env)).getIncident(c.req.param("id"))) ?? { error: "not found" }));

  app.get("/api/runs", async (c) => {
    const ws = await workspace(c.env);
    return c.json({ label: "synthetic", published: await ws.publishedRunId(), runs: await ws.listRuns(), mapping: await ws.activeMapping() });
  });
  app.get("/api/runs/:id/replays", async (c) => c.json({ label: "synthetic", replays: await (await workspace(c.env)).listReplays(c.req.param("id")) }));

  app.get("/api/results/:id", async (c) => {
    const r = await (await workspace(c.env)).getResult(c.req.param("id"));
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json(envelope(r));
  });

  app.get("/api/traces/:id", async (c) => {
    const t = await (await workspace(c.env)).getTrace(c.req.param("id"));
    return t ? c.json(t) : c.json({ error: "not found" }, 404);
  });

  // ---------- reviews, approvals, audit ----------
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
    if (out.ok) await ws.wakeApproval(c.req.param("id"));
    return c.json(out);
  });
  app.post("/api/approvals/:id/reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const ws = await workspace(c.env);
    const out = await ws.reject(c.var.principal, c.req.param("id"), body.reason ?? null);
    if (out.ok) await ws.wakeApproval(c.req.param("id"));
    return c.json(out);
  });
  app.post("/api/actions/:seq/rollback", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    return c.json(await (await workspace(c.env)).rollback(c.var.principal, Number(c.req.param("seq")), body.reason ?? ""));
  });
  app.get("/api/audit", async (c) => c.json({ label: "synthetic", actions: await (await workspace(c.env)).auditLog(Number(c.req.query("since") ?? 0)), approvals: await (await workspace(c.env)).approvalAuditLog() }));
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
    const body = (await c.req.json()) as { question: string; provider?: string };
    const name = await agentInstanceName(c.var.config.hmacKey, c.var.principal.id);
    const agent = await getAgentByName<Env, AnalystAgent>(c.env.ANALYST_AGENT, name);
    return c.json(await agent.turn(c.var.principal, body.question, body.provider as never));
  });

  // ---------- runner protocol (ADR 0002) ----------
  app.use("/internal/*", async (c, next) => {
    const cfg = c.var.config;
    const auth = c.req.header("Authorization") ?? "";
    if (cfg.runnerToken && auth === `Bearer ${cfg.runnerToken}`) return next();
    try {
      const p = await authenticate(c.req.raw, cfg);
      if (p.id === "svc:staysignal-runner") return next();
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
