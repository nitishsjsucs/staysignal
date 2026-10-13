// Scenario Lab page (SPEC 15, 16.1): recorded sessions of synthetic personas reacting to a proposed change on a
// simulated forum. Hypothesis generation only: every view carries the label, every post and quote a "Synthetic
// persona" chip, and nothing here feeds a forecast number or review evidence (ADR 0008). A placeholder session (the
// scripted stub provider, no model) says so in a banner.
import { type FormEvent, useState } from "react";
import type { LabDoc, LabIndex } from "../../shared/contracts";
import { isRefusal, type Me, type Refusal, useQuery } from "../api";
import { fmtVal, TipRow, Tooltip, useTooltip, useWidth } from "../charts/kit";
import { ChartCard } from "../components/ChartCard";
import { IconAlert } from "../components/icons";
import { Chip, EmptyState, ErrorState, RefusalNote, Segmented, Skeleton } from "../components/ui";
import { PageHead } from "./Forecast";

const LAB_SUB = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.";
const POOLS = ["under 1 year", "1 to 3 years", "3 years or more"] as const;
const POOL_COLOR: Record<string, string> = { "under 1 year": "var(--lab-a)", "1 to 3 years": "var(--lab-b)", "3 years or more": "var(--lab-c)", "program office": "var(--series-challenger)", other: "var(--series-other)" };

type Range = { mean: number | null; min: number | null; max: number | null };
interface Analysis {
  themes: { shares: ({ theme: string } & Range)[]; top_by_round: Record<string, number[]> };
  trajectories: { stance_by_round: Record<string, Range[]>; scale: string };
  items: { items: Record<string, { pre: Range; post: Range; shift: Range }>; acquiescence_index: Range; note: string };
  network: { label: string; nodes: { id: string; cohort: string; pagerank: number; x: number; y: number }[]; edges: { source: string; target: string; weight: number }[] };
  pilot_items: { construct_label: string; wording: string; scale: string[]; rationale: string; quotes: { text: string; cohort: string }[]; validated_measure: string | null; recommendation: string | null; lint: string[]; label: string; source: string }[];
}
interface Sanity {
  label: string;
  persona_agreement: { spearman: number | null; ci95: [number, number] | null; n_cells: number; bootstrap: number };
  facts_only_baseline: { spearman: number | null; n_cells: number };
  negative_controls: Record<string, { spearman: number | null; n_cells: number }>;
  construct_note: string;
  limits: string[];
}

const THEME_LABEL: Record<string, string> = {
  criteria_clarity: "Promotion criteria clarity",
  process_fairness: "Fairness of process",
  workload: "Workload",
  pay_fairness: "Compensation fairness",
  manager_support: "Manager support",
  career_mobility: "Career mobility",
  team_identity: "Team identity",
  process_overhead: "Process overhead",
  recognition: "Recognition",
  change_uncertainty: "Uncertainty about the change",
  other: "Other",
};
// short labels for the narrow table; the full statement is the row's title
const ITEM_LABEL: Record<string, [string, string]> = {
  support: ["Support", "I support the proposed change."],
  clarity: ["Clarity", "It is clear what it takes to be promoted here."],
  clarity_rev: ["Unclear (reverse-keyed)", "It is unclear what it takes to be promoted here."],
  fairness: ["Fairness", "Promotion decisions here are made fairly."],
  career: ["Career future", "I can see a future for my career here."],
};
const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
const num = (v: number | null, d = 2) => (v === null ? "n/a" : v.toFixed(d));

function PersonaChip() {
  return <Chip title="Written by a synthetic persona built from cohort-level facts, not by a person">Synthetic persona</Chip>;
}

