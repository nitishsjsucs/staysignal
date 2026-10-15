// The public demo in the browser (ADR 0018): the session calls, the guided tour's beats, and the wording that changes
// when the visitor is not on the laptop where the model output was recorded. Nothing here runs outside the public demo.
import { invalidate } from "./api";

export interface DemoPrincipal {
  id: string;
  role: string;
  display: string;
  assigned_orgs?: string[];
}

/** The source repository and its README walkthrough in screenshots (the repository is public). */
export const SOURCE_URL = "https://github.com/nitishsjsucs/staysignal";
export const WALKTHROUGH_URL = `${SOURCE_URL}#walkthrough-in-screenshots`;

/** The cohort a role lands on: company level for the roles that read aggregates only, the first assigned
 * organization for a People Partner, or null when every cohort is open to it (analysts and leads). */
export function homeCohort(p: { role: string; assignedOrgs?: string[]; assigned_orgs?: string[] }): string | null {
  if (p.role === "auditor" || p.role === "data_engineer") return "company";
  const orgs = p.assignedOrgs ?? p.assigned_orgs ?? [];
  if (p.role === "people_partner" && orgs[0]) return `org:${orgs[0]}`;
  return null;
}

/** Whether a role may read a cohort, as far as the browser can tell before asking: aggregates-only roles read the
 * company, People Partners their organizations (their groups are checked by the cohort picker once it loads). */
function cohortFits(p: DemoPrincipal, cohort: string): boolean {
  if (p.role === "auditor" || p.role === "data_engineer") return cohort === "company";
  if (p.role === "people_partner") return (p.assigned_orgs ?? []).some((o) => cohort === `org:${o}`);
  return true;
}

/** Before switching to a principal, points the URL at a cohort it may see, so the page does not open on a refusal. */
function fitCohort(p: DemoPrincipal | undefined): void {
  const home = p ? homeCohort(p) : null;
  if (!p || !home) return;
  const q = new URLSearchParams(window.location.search);
  if (cohortFits(p, q.get("cohort") ?? "org:Engineering")) return;
  q.set("cohort", home);
  if (!q.has("h")) q.set("h", "3");
  window.history.replaceState(null, "", `${window.location.pathname}?${q.toString()}`);
}

/** A new sandbox starts the tour afresh: the beats done in an old one are not done in this one. */
function forgetTourProgress(): void {
  try {
    window.localStorage.removeItem(DONE);
  } catch {
    // nothing remembered
  }
}

export interface DemoSessionInfo {
  public_demo: true;
  principals: DemoPrincipal[];
  default_principal: string;
  lifetime_seconds: number;
  session: { principal: string; expires_at: number } | null;
}

export type DemoAnswer = { ok: true; expires_at: number } | { ok: false; status: number; message: string; retryAfterSeconds: number | null };

