// The public demo's landing page (ADR 0018): what StaySignal is in two plain sentences, the role picker (People
// Analytics Lead by default) and the button that starts a private sandbox. When a cap stops a new sandbox, it says the
// demo is busy and when to try again.
import { type FormEvent, useState } from "react";
import { type DemoSessionInfo, retryIn, startDemo } from "../demo";
import { BrandMark } from "./icons";
import { SyntheticChip } from "./ui";

export function DemoLanding({ info }: { info: DemoSessionInfo }) {
  const [principal, setPrincipal] = useState(info.default_principal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hours = Math.round(info.lifetime_seconds / 3600);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const out = await startDemo(principal);
    if (!out.ok) {
      setError(out.status === 429 || out.status === 503 ? `The demo is busy, try again later${retryIn(out.retryAfterSeconds)}.` : out.message);
      setBusy(false);
    }
  };
  return (
    <main className="demo-landing">
      <section className="card demo-landing-card" data-testid="demo-landing">
        <div className="brand" style={{ padding: 0, marginBottom: 12 }}>
          <div className="brand-mark">
            <BrandMark />
          </div>
          <div>
            <div className="brand-name">StaySignal</div>
            <div className="brand-sub">Public demo</div>
          </div>
        </div>
        <h1 className="demo-landing-title">Cohort-level departure forecasting you can click through</h1>
        <p className="demo-landing-text" data-testid="demo-explainer">
          StaySignal forecasts voluntary departures for the teams and organizations of Larkspur Systems, a fictional company, so the company, its people and every number you will see are synthetic. Chat answers are replayed turns recorded from Qwen3.6-27B (other questions get a labeled deterministic stub), and you get a private sandbox that resets after {hours} hours.
        </p>
        <form onSubmit={(e) => void submit(e)} className="demo-landing-form">
          <label className="demo-landing-label" htmlFor="demo-role">
            Start as
          </label>
          <select id="demo-role" className="select" value={principal} onChange={(e) => setPrincipal(e.target.value)} aria-label="Start as (demo role)">
            {info.principals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.display}
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-primary" disabled={busy} data-testid="demo-start">
            {busy ? "Starting your sandbox..." : "Start the demo"}
          </button>
        </form>
        {error ? (
          <div className="banner warning" role="alert" style={{ marginTop: 12 }} data-testid="demo-busy">
            <div className="banner-body">{error}</div>
          </div>
        ) : null}
        <p className="demo-landing-note">You can switch roles at any time inside the same sandbox; separation of duties is enforced between roles, so one visitor can show both sides of an approval. Nothing you do is visible to anyone else.</p>
        <div style={{ marginTop: 12 }}>
          <SyntheticChip />
        </div>
      </section>
    </main>
  );
}

export function DemoMisconfigured() {
  return (
    <main className="demo-landing">
      <section className="card demo-landing-card" role="alert">
        <h1 className="demo-landing-title">This demo is not available right now</h1>
        <p className="demo-landing-text">The deployment is not configured correctly. Please try again later.</p>
      </section>
    </main>
  );
}
