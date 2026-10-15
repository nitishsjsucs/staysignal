// Traces page (SPEC 16.1, 14.12): every answer's trace, so it is visible where the time went and what was checked:
// the pre-router, model calls with tokens, tool calls with their result IDs, the grounding check and any repair or
// template. Analysts see their own traces, leads every trace, the auditor metadata only. Synthetic data.
import { useState } from "react";
import { isRefusal, type Me, type Refusal, useQuery } from "../api";
import { type Span, TraceGantt, TraceTable } from "../charts/TraceGantt";
import { ChartCard } from "../components/ChartCard";
import { EmptyState, ErrorState, RefusalNote, Skeleton } from "../components/ui";
import { navigate } from "../router";
import { PageHead } from "./Forecast";

interface TraceView {
  trace_id: string;
  owner: string;
  created_at: string;
  provider: string | null;
  recorded: boolean;
  grounding: string | null;
  question: string | null;
  tool_calls: { tool: string; result_id: string | null }[];
  violations: string[];
  spans: Span[];
  metadata_only: boolean;
}

function total(t: TraceView): number {
  return Math.max(0, ...t.spans.map((s) => s.start_ms + s.dur_ms));
}

export function TracesPage(_: { me: Me }) {
  const list = useQuery<{ traces: TraceView[] } | Refusal>("/api/traces?limit=50");
  const [picked, setPicked] = useState<string | null>(null);
  const head = <PageHead title="Traces" sub="Where the time went in each answer and what was checked: the pre-router, model calls, tool calls with their results, and the numeric grounding check." />;
  if (list.error) return <ErrorState error={list.error} />;
  if (!list.data) {
    return (
      <>
        {head}
        <Skeleton height={240} />
      </>
    );
  }
  if (isRefusal(list.data)) {
    return (
      <>
        {head}
        <RefusalNote code={list.data.code} message={list.data.message} />
      </>
    );
  }
  const traces = list.data.traces;
  const current = traces.find((t) => t.trace_id === picked) ?? traces[0] ?? null;
  return (
    <>
      {head}
      {!traces.length ? (
        <section className="card">
          <EmptyState>No traces yet: ask a question in the chat dock and its trace appears here.</EmptyState>
        </section>
      ) : (
        <>
          <section className="card" data-testid="trace-list">
            <div className="card-head">
              <h2 className="card-title">Recent answers</h2>
              <div className="card-sub">{current?.metadata_only ? "Metadata only for your role: no question text or tool arguments" : "Newest first"}</div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When (synthetic clock)</th>
                    <th>Question</th>
                    <th>Model</th>
                    <th>Grounding</th>
                    <th className="num">Time (ms)</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((t) => (
                    <tr key={t.trace_id} aria-selected={t.trace_id === current?.trace_id}>
                      <td>
                        <button type="button" className="link-btn" onClick={() => setPicked(t.trace_id)}>
                          {t.created_at.replace("T", " ").slice(0, 16)}
                        </button>
                      </td>
                      <td style={{ whiteSpace: "normal" }}>{t.question ?? "(metadata only)"}</td>
                      <td>{t.recorded ? (t.provider === "recorded" ? "recorded turn, replayed" : `${t.provider ?? ""} (recorded)`) : (t.provider ?? "")}</td>
                      <td>{t.grounding ?? ""}</td>
                      <td className="num">{total(t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {current ? (
            <ChartCard
              id="trace"
              title="Where did the time go in this answer, and what was checked?"
              subtitle={`${current.trace_id} · ${current.provider ?? "model"} · grounding ${current.grounding ?? "n/a"}`}
              table={<TraceTable spans={current.spans} />}
              resultIds={current.tool_calls.map((c) => c.result_id)}
              height={200}
            >
              <TraceGantt spans={current.spans} />
              {current.violations.length ? (
                <ul className="card-sub" style={{ marginTop: 8 }}>
                  {current.violations.map((v) => (
                    <li key={v}>Grounding: {v}</li>
                  ))}
                </ul>
              ) : null}
              {current.tool_calls.length ? (
                <p className="card-sub" style={{ marginTop: 8 }}>
                  Tools:{" "}
                  {current.tool_calls.map((c, i) => (
                    <span key={`${c.tool}-${i}`}>
                      {i ? ", " : ""}
                      {c.result_id ? (
                        <a
                          href={`/r/${c.result_id}`}
                          onClick={(e) => {
                            e.preventDefault();
                            navigate(`/r/${c.result_id}`);
                          }}
                        >
                          {c.tool}
                        </a>
                      ) : (
                        c.tool
                      )}
                    </span>
                  ))}
                </p>
              ) : null}
            </ChartCard>
          ) : null}
        </>
      )}
    </>
  );
}
