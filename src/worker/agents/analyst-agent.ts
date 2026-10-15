// AnalystAgent (SPEC 14.2): one stateful chat agent per user, named "an_" + HMAC of the principal ID so no email
// appears in a URL. State is server-authoritative and small; persisted messages carry placeholders and result IDs
// only, never tool payloads. Tool results stream to the UI as they complete (the page behind the dock updates at once);
// the narrated text streams after the grounding check, so no ungrounded number is ever shown.
// In the public demo (ADR 0018) a frame guard runs before the SDK: only a chat request, a cancel and the stream-resume
// handshake reach it; a chat request spends the turn's units first and carries only the server's own history plus the
// visitor's one new question, so the SDK never persists anything the units did not pay for.
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { Connection, ConnectionContext } from "agents";
import { createUIMessageStream, createUIMessageStreamResponse, type ModelMessage } from "ai";
import { canonicalJson } from "../../shared/canonical-json";
import type { Principal } from "../../shared/policy/roles";
import type { ToolContext } from "../../shared/tools/registry";
import { parseConfig } from "../config";
import { sha256HexSync } from "../store/chain";
import { memoryPort, warehouseFor } from "../warehouse/client";
import { CAPS, UNITS } from "../../shared/demo/budget";
import { guardFrames } from "../demo/frames";
import type { AdmitVerdict } from "../demo/meter";
import { principalFromHeader } from "./workspace-agent";
import { type ProviderName, } from "./providers";
import { runTurn, type TurnOptions, type TurnOutput } from "./turn";
import { workspaceRef, workspaceStub } from "./workspace-port";

/** What the chat says when the public demo's caps stop a turn (ADR 0018). */
export const DEMO_TURN_MESSAGES = {
  tooLong: `Questions are limited to ${CAPS.maxQuestionChars} characters in the public demo.`,
  busy: "The demo is busy, try again later.",
  spent: "This sandbox has used its request allowance. Reset it from the banner to start a fresh one.",
  expired: "Your sandbox has ended. Reload the page to start a new one.",
} as const;

/** The chat protocol's frame types a public-demo visitor's browser may send (agents/chat CHAT_MESSAGE_TYPES). Everything
 * else (whole message lists, clears, tool results and approvals, RPC, state) is dropped before the SDK sees it. */
const DEMO_PASS_THROUGH = new Set(["cf_agent_chat_request_cancel", "cf_agent_stream_resume_request", "cf_agent_stream_resume_ack"]);
const CHAT_REQUEST = "cf_agent_use_chat_request";
const MAX_ID_CHARS = 64;

