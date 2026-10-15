// DemoGate (ADR 0018): one Durable Object ("gate") that decides whether a new public-demo sandbox may start. It keeps
// one row per sandbox (its ID, an HMAC of the client address, creation and expiry times), never the address itself,
// and prunes rows after CAPS.gateRetentionMs. Three caps: new sandboxes per client per hour, per UTC day overall, and
// live sandboxes. Called only when a visitor signs in or resets, so it costs one request per sandbox, not per click.
import { DurableObject } from "cloudflare:workers";
import { CAPS, type Caps } from "../../shared/demo/budget";
import { newSandboxId } from "../auth/demo-session";

export type GateVerdict = { ok: true; sandbox: string; exp: number } | { ok: false; code: "CLIENT_HOURLY" | "DAILY" | "FULL"; retryAfterSeconds: number };

export const GATE_NAME = "gate";

export class DemoGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS sandboxes (id TEXT PRIMARY KEY, client TEXT NOT NULL, created_at INTEGER NOT NULL, exp INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0)");
  }

  private count(query: string, ...args: (string | number)[]): number {
    return Number(this.ctx.storage.sql.exec<{ n: number }>(query, ...args).one().n);
  }

  /** Admits one new sandbox for a client (an HMAC of its address) at `now` (ms), or says which cap stops it. */
  admit(client: string, now: number = Date.now(), caps: Pick<Caps, "newSandboxesPerClientPerHour" | "newSandboxesPerDay" | "liveSandboxes" | "sandboxLifetimeMs" | "gateRetentionMs"> = CAPS): GateVerdict {
    this.ctx.storage.sql.exec("DELETE FROM sandboxes WHERE created_at < ?", now - caps.gateRetentionMs);
    const hourAgo = now - 60 * 60 * 1000;
    if (this.count("SELECT COUNT(*) AS n FROM sandboxes WHERE client = ? AND created_at > ?", client, hourAgo) >= caps.newSandboxesPerClientPerHour) {
      const oldest = this.count("SELECT MIN(created_at) AS n FROM sandboxes WHERE client = ? AND created_at > ?", client, hourAgo);
      return { ok: false, code: "CLIENT_HOURLY", retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60 * 60 * 1000 - now) / 1000)) };
    }
    const day = new Date(now);
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    if (this.count("SELECT COUNT(*) AS n FROM sandboxes WHERE created_at >= ?", dayStart) >= caps.newSandboxesPerDay) {
      return { ok: false, code: "DAILY", retryAfterSeconds: Math.max(1, Math.ceil((dayStart + 24 * 60 * 60 * 1000 - now) / 1000)) };
    }
    if (this.count("SELECT COUNT(*) AS n FROM sandboxes WHERE exp > ? AND ended = 0", now) >= caps.liveSandboxes) {
      const next = this.count("SELECT MIN(exp) AS n FROM sandboxes WHERE exp > ? AND ended = 0", now);
      return { ok: false, code: "FULL", retryAfterSeconds: Math.max(1, Math.ceil((next - now) / 1000)) };
    }
    const id = newSandboxId();
    const exp = now + caps.sandboxLifetimeMs;
    this.ctx.storage.sql.exec("INSERT INTO sandboxes (id, client, created_at, exp) VALUES (?, ?, ?, ?)", id, client, now, exp);
    return { ok: true, sandbox: id, exp: Math.floor(exp / 1000) };
  }

  /** A reset retired this sandbox: it no longer counts as live. */
  release(id: string): void {
    this.ctx.storage.sql.exec("UPDATE sandboxes SET ended = 1 WHERE id = ?", id);
  }

  /** Counts for tests and the operator: live sandboxes and sandboxes started today. */
  stats(now: number = Date.now()): { live: number; today: number } {
    const day = new Date(now);
    const dayStart = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
    return { live: this.count("SELECT COUNT(*) AS n FROM sandboxes WHERE exp > ? AND ended = 0", now), today: this.count("SELECT COUNT(*) AS n FROM sandboxes WHERE created_at >= ?", dayStart) };
  }
}

export function demoGate(env: Env): DurableObjectStub<DemoGate> {
  return env.DEMO_GATE.get(env.DEMO_GATE.idFromName(GATE_NAME));
}
