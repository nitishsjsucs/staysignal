// Drives the Worker in public demo mode (ADR 0018) through exports.default.fetch with a non-localhost host, the way a
// visitor's browser does: sign in at /demo/session, then send the ss_demo cookie on every request.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { demoGate } from "../../src/worker/demo/gate";

export const DEMO_BASE = "https://staysignal-demo.example.test";

let clients = 0;
/** A fresh client address per sign-in unless one is given, so the per-client hourly cap only bites where tested. */
export function nextClient(): string {
  clients++;
  return `203.0.113.${clients % 250}`;
}

export interface Visitor {
  cookie: string;
  expires: number;
  principal: string;
}

export function cookieFrom(r: Response): string | null {
  const set = r.headers.get("Set-Cookie");
  if (!set) return null;
  const first = set.split(";")[0] ?? "";
  return first.startsWith("ss_demo=") ? first : null;
}

/** The headers of a browser's WebSocket upgrade (the Origin and the cookie are the caller's). */
export const WS_UPGRADE = { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } as const;

export async function demoCall(path: string, opts: { cookie?: string | null; method?: string; body?: unknown; headers?: Record<string, string>; client?: string; raw?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": opts.client ?? "198.51.100.1", ...(opts.headers ?? {}) };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const body = opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  if (body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(new Request(`${DEMO_BASE}${path}`, { method: opts.method ?? (body !== undefined ? "POST" : "GET"), headers, body }));
}

export async function demoJson<T = Record<string, unknown>>(path: string, opts: Parameters<typeof demoCall>[1] = {}): Promise<T> {
  return (await (await demoCall(path, opts)).json()) as T;
}

/** Signs a new visitor in: a new sandbox, as `principal` (default People Analytics Lead). */
export async function visit(principal?: string, client = nextClient()): Promise<Visitor> {
  const r = await demoCall("/demo/session", { body: principal ? { principal } : {}, client });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${await r.text()}`);
  const out = (await r.json()) as { principal: string; expires_at: number };
  return { cookie: cookieFrom(r)!, expires: out.expires_at, principal: out.principal };
}

/** Switches the visitor's role inside the same sandbox. */
export async function actAs(v: Visitor, principal: string): Promise<Visitor> {
  const r = await demoCall("/demo/role", { cookie: v.cookie, body: { principal } });
  if (r.status !== 200) throw new Error(`role switch failed: ${r.status}`);
  return { ...v, cookie: cookieFrom(r)!, principal };
}

/** Empties the gate's records, so each test starts below the daily and live caps. */
export async function resetGate(): Promise<void> {
  await runInDurableObject(demoGate(env), (_i, state) => {
    state.storage.sql.exec("DELETE FROM sandboxes");
  });
}

export const P = {
  analyst: "pa-analyst@larkspur.example",
  hrbpEng: "hrbp-engineering@larkspur.example",
  lead: "pa-lead@larkspur.example",
  director: "people-ops-director@larkspur.example",
  dataEng: "data-eng@larkspur.example",
  auditor: "audit@larkspur.example",
} as const;

/** An env whose Durable Object namespaces count every call made on their stubs (each is a Durable Object request on
 * Workers Free). `calls()` reads the count. */
export function countingEnv(base: Env = env): { env: Env; calls: () => number } {
  let n = 0;
  const stub = <T extends object>(s: T): T =>
    new Proxy(s, {
      get(t, prop) {
        const v = Reflect.get(t, prop) as unknown;
        if (typeof v === "function" && typeof prop === "string" && prop !== "then") {
          return (...args: unknown[]) => {
            n++;
            return Reflect.apply(v as (...a: unknown[]) => unknown, t, args);
          };
        }
        return v;
      },
    });
  const ns = <T extends DurableObjectNamespace>(x: T): T =>
    new Proxy(x, {
      get(t, prop) {
        const v = Reflect.get(t, prop) as unknown;
        if (prop === "get") return (id: DurableObjectId, o?: unknown) => stub(t.get(id, o as never));
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  const counted = Object.create(base, {
    WORKSPACE_AGENT: { value: ns(base.WORKSPACE_AGENT) },
    ANALYST_AGENT: { value: ns(base.ANALYST_AGENT) },
    DEMO_GATE: { value: ns(base.DEMO_GATE) },
  }) as Env;
  return { env: counted, calls: () => n };
}

/** Meters every SQL statement an object runs from now on (rows written and read of each cursor, summed when read). */
export async function sqlMeter(stub: DurableObjectStub): Promise<{ written: () => number; read: () => number }> {
  const cursors: { rowsWritten: number; rowsRead: number }[] = [];
  await runInDurableObject(stub, (_i, state) => {
    const sql = state.storage.sql as unknown as { exec: (...a: unknown[]) => { rowsWritten: number; rowsRead: number } };
    const exec = sql.exec.bind(sql);
    sql.exec = (...a: unknown[]) => {
      const c = exec(...a);
      cursors.push(c);
      return c;
    };
  });
  return { written: () => cursors.reduce((s, c) => s + c.rowsWritten, 0), read: () => cursors.reduce((s, c) => s + c.rowsRead, 0) };
}
