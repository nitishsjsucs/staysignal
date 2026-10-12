// The app: authenticate (dev role switcher locally, Access in production), connect to the WorkspaceAgent, route pages.
import { useEffect, useState } from "react";
import { getJSON, type Me } from "./api";
import { AppShell } from "./components/AppShell";
import { RoleSwitcher } from "./components/RoleSwitcher";
import { SyntheticChip } from "./components/ui";
import { WorkspaceProvider } from "./live";
import { AskPage } from "./pages/Ask";
import { ChangesPage } from "./pages/Changes";
import { ForecastPage } from "./pages/Forecast";
import { MemoryPage } from "./pages/Memory";
import { QualityPage } from "./pages/Quality";
import { ResultPage } from "./pages/ResultDetail";
import { ReviewsPage } from "./pages/Reviews";
import { TracesPage } from "./pages/Traces";
import { TrustPage } from "./pages/Trust";
import { WorkforcePage } from "./pages/Workforce";
import { parseRoute, useLocation } from "./router";

function useMe(): { me: Me | null; ready: boolean } {
  const [state, setState] = useState<{ me: Me | null; ready: boolean }>({ me: null, ready: false });
  useEffect(() => {
    const load = () => getJSON<Me>("/api/me").then((me) => setState({ me, ready: true }), () => setState({ me: null, ready: true }));
    load();
    window.addEventListener("ss-principal", load);
    return () => window.removeEventListener("ss-principal", load);
  }, []);
  return state;
}

export function App() {
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  const { me, ready } = useMe();
  if (!ready) return null;
  if (!me) {
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
    <WorkspaceProvider key={me.principal.id}>
      <AppShell route={route} me={me} key={me.principal.id}>
        {route.page === "forecast" ? <ForecastPage me={me} /> : null}
        {route.page === "changes" ? <ChangesPage me={me} /> : null}
        {route.page === "quality" ? <QualityPage me={me} /> : null}
        {route.page === "reviews" ? <ReviewsPage me={me} /> : null}
        {route.page === "trust" ? <TrustPage me={me} /> : null}
        {route.page === "workforce" ? <WorkforcePage me={me} /> : null}
        {route.page === "memory" ? <MemoryPage me={me} /> : null}
        {route.page === "traces" ? <TracesPage me={me} /> : null}
        {route.page === "ask" ? <AskPage me={me} /> : null}
        {route.page === "result" ? <ResultPage id={route.id} /> : null}
        {route.page === "not_found" ? <p>Page not found.</p> : null}
      </AppShell>
    </WorkspaceProvider>
  );
}
