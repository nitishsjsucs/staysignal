// The public demo's routes and guards (ADR 0018). /demo/session signs a visitor in to a new sandbox (if the gate admits
// one) with the role they picked; /demo/role switches the role inside the same sandbox; /demo/reset moves the visitor
// to a fresh sandbox and retires the old one. Every /api request of a sandbox spends units first (admitRequest).
// demoGuard turns the dev, runner and internal routes off, refuses any request another site starts (src/worker/demo/
// origin.ts), and bounds query values and request bodies. None of this runs outside SS_AUTH_MODE=demo.
import type { Context, Hono, MiddlewareHandler } from "hono";
import { CAPS, UNITS } from "../../shared/demo/budget";
import { LOCAL_PRINCIPALS } from "../../shared/policy/roles";
import { workspace } from "../agents/workspace-port";
import type { AppEnv } from "../app";
import { clearSessionCookie, clientKey, clientPrefix, DEFAULT_DEMO_PRINCIPAL, DEMO_COOKIE, demoKeyId, isDemoPrincipal, issueSession, MAX_SESSION_SECONDS, readCookie, sessionCookie, verifySession } from "../auth/demo-session";
import { cachedRefusal, rememberRefusal, rememberRetired } from "./refusals";
import { demoGate, type GateVerdict } from "./gate";
import type { AdmitVerdict } from "./meter";
import { BUSY_MESSAGE_TEXT } from "./messages";
import { CROSS_ORIGIN_MESSAGE, fromAnotherSite } from "./origin";

type C = Context<AppEnv>;

export const BUSY_MESSAGE = BUSY_MESSAGE_TEXT;
const OFF = [/^\/dev(\/|$)/, /^\/api\/dev(\/|$)/, /^\/internal(\/|$)/];

/** Reads at most `max` bytes of a request body; null when it is longer. */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const ch of chunks) {
    all.set(ch, at);
    at += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function bodyText(c: C): Promise<string> {
  return c.var.bodyText ?? (await c.req.text().catch(() => ""));
}

/** The request's JSON value: the bounded text the guard read in demo mode, else the body itself; null when empty or
 * not JSON. */
export async function readJsonValue(c: C): Promise<unknown> {
  const text = await bodyText(c);
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The request's JSON object body: an empty body is an empty object; anything that is not a JSON object (an array,
 * null, a number, text that is not JSON) is null, and the route answers 400 instead of reading a field of it. */
export async function readJsonBody(c: C): Promise<Record<string, unknown> | null> {
  if (!(await bodyText(c)).trim()) return {};
  const v = await readJsonValue(c);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** A reason in a request body: text, or absent (undefined or null). Anything else is refused by the route, and again
 * by the agent, before it can reach an audit row. */
export function reasonOk(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === "string";
}

export function tooLong(v: unknown, max: number): boolean {
  return typeof v === "string" && v.length > max;
}

export const demoGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.config.publicDemo) return next();
  if (OFF.some((re) => re.test(c.req.path))) return c.json({ error: "not found" }, 404);
  // reads too: a navigation or an <img> from another page carries the cookie and would spend the sandbox's units
  if (fromAnotherSite(c.req.raw)) return c.json({ error: CROSS_ORIGIN_MESSAGE }, 403);
  for (const values of Object.values(c.req.queries())) {
    if (values.some((v) => v.length > CAPS.maxQueryChars)) return c.json({ error: `query values are limited to ${CAPS.maxQueryChars} characters` }, 400);
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const text = await readCapped(c.req.raw, CAPS.maxBodyBytes);
    if (text === null) return c.json({ error: `request bodies are limited to ${CAPS.maxBodyBytes / 1024} KiB` }, 413);
    c.set("bodyText", text);
  }
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
};

/** Units a request spends: reads 1, writes 12 (src/shared/demo/budget.ts). The payroll simulation is a write here;
 * the sandbox spends the rest of its 80 units only when the routine actually starts (WorkspaceAgent.startRoutine). */
export function unitsFor(method: string, _path: string): number {
  return method === "GET" || method === "HEAD" ? UNITS.read : UNITS.write;
}

export function admitResponse(c: C, v: Exclude<AdmitVerdict, { ok: true }>): Response {
  if (v.code === "SANDBOX_EXPIRED") {
    c.header("Set-Cookie", clearSessionCookie());
    return c.json({ error: "unauthenticated", reason: "sandbox_expired", message: "Your sandbox has ended. Start a new one from the start page." }, 401);
  }
  if (v.code === "SANDBOX_SPENT") return c.json({ error: "busy", code: v.code, message: "This sandbox has used its request allowance. Reset it to start a fresh one." }, 429);
  c.header("Retry-After", String(v.retryAfterSeconds));
  return c.json({ error: "busy", code: v.code, message: BUSY_MESSAGE, retry_after_seconds: v.retryAfterSeconds }, 429);
}

/** Spends the request's units in the visitor's sandbox; a response when it may not proceed. A sandbox already known to
 * refuse (spent, ended, rate limited) is refused without a Durable Object request (src/worker/demo/refusals.ts). */