function ThemeBars({ shares }: { shares: Analysis["themes"]["shares"] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  // narrow cards put each label above its bar, so long theme names are never clipped
  const stacked = width < 460;
  const labelW = stacked ? 0 : Math.min(210, Math.max(130, width * 0.38));
  const rowH = stacked ? 40 : 28;
  const barY = stacked ? 18 : 7;
  const barH = stacked ? 14 : rowH - 14;
  const max = Math.max(0.05, ...shares.map((s) => s.max ?? 0));
  const iw = Math.max(80, width - labelW - 48);
  const x = (v: number) => (v / max) * iw;
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={shares.length * rowH + 22} role="img" aria-label="Theme share of coded posts with the range across replicates">
        <g transform={`translate(${labelW},4)`}>
          {shares.map((s, i) => (
            <g key={s.theme} onPointerMove={(e) => show(e, <><div className="tt-title">{THEME_LABEL[s.theme] ?? s.theme}</div><TipRow name="Mean share" value={pct(s.mean)} swatch="var(--seq-4)" /><TipRow name="Replicate range" value={`${pct(s.min)} to ${pct(s.max)}`} /></>)} onPointerLeave={hide}>
              <rect x={-labelW} y={i * rowH} width={labelW + iw + 40} height={rowH} fill="transparent" />
              <text x={stacked ? 0 : -10} y={stacked ? i * rowH + 10 : i * rowH + rowH / 2} dy="0.32em" textAnchor={stacked ? "start" : "end"} style={{ fill: "var(--ink-2)" }}>{THEME_LABEL[s.theme] ?? s.theme}</text>
              <rect x={0} y={i * rowH + barY} width={Math.max(2, x(s.mean ?? 0))} height={barH} rx={3} fill="var(--seq-4)" />
              <line x1={x(s.min ?? 0)} x2={x(s.max ?? 0)} y1={i * rowH + barY + barH / 2} y2={i * rowH + barY + barH / 2} stroke="var(--ink-2)" strokeWidth={1.5} />
              <text x={x(s.max ?? 0) + 6} y={i * rowH + barY + barH / 2} dy="0.32em" style={{ fill: "var(--ink)" }}>{pct(s.mean)}</text>
            </g>
          ))}
        </g>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

function Trajectories({ data }: { data: Analysis["trajectories"]["stance_by_round"] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const m = { top: 10, right: 16, bottom: 28, left: 34 };
  const height = 230;
  const iw = Math.max(120, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const rounds = Math.max(1, ...POOLS.map((p) => data[p]?.length ?? 0));
  const x = (r: number) => (rounds === 1 ? iw / 2 : (r / (rounds - 1)) * iw);
  const y = (v: number) => ih - ((v + 2) / 4) * ih;
  const path = (vals: (number | null)[]) => vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean).map((p, i) => `${i ? "L" : "M"}${p}`).join("");
  return (
    <div ref={ref}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Mean stance toward the proposal by round for three tenure bands, with the range across replicates">
        <g transform={`translate(${m.left},${m.top})`}>
          {[-2, -1, 0, 1, 2].map((t) => (
            <g key={t}>
              <line className={t === 0 ? "axis-line" : "grid-line"} x1={0} x2={iw} y1={y(t)} y2={y(t)} />
              <text x={-8} y={y(t)} dy="0.32em" textAnchor="end">{t > 0 ? `+${t}` : t}</text>
            </g>
          ))}
          {Array.from({ length: rounds }, (_, i) => (
            <text key={i} x={x(i)} y={ih + 18} textAnchor="middle">{i + 1}</text>
          ))}
          {POOLS.map((p) => (
            <g key={p}>
              {(data[p] ?? []).map((r, i) => (r.min !== null && r.max !== null ? <line key={i} x1={x(i)} x2={x(i)} y1={y(r.min)} y2={y(r.max)} stroke={POOL_COLOR[p]} strokeOpacity={0.35} strokeWidth={6} strokeLinecap="round" /> : null))}
              <path d={path((data[p] ?? []).map((r) => r.mean))} fill="none" stroke={POOL_COLOR[p]} strokeWidth={2} />
            </g>
          ))}
          {Array.from({ length: rounds }, (_, i) => (
            <rect key={`h${i}`} x={x(i) - 12} y={0} width={24} height={ih} fill="transparent" onPointerMove={(e) => show(e, <><div className="tt-title">Round {i + 1}</div>{POOLS.map((p) => <TipRow key={p} name={p} value={num(data[p]?.[i]?.mean ?? null)} line={POOL_COLOR[p]} />)}</>)} onPointerLeave={hide} />
          ))}
        </g>
      </svg>
      <div className="chart-legend" aria-hidden="true">
        {POOLS.map((p) => <span key={p} className="legend-key"><span className="legend-line" style={{ background: POOL_COLOR[p] }} /> {p}</span>)}
        <span className="legend-key">bars: range across replicates; round on the horizontal axis</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function Network({ net }: { net: Analysis["network"] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const size = Math.min(width, 420);
  const pad = 18;
  const at = (v: number) => pad + v * (size - 2 * pad);
  const byId = Object.fromEntries(net.nodes.map((n) => [n.id, n]));
  const maxPr = Math.max(...net.nodes.map((n) => n.pagerank));
  const cohorts = [...new Set(net.nodes.map((n) => n.cohort))];
  return (
    <div ref={ref}>
      <svg className="chart" width={size} height={size} role="img" aria-label={`${net.label}: ${net.nodes.length} nodes and ${net.edges.length} links, colored by cohort`}>
        {net.edges.map((e, i) => {
          const a = byId[e.source]!;
          const b = byId[e.target]!;
          return <line key={i} x1={at(a.x)} y1={at(a.y)} x2={at(b.x)} y2={at(b.y)} stroke="var(--axis)" strokeOpacity={0.5} strokeWidth={Math.min(3, e.weight)} />;
        })}
        {net.nodes.map((n) => (
          <circle key={n.id} cx={at(n.x)} cy={at(n.y)} r={5 + 9 * Math.sqrt(n.pagerank / maxPr)} fill={POOL_COLOR[n.cohort] ?? "var(--series-other)"} stroke="var(--surface)" strokeWidth={2} onPointerMove={(e) => show(e, <><div className="tt-title">{n.cohort}</div><TipRow name="PageRank" value={n.pagerank.toFixed(3)} swatch={POOL_COLOR[n.cohort]} /></>)} onPointerLeave={hide} />
        ))}
      </svg>
      <div className="chart-legend" aria-hidden="true">
        {cohorts.map((c) => <span key={c} className="legend-key"><svg width="12" height="12"><circle cx="6" cy="6" r="5" fill={POOL_COLOR[c] ?? "var(--series-other)"} /></svg>{c}</span>)}
        <span className="legend-key">size: PageRank</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

function SanityPanel({ s, placeholder }: { s: Sanity; placeholder: boolean }) {
  const pa = s.persona_agreement;
  return (
    <section className="card span-12" data-testid="lab-sanity">
      <div className="card-head"><div><h2 className="card-title">Do persona concerns line up with the model's cohort rates, beyond what the cards already say?</h2><div className="card-sub">{s.label}. Spearman correlations over cohort cells; the interval is as prominent as the estimate.{placeholder ? " Placeholder session: these correlations come from scripted stub answers and mean nothing." : ""}</div></div></div>
      <div className="stat-row">
        <div className="stat"><div className="stat-label">Persona agreement</div><div className="stat-value">{num(pa.spearman)}</div><div className="stat-note">95% interval {pa.ci95 ? `${num(pa.ci95[0])} to ${num(pa.ci95[1])}` : "n/a"} · {pa.n_cells} cells · {pa.bootstrap.toLocaleString("en-US")} resamples</div></div>
        <div className="stat"><div className="stat-label">Facts-only baseline</div><div className="stat-value">{num(s.facts_only_baseline.spearman)}</div><div className="stat-note">the card facts alone, {s.facts_only_baseline.n_cells} cells</div></div>
        <div className="stat"><div className="stat-label">Facts removed (control)</div><div className="stat-value">{num(s.negative_controls.facts_removed?.spearman ?? null)}</div><div className="stat-note">what the tenure and level labels alone give; {s.negative_controls.facts_removed?.n_cells ?? 0} groups</div></div>
        <div className="stat"><div className="stat-label">Facts shuffled (control)</div><div className="stat-value">{num(s.negative_controls.facts_shuffled?.spearman ?? null)}</div><div className="stat-note">if concern follows shuffled facts, agreement is prompt-driven; {s.negative_controls.facts_shuffled?.n_cells ?? 0} groups</div></div>
      </div>
      <p className="card-sub" style={{ marginTop: 12 }}>{s.construct_note}</p>
      <details style={{ marginTop: 8 }}><summary className="card-sub">Known limits of LLM personas</summary><ul className="card-sub">{s.limits.map((l) => <li key={l}>{l}</li>)}</ul></details>
    </section>
  );
}

function Session({ id }: { id: string }) {
  const q = useQuery<LabDoc | Refusal>(`/api/lab/${encodeURIComponent(id)}`);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton height={320} />;
  if (isRefusal(q.data)) return <RefusalNote code={q.data.code} message={q.data.message} />;
  const doc = q.data;
  const a = doc.analysis as unknown as Analysis;
  const s = doc.sanity as unknown as Sanity;
  const items = Object.entries(a.items.items);
  return (
    <>
      {doc.placeholder ? (
        <div className="banner warning" role="status" data-testid="lab-placeholder" style={{ margin: "0 0 16px" }}>
          <IconAlert size={16} />
          <span>Placeholder session: the scripted stub provider wrote these posts ("[stub]"), not a model, to exercise recording, replay and analysis. Nothing here reflects anyone. The Qwen3.6-27B sessions are recorded on the operator's machine.</span>
        </div>
      ) : null}
      <div className="grid">
        <ChartCard id="lab-themes" className="span-7" title="What did the personas talk about?" subtitle={`Share of coded posts by theme, mean across ${doc.replicates.filter((r) => r.card_variant === "main").length} replicates with their range; coded by a separate call that never saw the persona prompts`} height={300} table={<table className="table"><thead><tr><th>Theme</th><th className="num">Mean</th><th className="num">Range</th></tr></thead><tbody>{a.themes.shares.map((t) => <tr key={t.theme}><td>{THEME_LABEL[t.theme] ?? t.theme}</td><td className="num">{pct(t.mean)}</td><td className="num">{pct(t.min)} to {pct(t.max)}</td></tr>)}</tbody></table>}>
          <ThemeBars shares={a.themes.shares} />
        </ChartCard>
        <ChartCard id="lab-network" className="span-5" title="Who replied to and reacted to whom?" subtitle={`${a.network.label}. One replicate; nodes are cohorts, never people`} height={300} table={<table className="table"><thead><tr><th>Node</th><th>Cohort</th><th className="num">PageRank</th></tr></thead><tbody>{a.network.nodes.map((n) => <tr key={n.id}><td>{n.id}</td><td>{n.cohort}</td><td className="num">{n.pagerank.toFixed(3)}</td></tr>)}</tbody></table>}>
          <Network net={a.network} />
        </ChartCard>
        <ChartCard id="lab-trajectories" className="span-6" title="How did stance toward the proposal move over the rounds?" subtitle={`Mean stance per round by tenure band (${a.trajectories.scale}); the program office posted an FAQ in round 3 and opened an AMA in round 5`} height={260} table={<table className="table"><thead><tr><th>Round</th>{POOLS.map((p) => <th key={p} className="num">{p}</th>)}</tr></thead><tbody>{(a.trajectories.stance_by_round[POOLS[0]] ?? []).map((_, i) => <tr key={i}><td>{i + 1}</td>{POOLS.map((p) => <td key={p} className="num">{num(a.trajectories.stance_by_round[p]?.[i]?.mean ?? null)}</td>)}</tr>)}</tbody></table>}>
          <Trajectories data={a.trajectories.stance_by_round} />
        </ChartCard>
        <section className="card span-6" data-testid="lab-items">
          <div className="card-head"><div><h2 className="card-title">Did the personas' attitude items shift?</h2><div className="card-sub">{a.items.note}; 1 to 5, mean across replicates. Acquiescence index {num(a.items.acquiescence_index.mean)} (0 means none)</div></div></div>
          <div className="table-wrap"><table className="table"><thead><tr><th>Item</th><th className="num">Before → after</th><th className="num">Shift</th></tr></thead><tbody>{items.map(([k, v]) => <tr key={k} title={ITEM_LABEL[k]?.[1]}><td>{ITEM_LABEL[k]?.[0] ?? k}</td><td className="num">{num(v.pre.mean)} → {num(v.post.mean)}</td><td className="num">{fmtVal(v.shift.mean ?? 0, 0.01)}</td></tr>)}</tbody></table></div>
        </section>
        <SanityPanel s={s} placeholder={doc.placeholder} />
        <section className="card span-12" data-testid="lab-pilot">
          <div className="card-head"><div><h2 className="card-title">Which questions would a real pilot need to ask?</h2><div className="card-sub">Draft pilot items from the most frequent themes, with the linter's findings. Each needs cognitive pretesting and a properly sampled, consented pilot.</div></div></div>
          <div className="lab-items">
            {a.pilot_items.map((it) => (
              <article key={it.construct_label} className="lab-item">
                <div className="label-sm">{it.construct_label}</div>
                <p className="lab-wording">"{it.wording}"</p>
                <div className="card-sub">{it.scale.join(" · ")}</div>
                {it.recommendation ? <p className="card-sub"><strong>{it.recommendation}</strong></p> : null}
                <p className="card-sub">{it.rationale}. Lint: {it.lint.length ? it.lint.join("; ") : "no findings"}.</p>
                {it.quotes.map((q, i) => <blockquote key={i} className="lab-quote"><PersonaChip /> <span>{q.text}</span> <span className="card-sub">({q.cohort})</span></blockquote>)}
                <div className="card-sub"><em>{it.label}</em></div>
              </article>
            ))}
          </div>
        </section>
        <section className="card span-12" data-testid="lab-personas">
          <div className="card-head"><div><h2 className="card-title">Who are the personas?</h2><div className="card-sub">Templates over cohort cells of at least 10 people: a handle, the cell's facts, the status quo and the proposal. Never an individual, a predicted risk or a protected attribute.</div></div></div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{doc.personas.map((p) => <Chip key={p.persona_id} title="Synthetic persona">{p.handle}</Chip>)}</div>
          <p className="card-sub" style={{ marginTop: 8 }}>Session {doc.session}: {doc.replicates.length} replicates, provider {doc.provider}; each replays to its database hash with no model.</p>
        </section>
        <InterviewCard proposal={doc.proposal} personas={doc.personas} />
      </div>
    </>
  );
}

const SOURCE_NOTE: Record<string, string> = {
  live: "Live answer from the local 27B, at most 100 tokens",
  stub: "Scripted stub text from the engine, not a model",
  recorded: "Recorded answer",
  placeholder: "Placeholder: scripted stub text, not a model",
};

/** SPEC 15.8: one question to one synthetic persona; the answer streams in, with its source and the Lab label. */
function InterviewCard({ proposal, personas }: { proposal: string; personas: { persona_id: string; handle: string }[] }) {
  const [persona, setPersona] = useState(personas[0]?.persona_id ?? "P01");
  const [q, setQ] = useState("What would you want to know before this change starts?");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ text: string; source: string; model: string | null; handle: string } | null>(null);
  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!q.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setAnswer(null);
    const handle = personas.find((p) => p.persona_id === persona)?.handle ?? persona;
    try {
      const r = await fetch("/api/lab/interview", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ proposal, persona_id: persona, question: q }) });
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("application/json")) {
        const j = (await r.json().catch(() => null)) as { message?: string; error?: string } | null;
        setErr(j?.message ?? j?.error ?? `The interview failed (${r.status}).`);
        return;
      }
      const meta = { source: r.headers.get("x-staysignal-source") ?? "placeholder", model: r.headers.get("x-staysignal-model"), handle };
      let text = "";
      const reader = r.body?.getReader();
      if (!reader) text = await r.text();
      else {
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += dec.decode(value, { stream: true });
          setAnswer({ ...meta, text });
        }
      }
      setAnswer({ ...meta, text: text.trim() });
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card span-12" data-testid="lab-interview">
      <div className="card-head"><div><h2 className="card-title">Ask one persona a question</h2><div className="card-sub">{LAB_SUB} Live only on the local machine with the 27B; otherwise a recorded answer or a labeled placeholder.</div></div></div>
      <form className="memory-form" style={{ flexWrap: "wrap" }} onSubmit={(e) => void ask(e)}>
        <select className="select" style={{ maxWidth: "100%" }} value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Persona">
          {personas.map((p) => <option key={p.persona_id} value={p.persona_id}>{p.handle}</option>)}
        </select>
        <label className="visually-hidden" htmlFor="lab-q">Question to the persona</label>
        <input id="lab-q" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn btn-primary" disabled={busy || !q.trim()} data-testid="lab-ask">{busy ? "Asking" : "Ask"}</button>
      </form>
      {err ? <p className="card-sub" role="alert">{err}</p> : null}
      {answer ? (
        <blockquote className="lab-quote" data-testid="lab-answer"><PersonaChip /> <span className="card-sub">{answer.handle}:</span> <span>{answer.text}</span>
          <div className="card-sub"><em>{SOURCE_NOTE[answer.source] ?? answer.source}{answer.model ? ` (${answer.model})` : ""}. {LAB_SUB}</em></div>
        </blockquote>
      ) : null}
    </section>
  );
}

export function LabPage(_: { me: Me }) {
  const idx = useQuery<LabIndex | Refusal>("/api/lab");
  const [pick, setPick] = useState<string | null>(null);
  const head = <PageHead title="Scenario Lab" sub="Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated. Personas built from cohort-level facts react to a proposed change on a simulated forum; nothing here feeds a forecast or a review." />;
  if (idx.error) return <>{head}<ErrorState error={idx.error} /></>;
  if (!idx.data) return <>{head}<Skeleton height={200} /></>;
  if (isRefusal(idx.data)) return <>{head}<RefusalNote code={idx.data.code} message={idx.data.message} /></>;
  const proposals = idx.data.proposals;
  if (!proposals.length) return <>{head}<EmptyState>No Lab session has been recorded.</EmptyState></>;
  const id = pick ?? proposals.find((p) => p.id === "promotion-criteria-third-window")?.id ?? proposals[0]!.id;
  return (
    <>
      {head}
      <div style={{ margin: "0 0 16px" }}>
        <Segmented label="Proposal" value={id} onChange={setPick} options={proposals.map((p) => ({ value: p.id, label: p.id === "promotion-criteria-third-window" ? "Promotion criteria and a June window" : p.id === "infra-data-merge" ? "One group for Infrastructure and Data" : p.id }))} />
      </div>
      <Session key={id} id={id} />
    </>
  );
}
