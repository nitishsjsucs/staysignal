// API client: same-origin fetches with the session cookie (the dev cookie locally, Access in production). Results are
// cached by URL for the session; pages refetch after actions.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Refusal {
  refused: true;
  code: string;
  message: string;
}

export function isRefusal(x: unknown): x is Refusal {
  return typeof x === "object" && x !== null && (x as Refusal).refused === true;
}

const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();
let epoch = 0;

export function invalidate(): void {
  cache.clear();
  epoch++;
  for (const l of listeners) l();
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (r.status === 401) throw new ApiError(401, "Sign in with the role switcher");
  if (!r.ok) throw new ApiError(r.status, `${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export async function postJSON<T>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok && r.status !== 200) throw new ApiError(r.status, `${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export interface Query<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

export function useQuery<T>(url: string | null): Query<T> {
  const [, setTick] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: Error | null; loading: boolean; url: string | null }>({ data: url ? ((cache.get(url) as T) ?? null) : null, error: null, loading: Boolean(url && !cache.has(url)), url });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const my = ++seq.current;
    setState((s) => ({ data: (cache.get(url) as T) ?? (s.url === url ? s.data : null), error: null, loading: !cache.has(url), url }));
    getJSON<T>(url).then(
      (data) => {
        cache.set(url, data);
        if (my === seq.current) setState({ data, error: null, loading: false, url });
      },
      (error: Error) => {
        if (my === seq.current) setState((s) => ({ ...s, error, loading: false }));
      },
    );
  }, [url]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    const l = () => {
      setTick((t) => t + 1);
      load();
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [load]);
  void epoch;
  return { data: state.url === url ? state.data : null, error: state.error, loading: state.loading, reload: load };
}

export interface Me {
  principal: { id: string; role: string; display: string; scopes: string[]; assignedOrgs: string[] };
}

export function hasScope(me: Me | null, scope: string): boolean {
  return Boolean(me?.principal.scopes.includes(scope));
}
