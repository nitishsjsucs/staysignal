// A small history router (pattern copied from PeopleVault src/web/router.ts, MIT). Paths and query strings carry cohort
// ids, horizons, run ids and result ids only: never a person.
import { useSyncExternalStore } from "react";

export type Route =
  | { page: "forecast" }
  | { page: "changes" }
  | { page: "quality" }
  | { page: "reviews" }
  | { page: "ask" }
  | { page: "result"; id: string }
  | { page: "not_found" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(1);
  const [a, b] = parts;
  if (parts.length === 0 || a === "" || a === undefined) return { page: "forecast" };
  if (parts.length === 1 && (a === "changes" || a === "quality" || a === "reviews" || a === "ask")) return { page: a };
  if (a === "r" && b && /^res_[a-z2-7]{26}$/.test(b) && parts.length === 2) return { page: "result", id: b };
  return { page: "not_found" };
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function navigate(href: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  notify();
  if (!opts.replace) window.scrollTo({ top: 0 });
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  window.addEventListener("popstate", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("popstate", l);
  };
}

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const i = href.indexOf("?");
  return { pathname: i < 0 ? href : href.slice(0, i), search: i < 0 ? "" : href.slice(i) };
}

/** URL state shared by every page and the chat dock: cohort, horizon and run (SPEC 16). */
export interface ViewState {
  cohort: string;
  horizon: 1 | 3 | 6;
  run: string | null;
}

export function readView(search: string): ViewState {
  const q = new URLSearchParams(search);
  const h = Number(q.get("h") ?? 3);
  return { cohort: q.get("cohort") ?? "org:Engineering", horizon: h === 1 || h === 6 ? h : 3, run: q.get("run") };
}

export function viewHref(pathname: string, v: Partial<ViewState>, current: ViewState): string {
  const next = { ...current, ...v };
  const q = new URLSearchParams();
  q.set("cohort", next.cohort);
  q.set("h", String(next.horizon));
  if (next.run) q.set("run", next.run);
  return `${pathname}?${q.toString()}`;
}

export function useView(): ViewState {
  const { search } = useLocation();
  return readView(search);
}

export function setView(v: Partial<ViewState>): void {
  navigate(viewHref(window.location.pathname, v, readView(window.location.search)), { replace: true });
}
