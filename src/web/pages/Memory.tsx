// Memory page (SPEC 16.1, 14.10): what StaySignal decided and noted before, and when. The agent's git-backed Markdown
// memory: search ("what did we decide last time?"), the notes by kind with the timeline's daily, weekly and monthly
// tiers, one note's dated bullets, and the commit log. Commit IDs are memory-repository commits. Synthetic records.
import { type FormEvent, useState } from "react";
import type { MemoryCommit, MemoryFileDoc, MemoryFileInfo, MemorySearchData } from "../../shared/contracts";
import { isRefusal, type Me, type Refusal, useQuery } from "../api";
import { ErrorState, RefusalNote, Skeleton, SyntheticChip } from "../components/ui";
import { PageHead } from "./Forecast";

interface Envelope<T> {
  result_id: string;
  data: T;
}

const GROUPS: { prefix: string; label: string }[] = [
  { prefix: "decisions/", label: "Decisions" },
  { prefix: "investigations/", label: "Investigations" },
  { prefix: "teams/", label: "Groups" },
  { prefix: "timeline/monthly/", label: "Timeline, monthly" },
  { prefix: "timeline/weekly/", label: "Timeline, weekly" },
  { prefix: "timeline/daily/", label: "Timeline, daily" },
  { prefix: "anchors/", label: "Audit anchors" },
];

function day(iso: string): string {
  return iso.slice(0, 10);
}

function NoteView({ path }: { path: string }) {
  const q = useQuery<(MemoryFileDoc & { label: string }) | Refusal>(`/api/memory/file?path=${encodeURIComponent(path)}`);
  if (q.error) return <ErrorState error={q.error} />;
  if (!q.data) return <Skeleton height={120} />;
  if (isRefusal(q.data)) return <RefusalNote code={q.data.code} message={q.data.message} />;
  const d = q.data;
  return (
    <section className="card" data-testid="memory-note">
      <div className="card-head">
        <div>
          <h2 className="card-title">{d.title}</h2>
          <div className="card-sub">
            <span className="mono">{d.path}</span> · last commit <span className="mono">{d.commit}</span> on {day(d.date)}
          </div>
        </div>
        <SyntheticChip label="Synthetic record" />
      </div>
      <ul className="memory-bullets">
        {d.bullets.map((b) => (
          <li key={`${b.date}-${b.text}`}>
            <span className="mono memory-date">{b.date}</span> {b.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MemoryPage(_: { me: Me }) {
  const [input, setInput] = useState("What did we decide last time about fixed-term employees?");
  const [query, setQuery] = useState(input);
  const [open, setOpen] = useState<string>("decisions/DEC-2026-09-20-01.md");
  const files = useQuery<{ files: MemoryFileInfo[] } | Refusal>("/api/memory/files");
  const log = useQuery<{ commits: MemoryCommit[] } | Refusal>("/api/memory/log");
  const search = useQuery<Envelope<MemorySearchData> | Refusal>(query ? `/api/memory/search?q=${encodeURIComponent(query)}` : null);
  const head = <PageHead title="Memory" sub="What StaySignal decided and noted before, and when: Markdown notes the agent commits to a git repository, coarsened from daily to weekly to monthly. Records of a synthetic company." />;
  if (files.data && isRefusal(files.data)) {
    return (
      <>
        {head}
        <RefusalNote code={files.data.code} message={files.data.message} />
      </>
    );
  }
  const list = files.data && !isRefusal(files.data) ? files.data.files : null;
  const commits = log.data && !isRefusal(log.data) ? log.data.commits : null;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setQuery(input.trim());
  };
  return (
    <>
      {head}
      <section className="card" data-testid="memory-search">
        <form className="memory-form" onSubmit={onSubmit} role="search">
          <label className="visually-hidden" htmlFor="memory-q">
            Search memory
          </label>
          <input id="memory-q" value={input} onChange={(e) => setInput(e.target.value)} placeholder="What did we decide last time about..." />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>
        {search.error ? <ErrorState error={search.error} /> : null}
        {search.data && isRefusal(search.data) ? <RefusalNote code={search.data.code} message={search.data.message} /> : null}
        {search.data && !isRefusal(search.data) ? (
          search.data.data.hits.length ? (
            <ol className="memory-hits">
              {search.data.data.hits.map((h) => (
                <li key={h.path}>
                  <button type="button" className="link-btn mono" onClick={() => setOpen(h.path)}>
                    {h.path}
                  </button>
                  <div>{h.snippet.replace(/^(- |# )/, "")}</div>
                  <div className="card-sub">
                    last commit <span className="mono">{h.commit}</span> on {day(h.date)}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="card-sub">Nothing in memory matches.</p>
          )
        ) : null}
      </section>
      <div className="memory-grid">
        <section className="card" data-testid="memory-files">
          <div className="card-head">
            <h2 className="card-title">Notes</h2>
          </div>
          {!list ? (
            <Skeleton height={200} />
          ) : (
            GROUPS.map((g) => {
              const items = list.filter((f) => f.path.startsWith(g.prefix));
              if (!items.length) return null;
              return (
                <div key={g.prefix} className="memory-group">
                  <h3>{g.label}</h3>
                  <ul>
                    {items.map((f) => (
                      <li key={f.path}>
                        <button type="button" className="link-btn" aria-pressed={open === f.path} onClick={() => setOpen(f.path)}>
                          {f.title}
                        </button>
                        <span className="card-sub"> {day(f.date)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>
        <div>
          <NoteView path={open} />
          <section className="card" data-testid="memory-log" style={{ marginTop: 16 }}>
            <div className="card-head">
              <h2 className="card-title">Commits</h2>
              <div className="card-sub">Authored by the StaySignal agent, dated by the synthetic clock</div>
            </div>
            {!commits ? (
              <Skeleton height={80} />
            ) : (
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Commit</th>
                    <th>Date</th>
                    <th>Message</th>
                    <th className="num">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {commits.map((c) => (
                    <tr key={c.commit}>
                      <td className="mono">{c.commit}</td>
                      <td>{day(c.date)}</td>
                      <td style={{ whiteSpace: "normal" }}>{c.message}</td>
                      <td className="num">{c.files.length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