/** The landing's probe: the public demo's sign-in information, or null outside the public demo. */
export async function demoSessionInfo(): Promise<DemoSessionInfo | "misconfigured" | null> {
  try {
    const r = await fetch("/demo/session", { credentials: "same-origin" });
    if (r.status === 503) return "misconfigured";
    if (!r.ok) return null;
    const body = (await r.json()) as Partial<DemoSessionInfo>;
    return body.public_demo === true ? (body as DemoSessionInfo) : null;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<DemoAnswer> {
  const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as { expires_at?: number; message?: string; retry_after_seconds?: number };
  if (r.ok && typeof out.expires_at === "number") return { ok: true, expires_at: out.expires_at };
  return { ok: false, status: r.status, message: out.message ?? `The demo could not do that (${r.status}).`, retryAfterSeconds: typeof out.retry_after_seconds === "number" ? out.retry_after_seconds : null };
}

function signedIn(): void {
  invalidate();
  window.dispatchEvent(new Event("ss-principal"));
}

/** `principals`: the roles as the server lists them, so the page can open on a cohort the chosen role may see. */
export async function startDemo(principal: string, principals: DemoPrincipal[] = []): Promise<DemoAnswer> {
  const out = await post("/demo/session", { principal });
  if (out.ok) {
    forgetTourProgress();
    fitCohort(principals.find((p) => p.id === principal));
    signedIn();
  }
  return out;
}

export async function switchDemoRole(principal: string, principals: DemoPrincipal[] = []): Promise<DemoAnswer> {
  const out = await post("/demo/role", { principal });
  if (out.ok) {
    fitCohort(principals.find((p) => p.id === principal));
    signedIn();
  }
  return out;
}

export async function resetDemo(): Promise<DemoAnswer> {
  const out = await post("/demo/reset", {});
  if (out.ok) {
    forgetTourProgress();
    signedIn();
  }
  return out;
}

/** "3 h 52 min", "12 min", "less than a minute". */
export function remaining(expiresAtSeconds: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, expiresAtSeconds - Math.floor(nowMs / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return "less than a minute";
}

/** "about 2 minutes" for a Retry-After. */
export function retryIn(seconds: number | null): string {
  if (!seconds) return "";
  if (seconds < 90) return " in about a minute";
  if (seconds < 3600) return ` in about ${Math.round(seconds / 60)} minutes`;
  return ` in about ${Math.round(seconds / 3600)} hours`;
}

let place = "this laptop";
/** Where the replayed model output was recorded, as the viewer reads it. */
export function recordedPlace(): string {
  return place;
}
export function setRecordedPlace(p: string | null | undefined): void {
  place = p || "this laptop";
}

export interface TourBeat {
  id: string;
  title: string;
  line: string;
  href: string;
  /** The principal the beat is best seen as (the visitor can switch with one click). */
  as: string;
  /** A second principal the beat needs, and what for. */
  then?: { as: string; why: string };
  /** A recorded chat question to ask on this beat. */
  ask?: string;
}

/** The demo beats in order (docs/demo-script.md), each with one line saying what to look at. */
export const TOUR: TourBeat[] = [
  { id: "forecast", title: "Forecast", line: "Expected voluntary departures for Engineering over 3 months, with 80% and 95% ranges, the trailing-rate status quo and a backtest strip. Ask the chat; its numbers link to the results that computed them.", href: "/?cohort=org%3AEngineering&h=3", as: "pa-lead@larkspur.example", ask: "Forecast voluntary departures in Engineering over the next 90 days." },
  { id: "changes", title: "What changed", line: "An exact Shapley split of the change since the previous run into calendar, composition, input data, model and metric definition, drawn against the width of the 80% range.", href: "/changes?cohort=org%3AEngineering&h=3", as: "pa-lead@larkspur.example", ask: "What changed in Engineering since the previous forecast?" },
  { id: "quality", title: "Data health", line: "Simulate the payroll arrival: a new pay-basis code fails the checks, lineage traces it into a feature, the run is held and three specialist reports are written (here templates filled from their tool results). Then approve the generated mapping fix as the Data Engineer and watch the repair publish and replay to the same hash. The workflow, its gates, the approval and the audit run live in your sandbox; the engine's job results (checks, scoring, rebuild, replay) were recorded from the engine on the author's laptop.", href: "/quality", as: "pa-lead@larkspur.example", then: { as: "data-eng@larkspur.example", why: "approve the mapping fix" } },
  { id: "reviews", title: "Reviews", line: "Prepare a People Partner review for Platform Engineering from the chat and submit it; approving your own submission is refused with SELF_APPROVAL. A second lead approves, which creates owned tasks, and rollback takes one click and a reason.", href: "/reviews", as: "pa-lead@larkspur.example", then: { as: "people-ops-director@larkspur.example", why: "approve, then roll back" }, ask: "Prepare a People Partner review for Platform Engineering." },
  { id: "trust", title: "Trust", line: "Why the forecast deserves trust: pseudo-real-time backtests, the reliability diagram, coverage against the nominal 80% and 95%, the model comparison and feature effects.", href: "/trust?cohort=company&h=3", as: "pa-lead@larkspur.example", ask: "How often did the 80% range hold in backtests at company level over 90 days (coverage)?" },
  { id: "research", title: "Research", line: "A pre-registered benchmark on 20 synthetic worlds: which data problems the intervals survive, and which hypotheses the results count against.", href: "/research", as: "pa-lead@larkspur.example" },
  { id: "lab", title: "Scenario Lab", line: "Hypothesis generation, not a forecast: synthetic personas react to a proposed change on a simulated forum, replayed from sessions recorded from Qwen3.6-27B. Ask one persona a recorded question.", href: "/lab", as: "pa-lead@larkspur.example" },
  { id: "workforce", title: "Workforce", line: "Where a cohort's people came from and went over 12 months, and a funnel plot of observed over expected departures with Poisson limits, groups of 50 or more only.", href: "/workforce?cohort=org%3AEngineering&h=3", as: "pa-lead@larkspur.example" },
  { id: "governance", title: "Governance", line: "The action audit's impact ratios against the four-fifths line, the roles and their scopes, and the disclosure rules every result passes through.", href: "/governance", as: "pa-lead@larkspur.example" },
  { id: "memory", title: "Memory", line: "Git-style Markdown memory: search what was decided last time, and read the notes your own approvals and the routine wrote in this sandbox.", href: "/memory", as: "pa-analyst@larkspur.example" },
  { id: "traces", title: "Traces", line: "Every chat answer's spans: the pre-router, tool calls, the replayed recording and the grounding check, with their timings. Leads see every trace; the auditor sees metadata only.", href: "/traces", as: "pa-lead@larkspur.example" },
];

const SEEN = "ss-demo-tour-seen";
const DONE = "ss-demo-tour-done";

/** Per-viewer conveniences only: storage can be missing or blocked, and the page works without it. */
export function tourSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
}
export function markTourSeen(): void {
  try {
    window.localStorage.setItem(SEEN, "1");
  } catch {
    // nothing to remember
  }
}
export function tourDone(): string[] {
  try {
    return JSON.parse(window.localStorage.getItem(DONE) ?? "[]") as string[];
  } catch {
    return [];
  }
}
export function markBeatDone(id: string): void {
  try {
    const done = new Set(tourDone());
    done.add(id);
    window.localStorage.setItem(DONE, JSON.stringify([...done]));
  } catch {
    // nothing to remember
  }
}
