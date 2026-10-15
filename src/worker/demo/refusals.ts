// Refusals the Worker remembers (ADR 0018): once a sandbox answers that it is spent, ended (expired or retired by a
// reset) or rate limited, the Worker isolate refuses the same sandbox's requests itself until that changes, without a
// Durable Object request. A spent or ended sandbox stays so until its expiry, when the cookie stops verifying anyway;
// a rate limit lasts its Retry-After. Per isolate and best effort: another isolate asks the sandbox once and then
// remembers too. Bounded in size, oldest first out.
import type { AdmitVerdict } from "./meter";

export type Refused = Exclude<AdmitVerdict, { ok: true }>;

const MAX_ENTRIES = 2000;
const refused = new Map<string, { verdict: Refused; until: number }>();

export function cachedRefusal(sandbox: string, now: number = Date.now()): Refused | null {
  const r = refused.get(sandbox);
  if (!r) return null;
  if (r.until <= now) {
    refused.delete(sandbox);
    return null;
  }
  return r.verdict.code === "RATE_LIMITED" ? { ...r.verdict, retryAfterSeconds: Math.max(1, Math.ceil((r.until - now) / 1000)) } : r.verdict;
}

/** Remembers a sandbox's refusal; `expSeconds` is the sandbox's expiry from the verified cookie. */
export function rememberRefusal(sandbox: string, verdict: Refused, expSeconds: number, now: number = Date.now()): void {
  const until = verdict.code === "RATE_LIMITED" ? now + Math.max(1, verdict.retryAfterSeconds) * 1000 : expSeconds * 1000;
  if (until <= now) return;
  refused.delete(sandbox);
  if (refused.size >= MAX_ENTRIES) {
    const oldest = refused.keys().next().value;
    if (oldest !== undefined) refused.delete(oldest);
  }
  refused.set(sandbox, { verdict, until });
}

/** A reset retired this sandbox: its cookie meets "ended" from now on. */
export function rememberRetired(sandbox: string, expSeconds: number): void {
  rememberRefusal(sandbox, { ok: false, code: "SANDBOX_EXPIRED", retryAfterSeconds: 0 }, expSeconds);
}