export async function admitRequest(c: C, units = unitsFor(c.req.method, c.req.path)): Promise<Response | null> {
  const sandbox = c.var.principal.sandbox;
  const cached = sandbox ? cachedRefusal(sandbox.id) : null;
  if (cached) return admitResponse(c, cached);
  const v = await (await c.var.ws()).admit(units);
  if (v.ok) return null;
  if (sandbox) rememberRefusal(sandbox.id, v, sandbox.exp);
  return admitResponse(c, v);
}

function busy(c: C, v: Exclude<GateVerdict, { ok: true }>): Response {
  c.header("Retry-After", String(v.retryAfterSeconds));
  return c.json({ error: "busy", code: v.code, message: BUSY_MESSAGE, retry_after_seconds: v.retryAfterSeconds }, v.code === "CLIENT_HOURLY" ? 429 : 503);
}

const now = () => Math.floor(Date.now() / 1000);

async function startSandbox(c: C, principal: string): Promise<Response> {
  const key = c.var.config.publicDemo!.signingKey;
  // an IPv6 client counts by its /64 (one subscriber's network), so cycling addresses inside it gains nothing
  const client = await clientKey(key, clientPrefix(c.req.header("CF-Connecting-IP") ?? "local"));
  const v = await demoGate(c.env).admit(client, Date.now(), undefined, await demoKeyId(key));
  if (!v.ok) return busy(c, v);
  await (await workspace(c.env, { sandbox: { id: v.sandbox, exp: v.exp } })).initSandbox(v.exp);
  const t = now();
  c.header("Set-Cookie", sessionCookie(await issueSession(key, { principal, sandbox: v.sandbox, iat: t, exp: v.exp }), v.exp - t));
  return c.json({ ok: true, principal, expires_at: v.exp, label: "synthetic" });
}

export function demoRoutes(app: Hono<AppEnv>): void {
  const session = async (c: C) => verifySession(c.var.config.publicDemo!.signingKey, readCookie(c.req.raw, DEMO_COOKIE), now());
  const off = (c: C) => (c.var.config.publicDemo ? null : c.json({ error: "not found" }, 404));

  app.get("/demo/session", async (c) => {
    const no = off(c);
    if (no) return no;
    const v = await session(c);
    if (!v.ok && v.reason !== "missing") c.header("Set-Cookie", clearSessionCookie());
    return c.json({
      public_demo: true,
      label: "synthetic",
      principals: LOCAL_PRINCIPALS.map((p) => ({ id: p.id, role: p.role, display: p.display, assigned_orgs: p.assigned_orgs ?? [] })),
      default_principal: DEFAULT_DEMO_PRINCIPAL,
      lifetime_seconds: MAX_SESSION_SECONDS,
      session: v.ok ? { principal: v.session.principal, expires_at: v.session.exp } : null,
    });
  });

  app.post("/demo/session", async (c) => {
    const no = off(c);
    if (no) return no;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "a JSON object is expected" }, 400);
    const principal = typeof body.principal === "string" ? body.principal : DEFAULT_DEMO_PRINCIPAL;
    if (!isDemoPrincipal(principal)) return c.json({ error: "unknown principal" }, 400);
    const v = await session(c);
    if (!v.ok) return startSandbox(c, principal);
    // already signed in: the same sandbox, the role picked now
    const key = c.var.config.publicDemo!.signingKey;
    c.header("Set-Cookie", sessionCookie(await issueSession(key, { ...v.session, principal, iat: now() }), v.session.exp - now()));
    return c.json({ ok: true, principal, expires_at: v.session.exp, label: "synthetic" });
  });

  app.post("/demo/role", async (c) => {
    const no = off(c);
    if (no) return no;
    const v = await session(c);
    if (!v.ok) return c.json({ error: "unauthenticated", reason: v.reason }, 401);
    const body = await readJsonBody(c);
    if (!body || typeof body.principal !== "string" || !isDemoPrincipal(body.principal)) return c.json({ error: "unknown principal" }, 400);
    // the role changes, the sandbox and its expiry never do
    const key = c.var.config.publicDemo!.signingKey;
    c.header("Set-Cookie", sessionCookie(await issueSession(key, { ...v.session, principal: body.principal, iat: now() }), v.session.exp - now()));
    return c.json({ ok: true, principal: body.principal, expires_at: v.session.exp });
  });

  app.post("/demo/reset", async (c) => {
    const no = off(c);
    if (no) return no;
    const v = await session(c);
    if (!v.ok) return c.json({ error: "unauthenticated", reason: v.reason }, 401);
    const started = await startSandbox(c, v.session.principal);
    if (started.status !== 200) return started;
    await (await workspace(c.env, { sandbox: { id: v.session.sandbox, exp: v.session.exp } })).retireSandbox();
    await demoGate(c.env).release(v.session.sandbox);
    rememberRetired(v.session.sandbox, v.session.exp);
    return started;
  });
}
