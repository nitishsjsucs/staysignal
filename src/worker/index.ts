// StaySignal Worker entry: the Hono API, the MCP server at /mcp, server-side routing of agent WebSockets, and the
// Durable Object and Workflow classes. Agent connections are routed server-side: the Worker authenticates, picks the instance from the verified
// principal (AnalystAgent "an_" + HMAC of the principal ID; the shared WorkspaceAgent "larkspur") and forwards the
// request with the principal in an internal header that clients cannot set.
import { getAgentByName } from "agents";
import { buildApp } from "./app";
import { AuthError } from "./auth/access";
import { agentInstanceName } from "./auth/hmac";
import { authenticate, stripPrincipal, withPrincipal } from "./auth/principal";
import { parseConfig } from "./config";
import { handleMcp, MCP_ROUTE } from "./mcp/server";

export { AnalystAgent } from "./agents/analyst-agent";
export { WorkspaceAgent } from "./agents/workspace-agent";
export { RoutineWorkflow } from "./workflows/routine-workflow";

const app = buildApp();

async function routeAgent(request: Request, env: Env, kind: "analyst" | "workspace"): Promise<Response> {
  const cfg = parseConfig(env);
  let principal;
  try {
    principal = await authenticate(request, cfg);
  } catch (e) {
    return Response.json({ error: "unauthenticated", reason: e instanceof AuthError ? e.reason : "invalid" }, { status: 401 });
  }
  const forwarded = withPrincipal(stripPrincipal(request), principal);
  if (kind === "workspace") return (await getAgentByName(env.WORKSPACE_AGENT, "larkspur")).fetch(forwarded);
  const name = await agentInstanceName(cfg.hmacKey, principal.id);
  return (await getAgentByName(env.ANALYST_AGENT, name)).fetch(forwarded);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/agents-ws/analyst" || url.pathname.startsWith("/agents-ws/analyst/")) return routeAgent(request, env, "analyst");
    if (url.pathname === "/agents-ws/workspace" || url.pathname.startsWith("/agents-ws/workspace/")) return routeAgent(request, env, "workspace");
    if (url.pathname.startsWith("/agents/")) return new Response("Agents are routed through /agents-ws/* only", { status: 404 });
    if (url.pathname === MCP_ROUTE) return handleMcp(request, env, ctx);
    return app.fetch(stripPrincipal(request), env, ctx);
  },
} satisfies ExportedHandler<Env>;
