// The MCP server (SPEC 14.9): StaySignal's governed tools for MCP clients, under the same permissions as the chat
// dock. Stateless (`createMcpHandler`, a new server per request). Authentication runs before the handler: the Access
// JWT in production (MCP clients use the `staysignal-mcp` Access service token, whose principal is "svc:" plus its
// common name), a dev token in `Authorization: Bearer` only when SS_AUTH_MODE=dev and the host is localhost. Each
// principal is offered only the tools its role may use, every call goes through the same `runTool` (authorize,
// suppression, rounding, the population-change rule, content-addressed results), and no approval, submission,
// rollback or mapping action exists here: those are UI actions on the WorkspaceAgent. Synthetic data only.
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { isRefusal } from "../../shared/policy/refusals";
import type { Principal } from "../../shared/policy/roles";
import { runTool, type ToolResult, toolsFor } from "../../shared/tools/registry";
import { type ToolName, toolInputs } from "../../shared/tools/schemas";
import { envelope, toolContext } from "../app";
import { AuthError } from "../auth/access";
import { authenticate, stripPrincipal } from "../auth/principal";
import { parseConfig } from "../config";

export const MCP_ROUTE = "/mcp";

const INSTRUCTIONS =
  "StaySignal answers cohort-level questions about voluntary departures at Larkspur Systems, a synthetic company. " +
  "Every result is a cohort aggregate with a content-addressed result_id; quote numbers from results, never compute " +
  "them. Questions about individuals, managers or protected attributes are refused by design.";

/** One server for one authenticated principal: the tools its role may use, each running the governed registry. */
export function mcpServerFor(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "staysignal", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  for (const tool of toolsFor(principal)) {
    const name = tool.name as ToolName;
    server.registerTool(
      name,
      {
        title: name.replace(/_/g, " "),
        description: `${tool.description} Synthetic data.`,
        inputSchema: toolInputs[name],
        annotations: { readOnlyHint: tool.kind === "read", destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: unknown) => {
        const out = await runTool(toolContext(env, principal), name, args);
        if (isRefusal(out)) return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(out) }] };
        return { content: [{ type: "text" as const, text: JSON.stringify(envelope(out as ToolResult<unknown>)) }] };
      },
    );
  }
  return server;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cfg = parseConfig(env);
  let principal: Principal;
  try {
    principal = await authenticate(request, cfg);
  } catch (e) {
    return Response.json({ error: "unauthenticated", reason: e instanceof AuthError ? e.reason : "invalid" }, { status: 401 });
  }
  return createMcpHandler(() => mcpServerFor(env, principal), { route: MCP_ROUTE })(stripPrincipal(request), env, ctx);
}
