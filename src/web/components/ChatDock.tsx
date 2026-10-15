// The chat dock (SPEC 16): a persistent conversation with the user's AnalystAgent. Tool results update the page behind
// the dock through URL state; narrated numbers are placeholders rendered from stored results, each a link to the
// computed result; every answer carries its grounding chip and, for replayed turns, the recorded-turn label.
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type Fmt, fmtNumber, fmtRange } from "../../shared/format";
import { PLACEHOLDER, resolvePath, shownValue } from "../../shared/grounding/aliases";
import { getJSON, type Me } from "../api";
import { navigate, setView } from "../router";
import { IconClose, IconSend } from "./icons";
import { Chip, StatusPill } from "./ui";

interface StoredResult {
  result_id: string;
  rounding: { step: number } | null;
  provenance: { tool: string; args: Record<string, unknown> };
  data: unknown;
}

const resultCache = new Map<string, Promise<StoredResult>>();

function loadResult(id: string): Promise<StoredResult> {
  let p = resultCache.get(id);
  if (!p) {
    p = getJSON<StoredResult>(`/api/results/${id}`);
    resultCache.set(id, p);
  }
  return p;
}

function formatValue(v: unknown, fmt: Fmt | undefined, step: number | null): string {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number") return fmtRange(v as [number, number]);
  if (typeof v === "number") {
    if (fmt === "pct") return fmtNumber(v, "pct");
    if (fmt === "int" || (step !== null && step >= 1)) return fmtNumber(v, "int");
    if (fmt === "1dp") return fmtNumber(v, "1dp");
    return fmtNumber(v, "raw", step ?? undefined);
  }
  return String(v ?? "");
}

/** Renders narration: placeholders become linked numbers resolved from the stored results of the turn. */
export function Answer({ text, aliases }: { text: string; aliases: Record<string, string> }) {
  const [results, setResults] = useState<Record<string, StoredResult>>({});
  useEffect(() => {
    let alive = true;
    for (const [alias, id] of Object.entries(aliases)) {
      loadResult(id).then((r) => alive && setResults((s) => ({ ...s, [alias]: r })), () => undefined);
    }
    return () => {
      alive = false;
    };
  }, [aliases]);
  const parts: (string | { key: string; label: string; id: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(new RegExp(PLACEHOLDER.source, "g"))) {
    parts.push(text.slice(last, m.index));
    const alias = m[1] ?? "";
    const r = results[alias];
    const id = aliases[alias] ?? "";
    parts.push({ key: `${m.index}`, label: r ? formatValue(shownValue(resolvePath(r.data, m[2] ?? ""), text, m.index ?? 0), m[3] as Fmt | undefined, r.rounding?.step ?? null) : "...", id });
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <a
            key={p.key}
            className="num-link"
            href={`/r/${p.id}`}
            title="Open the computed result"
            onClick={(e) => {
              e.preventDefault();
              navigate(`/r/${p.id}`);
            }}
          >
            {p.label}
          </a>
        ),
      )}
    </>
  );
}

const PAGE_FOR: Record<string, string> = { forecast_departures: "/", forecast_breakdown: "/", forecast_history: "/", backtest_summary: "/trust", explain_change: "/changes", data_quality_status: "/quality", trace_lineage: "/quality", prepare_review: "/reviews", cohort_profile: "/", workforce_flows: "/workforce", search_memory: "/memory" };

async function followResult(id: string, tool: string): Promise<void> {
  try {
    const r = await loadResult(id);
    const args = r.provenance.args;
    const target = PAGE_FOR[tool];
    if (target && window.location.pathname !== "/ask") {
      if (target !== window.location.pathname) navigate(target + window.location.search);
    }
    const cohort = typeof args.cohort === "string" ? args.cohort : null;
    const h = typeof args.horizon_months === "number" ? (args.horizon_months as 1 | 3 | 6) : null;
    if (cohort || h) setView({ ...(cohort ? { cohort } : {}), ...(h ? { horizon: h } : {}) });
    if (tool === "prepare_review" && window.location.pathname === "/reviews") {
      // the Reviews page opens the drafted review from its result ID, ready to submit
      const q = new URLSearchParams(window.location.search);
      q.set("draft", id);
      navigate(`/reviews?${q.toString()}`, { replace: true });
    }
  } catch {
    // the page keeps its state
  }
}