type Refused = Exclude<AdmitVerdict, { ok: true }>;

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

  /** Chat requests whose units the frame guard already spent (the public demo), by request ID. */
  private readonly preAdmitted = new Set<string>();
  /** The sandbox's last refusal, kept in memory so a spent, ended or busy sandbox costs no further request to learn it. */
  private refused: { verdict: Refused; until: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // the public demo bounds WebSocket frames, lets through only what the dock sends and keeps a shorter history
    if ((env as unknown as Record<string, string | undefined>).SS_AUTH_MODE === "demo") {
      guardFrames(this, { filter: (connection, message) => this.demoFrame(connection, message) });
      this.maxPersistedMessages = 40;
    }
  }

  /** The public demo's frame filter (ADR 0018): the frame to hand to the SDK, or null. */
  private async demoFrame(connection: Connection, raw: string): Promise<string | null> {
    let frame: { type?: unknown; id?: unknown; init?: { method?: unknown; body?: unknown } } | null;
    try {
      frame = JSON.parse(raw) as typeof frame;
    } catch {
      return null;
    }
    if (!frame || typeof frame !== "object") return null;
    if (typeof frame.type === "string" && DEMO_PASS_THROUGH.has(frame.type)) return raw;
    if (frame.type !== CHAT_REQUEST) return null;
    const p = (connection.state as { principal?: Principal } | null)?.principal;
    const id = frame.id;
    if (!p?.sandbox || typeof id !== "string" || !id || id.length > MAX_ID_CHARS || frame.init?.method !== "POST" || typeof frame.init.body !== "string") return null;
    let body: { messages?: unknown; trigger?: unknown };
    try {
      body = JSON.parse(frame.init.body) as typeof body;
    } catch {
      return null;
    }
    const messages = Array.isArray(body?.messages) ? (body.messages as unknown[]) : [];
    const last = messages[messages.length - 1] as { id?: unknown; role?: unknown; parts?: unknown } | undefined;
    // one new question from the visitor; the history is the server's own, never what the browser sends
    if (body.trigger === "regenerate-message" || !last || last.role !== "user" || typeof last.id !== "string" || !last.id || last.id.length > MAX_ID_CHARS || !Array.isArray(last.parts)) return null;
    if (this.messages.some((m) => m.id === last.id)) return null;
    const question = (last.parts as { type?: unknown; text?: unknown }[]).map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join(" ").trim();
    if (!question) return null;
    const stop = await this.admitTurn(p, question);
    if (stop) {
      this.replyWithout(connection, id, stop);
      return null;
    }
    this.preAdmitted.add(id);
    const next = { id: last.id, role: "user", parts: [{ type: "text", text: question }] };
    return JSON.stringify({ type: CHAT_REQUEST, id, init: { method: "POST", body: JSON.stringify({ messages: [...this.messages, next], trigger: "submit-message" }) } });
  }

  /** Answers a refused chat request on its own stream and stores nothing: the dock shows the message, the
   * conversation is unchanged. */
  private replyWithout(connection: Connection, id: string, text: string): void {
    const chunks = [
      { type: "start" },
      { type: "data-turn", data: { grounding: "refused", aliases: {}, refusal: null, label: null, recorded: false, suggestions: null, trace_id: null } },
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: text },
      { type: "text-end", id: "answer" },
      { type: "finish" },
    ];
    for (const c of chunks) connection.send(JSON.stringify({ type: "cf_agent_use_chat_response", id, body: JSON.stringify(c), done: false }));
    connection.send(JSON.stringify({ type: "cf_agent_use_chat_response", id, body: "", done: true }));
  }

  /** The public demo: this conversation is deleted when its sandbox expires. */
  async expireSandbox(): Promise<void> {
    await this.destroy();
  }

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
    if (p.sandbox) void this.scheduleExpiry(p.sandbox.exp);
    return super.onConnect(connection, ctx);
  }

  private async scheduleExpiry(expSeconds: number): Promise<void> {
    if ((await this.listSchedules()).some((x) => x.callback === "expireSandbox")) return;
    await this.schedule(new Date(expSeconds * 1000), "expireSandbox", "expiry");
  }

  private principal(): Principal | null {
    for (const c of this.getConnections()) {
      const p = (c.state as { principal?: Principal } | null)?.principal;
      if (p) return p;
    }
    return null;
  }

  /** The tools' context: the principal's workspace (its sandbox in the public demo), one stub for the turn. */
  toolContext(p: Principal): ToolContext {
    const ref = workspaceRef(this.env, p);
    return { principal: p, warehouse: warehouseFor(this.env, memoryPort(ref)), workspace: workspaceStub(this.env, p, ref), sha256: async (t) => sha256HexSync(t), canonical: canonicalJson };
  }

  /** The production model's settings and the shared neuron budget (WorkspaceAgent), when SS_LLM=workers-ai. */
  turnOptions(p: Principal, route: string): TurnOptions {
    const cfg = parseConfig(this.env);
    const demo: TurnOptions = { unrecorded: cfg.chatFallback === "stub" ? "stub" : "message", recordedOn: cfg.recordedOn };
    if (!cfg.workersAi) return demo;
    const ws = workspaceRef(this.env, p);
    let day = "";
    return {
      ...demo,
      workersAi: cfg.workersAi,
      meta: { route, role: p.role },
      budget: {
        reserve: async (neurons, cap) => {
          const r = await (await ws()).reserveNeurons(neurons, cap);
          day = r.day;
          return r;
        },
        settle: async (reserved, actual) => {
          if (day) await (await ws()).settleNeurons(day, reserved, actual);
        },
      },
    };
  }

  /** The same turn over RPC: used by /api/dev/agent/turn and the eval harness. */
  async turn(p: Principal, question: string, provider?: ProviderName, history: { role: "user" | "assistant"; content: string }[] = [], captureSteps = false): Promise<TurnOutput> {
    const cfg = parseConfig(this.env);
    const stop = await this.demoStop(p, question);
    if (stop) return { question, text: stop, rendered: stop, aliases: {}, tool_calls: [], grounding: "refused", refusal: null, provider: "recorded", recorded: false, label: null, violations: [], spans: [] };
    // demo mode replays recordings only: a provider named in the request cannot reach a live model
    const out = await runTurn(this.toolContext(p), cfg.demo ? "recorded" : (provider ?? (cfg.llm as ProviderName)), question, history as ModelMessage[], {}, { ...this.turnOptions(p, "api"), captureSteps });
    await this.recordTrace(p, out);
    return out;
  }

  private async recordTrace(p: Principal, out: TurnOutput): Promise<string> {
    const traceId = `trc_${sha256HexSync(`${p.id}|${out.question}|${Date.now()}`).slice(0, 20)}`;
    await workspaceStub(this.env, p).storeTrace(traceId, p.id, { trace_id: traceId, question: out.question, provider: out.provider, recorded: out.recorded, grounding: out.grounding, spans: out.spans, tool_calls: out.tool_calls, violations: out.violations });
    this.setState({ ...this.state, lastTraceId: traceId, groundingLast: out.grounding });
    return traceId;
  }

  /** The public demo: a bounded question, the conversation's deletion at the sandbox's expiry, and the turn's units
   * spent in the visitor's sandbox. The message to show when the turn may not run, else null. */
  private async admitTurn(p: Principal, question: string): Promise<string | null> {
    if (!p.sandbox) return null;
    if (question.length > CAPS.maxQuestionChars) return DEMO_TURN_MESSAGES.tooLong;
    const now = Date.now();
    if (this.refused && this.refused.until > now) return refusalMessage(this.refused.verdict);
    await this.scheduleExpiry(p.sandbox.exp);
    const v = await (await workspaceRef(this.env, p)()).admit(UNITS.chatTurn);
    if (v.ok) return null;
    this.refused = { verdict: v, until: v.code === "RATE_LIMITED" ? now + v.retryAfterSeconds * 1000 : p.sandbox.exp * 1000 };
    return refusalMessage(v);
  }

  /** The RPC turn (dev and evals; off in the public demo) and any turn the frame guard did not admit. */
  private demoStop(p: Principal, question: string): Promise<string | null> {
    return this.admitTurn(p, question);
  }

  override async onChatMessage(_onFinish?: unknown, options?: OnChatMessageOptions) {
    const p = this.principal();
    // a chat request the public demo's frame guard admitted has already spent its units
    const paid = Boolean(options?.requestId && this.preAdmitted.delete(options.requestId));
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
        {
          const stop = paid ? null : await this.demoStop(p, question);
          if (stop) {
            writer.write({ type: "data-turn", data: { grounding: "refused", aliases: {}, refusal: null, label: null, recorded: false, suggestions: null, trace_id: null } } as never);
            writer.write({ type: "text-start", id: "answer" });
            writer.write({ type: "text-delta", id: "answer", delta: stop });
            writer.write({ type: "text-end", id: "answer" });
            return;
          }
        }
        const out = await runTurn(this.toolContext(p), cfg.llm as ProviderName, question, history, {
          onToolCall: (c) => writer.write({ type: "tool-input-available", toolCallId: c.toolCallId, toolName: c.tool, input: c.args }),
          onToolResult: (c) => writer.write({ type: "tool-output-available", toolCallId: c.toolCallId, output: { result_id: c.record.result_id, alias: c.record.alias, tool: c.record.tool, refused: c.record.refused } }),
        }, this.turnOptions(p, "chat"));
        const traceId = await this.recordTrace(p, out);
        writer.write({ type: "data-turn", data: { grounding: out.grounding, aliases: out.aliases, refusal: out.refusal, label: out.label, recorded: out.recorded, suggestions: out.suggestions ?? null, trace_id: traceId } } as never);
        writer.write({ type: "text-start", id: "answer" });
        writer.write({ type: "text-delta", id: "answer", delta: out.text });
        writer.write({ type: "text-end", id: "answer" });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}

function refusalMessage(v: Refused): string {
  return v.code === "SANDBOX_EXPIRED" ? DEMO_TURN_MESSAGES.expired : v.code === "SANDBOX_SPENT" ? DEMO_TURN_MESSAGES.spent : DEMO_TURN_MESSAGES.busy;
}
