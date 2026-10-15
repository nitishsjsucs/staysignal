// StaySignal Worker entry: the Hono API, the MCP server at /mcp, server-side routing of agent WebSockets, and the
// Durable Object and Workflow classes. Agent connections are routed server-side: the Worker authenticates, picks the instance from the verified
// principal (AnalystAgent "an_" + HMAC of the principal ID; the shared WorkspaceAgent "larkspur", or the visitor's
// sandbox "sbx-<id>" in the public demo) and forwards the request with the principal in an internal header that
// clients cannot set. A configuration that fails its rules (src/worker/config.ts) answers 503 to every request.
import { getAgentByName } from "agents";
import { buildApp } from "./app";
import { AuthError } from "./auth/access";
import { analystName, authenticate, stripPrincipal, withPrincipal, workspaceName } from "./auth/principal";
import { type AppConfig, parseConfig } from "./config";
import { admitJson } from "./demo/admit";
import { handleMcp, MCP_ROUTE } from "./mcp/server";

export { AnalystAgent } from "./agents/analyst-agent";
export { WorkspaceAgent } from "./agents/workspace-agent";
export { RoutineWorkflow } from "./workflows/routine-workflow";
export { DemoGate } from "./demo/gate";

const app = buildApp();

async function routeAgent(request: Request, env: Env, cfg: AppConfig, kind: "analyst" | "workspace"): Promise<Response> {
  let principal;
  try {
    principal = await authenticate(request, cfg);
  } catch (e) {
    return Response.json({ error: "unauthenticated", reason: e instanceof AuthError ? e.reason : "invalid" }, { status: 401 });
  }
  const forwarded = withPrincipal(stripPrincipal(request), principal);
  const ws = kind === "workspace" || cfg.publicDemo ? await getAgentByName(env.WORKSPACE_AGENT, workspaceName(principal)) : null;
  if (cfg.publicDemo && ws) {
    // an upgrade spends one unit of the visitor's sandbox (ADR 0018)
    const v = await ws.admit(1);
    if (!v.ok) return admitJson(v);
  }
  if (kind === "workspace" && ws) return ws.fetch(forwarded);
  return (await getAgentByName(env.ANALYST_AGENT, await analystName(cfg, principal))).fetch(forwarded);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let cfg: AppConfig;
    try {
      cfg = parseConfig(env);
    } catch (e) {
      console.error(`staysignal: refusing to start: ${e instanceof Error ? e.message : String(e)}`);
      return Response.json({ error: "misconfigured", message: "This StaySignal deployment is not configured correctly." }, { status: 503 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/agents-ws/analyst" || url.pathname.startsWith("/agents-ws/analyst/")) return routeAgent(request, env, cfg, "analyst");
    if (url.pathname === "/agents-ws/workspace" || url.pathname.startsWith("/agents-ws/workspace/")) return routeAgent(request, env, cfg, "workspace");
    if (url.pathname.startsWith("/agents/")) return new Response("Agents are routed through /agents-ws/* only", { status: 404 });
    if (url.pathname === MCP_ROUTE) return cfg.publicDemo ? Response.json({ error: "not found" }, { status: 404 }) : handleMcp(request, env, ctx);
    return app.fetch(stripPrincipal(request), env, ctx);
  },
} satisfies ExportedHandler<Env>;
