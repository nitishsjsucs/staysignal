// The public demo's persistent banner (ADR 0018): what this is and when the visitor's sandbox resets, the guided tour,
// the reset action and a link to the source. The tour lists the demo beats in order with one line each; a beat opens
// its page and, when it is best seen in another role, switches to that role inside the same sandbox, then the panel
// closes so the page and the chat are visible (a beat that suggests a question opens the chat). The panel is rendered
// into the document body, so no sticky header's stacking context can put the phone's tab bar above it.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Me } from "../api";
import { markBeatDone, markTourSeen, remaining, resetDemo, retryIn, SOURCE_URL, switchDemoRole, TOUR, type TourBeat, tourDone, tourSeen } from "../demo";
import { navigate } from "../router";
import { IconClose } from "./icons";

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(t);
  }, [everyMs]);
  return now;
}

export function DemoBanner({ me }: { me: Me }) {
  const demo = me.public_demo!;
  const now = useNow(30_000);
  const [tour, setTour] = useState(() => !tourSeen());
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ended = demo.expires_at !== null && demo.expires_at * 1000 <= now;
  useEffect(() => {
    // the sandbox has ended: go back to the start page
    if (ended) window.dispatchEvent(new Event("ss-principal"));
  }, [ended]);
  const reset = async () => {
    if (!window.confirm("Reset your sandbox? Everything you did in it is deleted and the demo starts again from the beginning.")) return;
    setResetting(true);
    const out = await resetDemo();
    setResetting(false);
    if (!out.ok) setNote(out.status === 429 || out.status === 503 ? `The demo is busy, try again later${retryIn(out.retryAfterSeconds)}.` : out.message);
    else {
      setNote(null);
      navigate("/?cohort=org%3AEngineering&h=3");
    }
  };
  return (
    <>
      <div className="demo-banner" role="region" aria-label="Public demo" data-testid="demo-banner">
        <span className="demo-banner-text">
          Public demo: synthetic company, recorded model and engine output, your sandbox resets in <strong data-testid="demo-remaining">{demo.expires_at ? remaining(demo.expires_at, now) : "4 h"}</strong>
        </span>
        <span className="demo-banner-actions">
          <button
            type="button"
            className="btn btn-sm"
            aria-expanded={tour}
            data-testid="tour-toggle"
            onClick={() => {
              markTourSeen();
              setTour((t) => !t);
            }}
          >
            Guided tour
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void reset()} disabled={resetting} data-testid="demo-reset">
            {resetting ? "Resetting..." : "Reset my sandbox"}
          </button>
          <a className="btn btn-sm" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" data-testid="demo-source-link">
            Source
          </a>
        </span>
        {note ? (
          <span className="demo-banner-note" role="alert">
            {note}
          </span>
        ) : null}
      </div>
      {tour
        ? createPortal(
            <TourPanel
              me={me}
              onClose={() => {
                markTourSeen();
                setTour(false);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function TourPanel({ me, onClose }: { me: Me; onClose: () => void }) {
  const [done, setDone] = useState<string[]>(() => tourDone());
  const principals = me.public_demo?.principals ?? [];
  const display = (id: string) => principals.find((p) => p.id === id)?.display ?? id;
  const go = async (beat: TourBeat, as: string) => {
    markBeatDone(beat.id);
    setDone(tourDone());
    // the panel covers the right of the page, where the chat sits on a wide screen: close it so the beat is visible
    onClose();
    if (as !== me.principal.id) await switchDemoRole(as, principals);
    navigate(beat.href);
    // a beat that suggests a question opens the chat, where its recorded question waits as a chip
    if (beat.ask) window.dispatchEvent(new Event("ss-open-dock"));
  };
  return (
    <aside className="tour-panel" aria-label="Guided tour" data-testid="tour-panel">
      <div className="tour-head">
        <div>
          <div style={{ fontWeight: 600 }}>Guided tour</div>
          <div className="tour-sub">Eleven beats, in the order the demo tells them. Each opens its page, in the role it is best seen as; reopen the tour from the banner for the next one.</div>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close the guided tour">
          <IconClose size={14} />
        </button>
      </div>
      <ol className="tour-list">
        {TOUR.map((beat, i) => (
          <li key={beat.id} className="tour-beat" data-testid={`tour-${beat.id}`} data-done={done.includes(beat.id) ? "1" : undefined}>
            <div className="tour-beat-title">
              <span className="tour-num">{i + 1}</span>
              {beat.title}
            </div>
            <p className="tour-line">{beat.line}</p>
            {beat.ask ? <p className="tour-ask">Ask: &ldquo;{beat.ask}&rdquo;</p> : null}
            <div className="tour-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => void go(beat, beat.as)}>
                Open as {display(beat.as)}
              </button>
              {beat.then ? (
                <button type="button" className="btn btn-sm" onClick={() => void go(beat, beat.then!.as)} title={`Switch roles to ${beat.then.why}`}>
                  Then as {display(beat.then.as)}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
