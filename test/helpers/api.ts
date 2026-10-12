// Drives the real Worker through exports.default.fetch at http://localhost with dev Access tokens.
import { exports } from "cloudflare:workers";

export const BASE = "http://localhost";
const tokens = new Map<string, string>();

export async function tokenFor(principal: string): Promise<string> {
  const cached = tokens.get(principal);
  if (cached) return cached;
  const r = await exports.default.fetch(new Request(`${BASE}/dev/login?principal=${encodeURIComponent(principal)}`));
  if (!r.ok) throw new Error(`dev login failed for ${principal}: ${r.status}`);
  const { token } = (await r.json()) as { token: string };
  tokens.set(principal, token);
  return token;
}

export async function call(path: string, opts: { as?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.as) headers.Authorization = `Bearer ${await tokenFor(opts.as)}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return exports.default.fetch(new Request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined }));
}

export async function json<T = Record<string, unknown>>(path: string, opts: Parameters<typeof call>[1] = {}): Promise<T> {
  const r = await call(path, opts);
  return (await r.json()) as T;
}

export const P = {
  analyst: "pa-analyst@larkspur.example",
  hrbpEng: "hrbp-engineering@larkspur.example",
  hrbpGtm: "hrbp-gtm@larkspur.example",
  lead: "pa-lead@larkspur.example",
  director: "people-ops-director@larkspur.example",
  dataEng: "data-eng@larkspur.example",
  auditor: "audit@larkspur.example",
} as const;
