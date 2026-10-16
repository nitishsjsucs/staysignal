// API client: same-origin fetches with the session cookie (the dev cookie locally, Access in production). Results are
// cached by URL for the session; pages refetch after actions.
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The public demo's refusal code on a 429 (RATE_LIMITED, SANDBOX_SPENT), when the server sent one. */
    readonly code: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** Releases a response whose body the app will not read. The Worker's responses are not cached (Cache-Control:
 * no-store), and a no-store body that nobody reads keeps its request open in the browser until the page goes away, so
 * a test waiting for the network to go idle never finishes. */
export function discard(r: Response): void {
  void r.body?.cancel().catch(() => undefined);
}

/** The public demo's "busy" answer, with the server's own code and message kept (ADR 0018). A spent sandbox tells the
 * app once, so it can offer a fresh sandbox instead of retrying. */
async function busyError(r: Response): Promise<ApiError> {
  const body = (await r.clone().json().catch(() => null)) as { code?: string; message?: string; retry_after_seconds?: number } | null;
  const retry = Number(r.headers.get("Retry-After")) || body?.retry_after_seconds || null;
  const e = new ApiError(429, body?.message ?? "The demo is busy, try again later.", body?.code ?? null, retry);
  if (e.code === "SANDBOX_SPENT") window.dispatchEvent(new CustomEvent("ss-sandbox-spent", { detail: e.message }));
  return e;
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

/** The public demo: a request met an ended sandbox, so the app goes back to its start page (ADR 0018). */
async function sandboxEnded(r: Response): Promise<boolean> {
  const body = (await r.clone().json().catch(() => null)) as { reason?: string } | null;
  if (body?.reason !== "sandbox_expired") return false;
  window.dispatchEvent(new Event("ss-principal"));
  return true;
}

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (r.status === 401) throw new ApiError(401, (await sandboxEnded(r)) ? "Your sandbox has ended" : "Sign in with the role switcher");
  if (r.status === 429) throw await busyError(r);
  if (!r.ok) {
    discard(r);
    throw new ApiError(r.status, `${r.status} ${r.statusText}`);
  }
  return (await r.json()) as T;
}

export async function postJSON<T>(url: string, body: unknown = {}): Promise<T> {
  const r = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (r.status === 401) await sandboxEnded(r);
  if (r.status === 429) throw await busyError(r);
  if (!r.ok && r.status !== 200) {
    discard(r);
    throw new ApiError(r.status, `${r.status} ${r.statusText}`);
  }
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
  /** Demo mode (npm run demo): recorded model output only; the chat offers the recorded questions. */
  demo?: { recorded_questions: string[] } | null;
  /** The public demo (ADR 0018): the sandbox's expiry, the principals to switch between, the stub's label. */
  public_demo?: { expires_at: number | null; principals: { id: string; role: string; display: string; assigned_orgs?: string[] }[]; recorded_on: string; stub_label: string; limits: { question_chars: number; reason_chars: number }; source_url?: string } | null;
}

export function hasScope(me: Me | null, scope: string): boolean {
  return Boolean(me?.principal.scopes.includes(scope));
}
