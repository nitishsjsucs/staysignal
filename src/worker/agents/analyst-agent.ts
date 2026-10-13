// AnalystAgent (SPEC 14.2): one stateful chat agent per user, named "an_" + HMAC of the principal ID so no email
// appears in a URL. State is server-authoritative and small; persisted messages carry placeholders and result IDs
// only, never tool payloads. Tool results stream to the UI as they complete (the page behind the dock updates at once);
// the narrated text streams after the grounding check, so no ungrounded number is ever shown.
import { AIChatAgent } from "@cloudflare/ai-chat";
import type { Connection, ConnectionContext } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse, type ModelMessage } from "ai";
import { canonicalJson } from "../../shared/canonical-json";
import type { Principal } from "../../shared/policy/roles";
import type { ToolContext } from "../../shared/tools/registry";
import { parseConfig } from "../config";
import { sha256HexSync } from "../store/chain";
import { warehouseFor } from "../warehouse/client";
import { principalFromHeader } from "./workspace-agent";
import { type ProviderName, } from "./providers";
import { runTurn, type TurnOptions, type TurnOutput } from "./turn";
import { workspace, workspaceStub } from "./workspace-port";

export interface AnalystState {
  role: string | null;
  provider: ProviderName;
  demoMode: boolean;
  lastTraceId: string | null;
  groundingLast: TurnOutput["grounding"] | null;
}

export class AnalystAgent extends AIChatAgent<Env, AnalystState> {
  override initialState: AnalystState = { role: null, provider: "stub", demoMode: false, lastTraceId: null, groundingLast: null };
  override maxPersistedMessages = 200;

  override validateStateChange(_next: AnalystState, source: Connection | "server"): void {
    if (source !== "server") throw new Error("AnalystAgent state is server-authoritative");
  }

  override onConnect(connection: Connection, ctx: ConnectionContext) {
    const p = principalFromHeader(ctx.request);
    if (!p) {
      connection.close(4401, "unauthenticated");
      return;
    }
    connection.setState({ principal: p });
    const cfg = parseConfig(this.env);
    this.setState({ ...this.state, role: p.role, provider: cfg.llm as ProviderName, demoMode: cfg.demo });
    return super.onConnect(connection, ctx);
  }

  private principal(): Principal | null {
    for (const c of this.getConnections()) {
      const p = (c.state as { principal?: Principal } | null)?.principal;
      if (p) return p;
    }
    return null;
  }

  toolContext(p: Principal): ToolContext {
    return { principal: p, warehouse: warehouseFor(this.env), workspace: workspaceStub(this.env), sha256: async (t) => sha256HexSync(t), canonical: canonicalJson };
  }

  /** The production model's settings and the shared neuron budget (WorkspaceAgent), when SS_LLM=workers-ai. */
  turnOptions(p: Principal, route: string): TurnOptions {
    const cfg = parseConfig(this.env);
    if (!cfg.workersAi) return {};
    let day = "";
    return {
      workersAi: cfg.workersAi,
      meta: { route, role: p.role },
      budget: {
        reserve: async (neurons, cap) => {
          const r = await (await workspace(this.env)).reserveNeurons(neurons, cap);
          day = r.day;
          return r;
        },
        settle: async (reserved, actual) => {
          if (day) await (await workspace(this.env)).settleNeurons(day, reserved, actual);
        },
      },
    };
  }

  /** The same turn over RPC: used by /api/dev/agent/turn and the eval harness. */
  async turn(p: Principal, question: string, provider?: ProviderName, history: { role: "user" | "assistant"; content: string }[] = [], captureSteps = false): Promise<TurnOutput> {
    const cfg = parseConfig(this.env);
    const out = await runTurn(this.toolContext(p), provider ?? (cfg.llm as ProviderName), question, history as ModelMessage[], {}, { ...this.turnOptions(p, "api"), captureSteps });
    await this.recordTrace(p, out);
    return out;
  }

  private async recordTrace(p: Principal, out: TurnOutput): Promise<string> {
    const traceId = `trc_${sha256HexSync(`${p.id}|${out.question}|${Date.now()}`).slice(0, 20)}`;
    await workspaceStub(this.env).storeTrace(traceId, p.id, { trace_id: traceId, question: out.question, provider: out.provider, recorded: out.recorded, grounding: out.grounding, spans: out.spans, tool_calls: out.tool_calls, violations: out.violations });
    this.setState({ ...this.state, lastTraceId: traceId, groundingLast: out.grounding });
    return traceId;
  }

  override async onChatMessage() {
    const p = this.principal();
    const last = this.messages[this.messages.length - 1];
    const question = last?.parts.map((part) => (part.type === "text" ? part.text : "")).join(" ").trim() ?? "";
    const history: ModelMessage[] = [];
    const cfg = parseConfig(this.env);
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        if (!p) {
          writer.write({ type: "error", errorText: "unauthenticated" });
          return;
        }
        const out = await runTurn(this.toolContext(p), cfg.llm as ProviderName, question, history, {
          onToolCall: (c) => writer.write({ type: "tool-input-available", toolCallId: c.toolCallId, toolName: c.tool, input: c.args }),
          onToolResult: (c) => writer.write({ type: "tool-output-available", toolCallId: c.toolCallId, output: { result_id: c.record.result_id, alias: c.record.alias, tool: c.record.tool, refused: c.record.refused } }),
        }, this.turnOptions(p, "chat"));
        const traceId = await this.recordTrace(p, out);
        writer.write({ type: "data-turn", data: { grounding: out.grounding, aliases: out.aliases, refusal: out.refusal, label: out.label, recorded: out.recorded, trace_id: traceId } } as never);
        writer.write({ type: "text-start", id: "answer" });
        writer.write({ type: "text-delta", id: "answer", delta: out.text });
        writer.write({ type: "text-end", id: "answer" });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
