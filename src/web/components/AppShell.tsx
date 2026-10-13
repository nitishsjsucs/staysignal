// App shell (SPEC 16.3): left navigation, top bar with the cohort picker, horizon selector, data cutoff chip, theme
// toggle and (locally) the role switcher, the chat dock, and a bottom navigation on mobile.
import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { type Me, useQuery } from "../api";
import { useWorkspace } from "../live";
import { navigate, type Route, setView, useView } from "../router";
import { applyTheme, effectiveDark, readTheme, type Theme } from "../theme";
import { BrandMark, IconAsk, IconChanges, IconFlask, IconFlows, IconForecast, IconGovernance, IconMemory, IconMoon, IconQuality, IconReviews, IconSun, IconTraces, IconTrust } from "./icons";
import { RoleSwitcher } from "./RoleSwitcher";
import { Segmented, SyntheticChip } from "./ui";

const ChatDock = lazy(() => import("./ChatDock"));

const NAV: { page: Route["page"]; href: string; label: string; icon: (p: { size?: number }) => ReactNode }[] = [
  { page: "forecast", href: "/", label: "Forecast", icon: IconForecast },
  { page: "trust", href: "/trust", label: "Trust", icon: IconTrust },
  { page: "changes", href: "/changes", label: "What changed", icon: IconChanges },
  { page: "quality", href: "/quality", label: "Data health", icon: IconQuality },
  { page: "reviews", href: "/reviews", label: "Reviews", icon: IconReviews },
  { page: "workforce", href: "/workforce", label: "Workforce", icon: IconFlows },
  { page: "memory", href: "/memory", label: "Memory", icon: IconMemory },
  { page: "traces", href: "/traces", label: "Traces", icon: IconTraces },
  { page: "governance", href: "/governance", label: "Governance", icon: IconGovernance },
  { page: "research", href: "/research", label: "Research", icon: IconFlask },
  { page: "ask", href: "/ask", label: "Ask", icon: IconAsk },
];

interface CohortList {
  run_id: string;
  cohorts: { id: string; name: string; kind: string; n: number; parent: string | null }[];
}

function CohortPicker() {
  const view = useView();
  const { data } = useQuery<CohortList>("/api/cohorts");
  const list = data?.cohorts ?? [];
  const order = ["company", "organization", "group", "team"];
  const groups = order.map((k) => ({ kind: k, items: list.filter((c) => c.kind === k) })).filter((g) => g.items.length);
  const label: Record<string, string> = { company: "Company", organization: "Organizations", group: "Groups", team: "Teams (analysts only; not an evaluation of a manager)" };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span className="visually-hidden">Cohort</span>
      <select className="select" value={list.some((c) => c.id === view.cohort) ? view.cohort : ""} onChange={(e) => setView({ cohort: e.target.value })} aria-label="Cohort" style={{ maxWidth: 260 }}>
        {list.some((c) => c.id === view.cohort) ? null : <option value="">Choose a cohort</option>}
        {groups.map((g) => (
          <optgroup key={g.kind} label={label[g.kind]}>
            {g.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === "team" ? `Team ${c.name}` : c.name} ({c.n})
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

export function AppShell({ route, me, children }: { route: Route; me: Me; children: ReactNode }) {
  const view = useView();
  const live = useWorkspace();
  const [theme, setTheme] = useState<Theme>(readTheme());
  const [dock, setDock] = useState<boolean>(() => window.matchMedia("(min-width: 1100px)").matches && route.page !== "ask");
  useEffect(() => applyTheme(theme), [theme]);
  const dark = effectiveDark(theme);
  const showDock = dock && route.page !== "ask";
  const link = (href: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(href + window.location.search);
  };
  return (
    <div className={`shell${showDock ? " dock-open" : ""}`}>
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <div className="brand-mark">
            <BrandMark />
          </div>
          <div>
            <div className="brand-name">StaySignal</div>
            <div className="brand-sub">Larkspur Systems (synthetic)</div>
          </div>
        </div>
        {NAV.map((n) => (
          <a key={n.page} className="nav-link" href={n.href} aria-current={route.page === n.page ? "page" : undefined} onClick={link(n.href)}>
            {n.icon({ size: 16 })}
            {n.label}
          </a>
        ))}
        <div className="nav-foot">
          Cohort-level planning support. No individual scores anywhere a person can see.
          <br />
          {live?.auditHead ? `Audit log head #${live.auditHead.seq}` : null}
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <CohortPicker />
          <Segmented label="Horizon" value={view.horizon} onChange={(h) => setView({ horizon: h })} options={[{ value: 1, label: "1 month" }, { value: 3, label: "3 months" }, { value: 6, label: "6 months" }]} />
          <span className="spacer" />
          <span className="hide-mobile">
            <SyntheticChip />
          </span>
          {live?.published ? <span className="chip hide-mobile" title="Published run and its data cutoff">Run {live.published.runId} · cutoff {live.published.cutoff}</span> : null}
          <RoleSwitcher me={me} />
          <button type="button" className="btn btn-sm" onClick={() => setTheme(dark ? "light" : "dark")} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
            {dark ? <IconSun size={14} /> : <IconMoon size={14} />}
          </button>
          {route.page !== "ask" ? (
            <button type="button" className="btn btn-sm btn-primary hide-mobile" onClick={() => setDock((d) => !d)} aria-expanded={showDock}>
              <IconAsk size={14} /> {showDock ? "Hide chat" : "Ask"}
            </button>
          ) : null}
        </header>
        <main className="content">{children}</main>
      </div>
      {showDock ? (
        <Suspense fallback={<aside className="dock" />}>
          <ChatDock me={me} onClose={() => setDock(false)} />
        </Suspense>
      ) : null}
      {route.page !== "ask" && !showDock ? (
        <button type="button" className="btn btn-primary dock-fab" onClick={() => setDock(true)}>
          <IconAsk size={14} /> Ask
        </button>
      ) : null}
      <nav className="mobile-nav" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.page} href={n.href} aria-current={route.page === n.page ? "page" : undefined} onClick={link(n.href)}>
            {n.icon({ size: 18 })}
            {n.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