interface TurnData {
  grounding: string;
  aliases: Record<string, string>;
  refusal: { code: string; message: string; layer: string } | null;
  label: string | null;
  recorded: boolean;
  /** Demo mode, a question with no recording: the recorded questions to ask instead. */
  suggestions?: string[] | null;
  trace_id: string;
}

/** The public demo's examples of questions with no recording: the deterministic stub answers them, labeled. */
const PUBLIC_STUB_SUGGESTIONS = ["Break down the Engineering forecast by group over the next 3 months.", "Which checks failed on the payroll data?"];

const SUGGESTIONS = [
  "Forecast voluntary departures in Engineering over the next 90 days.",
  "What changed since the previous forecast?",
  "Which checks failed on the payroll data, and where did the bad value come from?",
  "Prepare a People Partner review for Platform Engineering.",
];

export function Conversation({ me, full = false }: { me: Me; full?: boolean }) {
  const agent = useAgent({ agent: "analyst-agent", basePath: "agents-ws/analyst" });
  const { messages, sendMessage, status, clearHistory } = useAgentChat({ agent, getInitialMessages: null });
  const [input, setInput] = useState("");
  // demo mode replays recorded answers only, so its chips are exactly the recorded questions; the public demo adds two
  // questions the deterministic stub answers, and every chip says which kind it is (ADR 0018)
  const demo = me.demo ?? null;
  const publicDemo = me.public_demo ?? null;
  const chips = demo ? demo.recorded_questions : SUGGESTIONS;
  const stubChips = publicDemo ? PUBLIC_STUB_SUGGESTIONS.filter((q) => !chips.includes(q)) : [];
  const seen = useRef(new Set<string>());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return;
    for (const part of last.parts) {
      const p = part as { type: string; state?: string; output?: { result_id?: string | null; tool?: string } };
      if (p.type.startsWith("tool-") && p.state === "output-available" && p.output?.result_id && !seen.current.has(p.output.result_id)) {
        seen.current.add(p.output.result_id);
        void followResult(p.output.result_id, p.output.tool ?? p.type.slice(5));
      }
    }
  }, [messages]);
  const submit = (text: string) => {
    const t = text.trim();
    if (!t || status === "streaming" || status === "submitted") return;
    void sendMessage({ text: t });
    setInput("");
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(input);
  };
  return (
    <>
      <div className="dock-body" ref={bodyRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="suggestions">
            <p style={{ color: "var(--ink-2)", fontSize: 13, marginBottom: 6 }}>
              Ask about a cohort's forecast, what changed, data quality or a review. Answers come from governed tools; every number links to the result that produced it.
            </p>
            {publicDemo ? (
              <p style={{ color: "var(--ink-2)", fontSize: 12, marginBottom: 6 }} data-testid="dock-demo-note">
                No model runs in this demo. The recorded questions replay turns recorded from Qwen3.6-27B on {publicDemo.recorded_on}; any other question gets a labeled deterministic stub. The tools run live in your sandbox; their numbers come from results exported from the synthetic warehouse.
              </p>
            ) : demo ? (
              <p style={{ color: "var(--ink-2)", fontSize: 12, marginBottom: 6 }} data-testid="dock-demo-note">
                {demo.recorded_questions.length
                  ? "Model text in this demo was recorded from Qwen3.6-27B on this laptop and is replayed; the tools and numbers compute live from the warehouse."
                  : "No answers have been recorded for this demo yet: the model text is recorded once from Qwen3.6-27B on this laptop and replayed."}
              </p>
            ) : null}
            {chips.map((s) => (
              <button key={s} type="button" onClick={() => submit(s)}>
                {publicDemo ? <span className="chip-kind recorded">Recorded turn</span> : null}
                {s}
              </button>
            ))}
            {stubChips.map((s) => (
              <button key={s} type="button" onClick={() => submit(s)}>
                <span className="chip-kind stub">Stub</span>
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {messages.map((m) => {
          if (m.role === "user") {
            const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
            return (
              <div key={m.id} className="msg user">
                {text}
              </div>
            );
          }
          const data = m.parts.find((p) => p.type === "data-turn") as { data: TurnData } | undefined;
          const text = m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
          const tools = m.parts.filter((p) => p.type.startsWith("tool-")) as unknown as { type: string; state: string; output?: { result_id: string | null; refused: { code: string } | null } }[];
          return (
            <div key={m.id} className="msg assistant">
              {tools.map((t, i) => (
                <div key={i} className="tool-card" style={{ marginBottom: 6 }}>
                  <span>{t.type.slice(5).replace(/_/g, " ")}</span>
                  {t.output?.refused ? <span>refused: {t.output.refused.code}</span> : t.output?.result_id ? (
                    <a
                      href={`/r/${t.output.result_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`/r/${t.output!.result_id}`);
                      }}
                    >
                      result
                    </a>
                  ) : (
                    <span>running</span>
                  )}
                </div>
              ))}
              {data?.data.refusal ? <StatusPill status="warning">Refused: {data.data.refusal.code}</StatusPill> : null}
              <div style={{ marginTop: data?.data.refusal ? 6 : 0 }}>{data ? <Answer text={text} aliases={data.data.aliases} /> : text}</div>
              {data && data.data.grounding !== "unrecorded" ? (
                <div className="msg-meta">
                  {data.data.refusal ? <Chip>{data.data.refusal.layer === "tool" ? "Refused by the tool's permission check" : `Refused before any model call: ${data.data.refusal.layer}`}</Chip> : <Chip title="Numeric grounding check">Grounding: {data.data.grounding}</Chip>}
                  {data.data.label ? <Chip>{data.data.label}</Chip> : null}
                </div>
              ) : null}
              {data?.data.suggestions?.length ? (
                <div className="suggestions" style={{ marginTop: 8 }} data-testid="dock-recorded-chips">
                  {data.data.suggestions.map((s) => (
                    <button key={s} type="button" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
        {status === "submitted" || status === "streaming" ? <div className="msg assistant">Working: calling governed tools...</div> : null}
      </div>
      <form className="dock-form" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor={full ? "ask-full" : "ask-dock"}>
          Ask StaySignal
        </label>
        <textarea
          id={full ? "ask-full" : "ask-dock"}
          rows={2}
          value={input}
          maxLength={publicDemo ? publicDemo.limits.question_chars : undefined}
          placeholder={`Ask as ${me.principal.display}`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit(input);
            }
          }}
        />
        <button type="submit" className="btn btn-primary" aria-label="Send" disabled={!input.trim()}>
          <IconSend size={14} />
        </button>
        {/* the public demo keeps the conversation the sandbox paid for: its frame guard drops a clear (ADR 0018), and
            "Reset my sandbox" starts everything afresh */}
        {messages.length && !publicDemo ? (
          <button type="button" className="btn btn-sm" onClick={() => clearHistory()} title="Clear this conversation">
            Clear
          </button>
        ) : null}
      </form>
    </>
  );
}

export default function ChatDock({ me, onClose }: { me: Me; onClose: () => void }) {
  return (
    <aside className="dock" aria-label="Ask StaySignal">
      <div className="dock-head">
        <div>
          <div style={{ fontWeight: 600 }}>Ask StaySignal</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>Cohort-level answers from governed tools (synthetic data)</div>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close chat">
          <IconClose size={14} />
        </button>
      </div>
      <Conversation me={me} />
    </aside>
  );
}
