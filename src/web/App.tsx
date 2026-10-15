// The app: authenticate (dev role switcher locally, Access in production), connect to the WorkspaceAgent, route pages.
import { useEffect, useState } from "react";
import { ApiError, getJSON, type Me } from "./api";
import { AppShell } from "./components/AppShell";
import { DemoLanding, DemoMisconfigured, SandboxSpent } from "./components/DemoLanding";
import { type DemoSessionInfo, demoSessionInfo, homeCohort, setRecordedPlace } from "./demo";
import { setDefaultCohort } from "./router";
import { RoleSwitcher } from "./components/RoleSwitcher";
import { SyntheticChip } from "./components/ui";
import { WorkspaceProvider } from "./live";
import { AskPage } from "./pages/Ask";
import { ChangesPage } from "./pages/Changes";
import { ForecastPage } from "./pages/Forecast";
import { GovernancePage } from "./pages/Governance";
import { LabPage } from "./pages/Lab";
import { ResearchPage } from "./pages/Research";
import { MemoryPage } from "./pages/Memory";
import { QualityPage } from "./pages/Quality";
import { ResultPage } from "./pages/ResultDetail";
import { ReviewsPage } from "./pages/Reviews";
import { TracesPage } from "./pages/Traces";
import { TrustPage } from "./pages/Trust";
import { WorkforcePage } from "./pages/Workforce";
import { parseRoute, useLocation } from "./router";

interface MeState {
  me: Me | null;
  ready: boolean;
  /** The public demo: the sandbox has used its units; the server's message, shown with a way to start afresh. */
  spent: string | null;
}

function useMe(): MeState {
  const [state, setState] = useState<MeState>({ me: null, ready: false, spent: null });
  useEffect(() => {
    let timer: number | null = null;
    // a rate-limited public demo (429) keeps the visitor signed in and asks again after Retry-After; a spent sandbox
    // stops asking (every request would cost the account one) and offers a fresh sandbox; only a refusal signs out
    const load = (): Promise<void> => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      return getJSON<Me>("/api/me").then(
        (me) => setState({ me, ready: true, spent: null }),
        (e: unknown) => {
          if (e instanceof ApiError && e.status === 429) {
            if (e.code === "SANDBOX_SPENT") return setState({ me: null, ready: true, spent: e.message });
            timer = window.setTimeout(() => void load(), Math.max(5, e.retryAfterSeconds ?? 5) * 1000);
            return;
          }
          setState({ me: null, ready: true, spent: null });
        },
      );
    };
    const spent = (e: Event) => setState((s) => ({ ...s, ready: true, spent: (e as CustomEvent<string>).detail || "This sandbox has used its request allowance." }));
    void load();
    window.addEventListener("ss-principal", load);
    window.addEventListener("ss-sandbox-spent", spent);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("ss-principal", load);
      window.removeEventListener("ss-sandbox-spent", spent);
    };
  }, []);
  return state;
}

/** Signed out: the public demo's landing (ADR 0018) when this deployment is the public demo, else the local sign-in. */
function useDemoInfo(probe: boolean): DemoSessionInfo | "misconfigured" | null | undefined {
  const [info, setInfo] = useState<DemoSessionInfo | "misconfigured" | null | undefined>(undefined);
  useEffect(() => {
    if (probe) void demoSessionInfo().then(setInfo);
  }, [probe]);
  return info;
}

export function App() {
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  const { me, ready, spent } = useMe();
  const demoInfo = useDemoInfo(ready && !me && !spent);
  setRecordedPlace(me?.public_demo?.recorded_on);
  // the public demo: a page opened without a cohort shows one the visitor's role may see
  setDefaultCohort(me?.public_demo ? homeCohort(me.principal) : null);
  if (spent) return <SandboxSpent message={spent} />;
  if (!ready) return null;
  if (!me) {
    if (demoInfo === undefined) return null;
    if (demoInfo === "misconfigured") return <DemoMisconfigured />;
    if (demoInfo) return <DemoLanding info={demoInfo} />;
    return (
      <main className="content" style={{ margin: "10vh auto", maxWidth: 520 }}>
        <section className="card">
          <h1>StaySignal</h1>
          <p style={{ margin: "8px 0 16px", color: "var(--ink-2)" }}>Cohort-level departure forecasting for Larkspur Systems, a synthetic company. Choose a role to sign in locally; in production, Cloudflare Access signs you in.</p>
          <RoleSwitcher me={null} />
          <div style={{ marginTop: 16 }}>
            <SyntheticChip />
          </div>
        </section>
      </main>
    );
  }
  return (
    <WorkspaceProvider key={me.principal.id} coalesceMs={me.public_demo ? 400 : 0}>
      <AppShell route={route} me={me} key={me.principal.id}>
        {route.page === "forecast" ? <ForecastPage me={me} /> : null}
        {route.page === "changes" ? <ChangesPage me={me} /> : null}
        {route.page === "quality" ? <QualityPage me={me} /> : null}
        {route.page === "reviews" ? <ReviewsPage me={me} /> : null}
        {route.page === "trust" ? <TrustPage me={me} /> : null}
        {route.page === "workforce" ? <WorkforcePage me={me} /> : null}
        {route.page === "lab" ? <LabPage me={me} /> : null}
        {route.page === "memory" ? <MemoryPage me={me} /> : null}
        {route.page === "traces" ? <TracesPage me={me} /> : null}
        {route.page === "governance" ? <GovernancePage me={me} /> : null}
        {route.page === "research" ? <ResearchPage me={me} /> : null}
        {route.page === "ask" ? <AskPage me={me} /> : null}
        {route.page === "result" ? <ResultPage id={route.id} /> : null}
        {route.page === "not_found" ? <p>Page not found.</p> : null}
      </AppShell>
    </WorkspaceProvider>
  );
}
