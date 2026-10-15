// A sandbox's request units (ADR 0018): a per-minute window kept in memory and a lifetime count persisted ahead of use.
// The lifetime count is written once per block of CAPS.unitFlushEvery units, and the block is reserved before it is
// spent, so an evicted object reloads a count at least as high as what was used: the lifetime cap holds across
// evictions. The per-minute window restarts when the object is evicted, which only makes it briefly more permissive.
import { CAPS } from "../../shared/demo/budget";

export type AdmitVerdict = { ok: true; used: number } | { ok: false; code: "SANDBOX_EXPIRED" | "RATE_LIMITED" | "SANDBOX_SPENT"; retryAfterSeconds: number };

export type MeterCaps = { unitsPerSandbox: number; unitsPerSandboxPerMinute: number; unitFlushEvery: number };

export class UnitMeter {
  private window: { at: number; units: number }[] = [];
  private used: number;
  private reserved: number;
  private readonly persist: (reserved: number) => void;
  private readonly caps: MeterCaps;

  constructor(reserved: number, persist: (reserved: number) => void, caps: MeterCaps = CAPS) {
    this.reserved = reserved;
    this.used = reserved;
    this.persist = persist;
    this.caps = caps;
  }

  get spent(): number {
    return this.used;
  }

  admit(units: number, now: number): AdmitVerdict {
    if (!(units > 0) || !Number.isFinite(units)) return { ok: false, code: "SANDBOX_SPENT", retryAfterSeconds: 0 };
    if (this.used + units > this.caps.unitsPerSandbox) return { ok: false, code: "SANDBOX_SPENT", retryAfterSeconds: 0 };
    this.window = this.window.filter((w) => w.at > now - 60_000);
    const inMinute = this.window.reduce((s, w) => s + w.units, 0);
    if (inMinute + units > this.caps.unitsPerSandboxPerMinute) {
      const oldest = this.window[0]?.at ?? now;
      return { ok: false, code: "RATE_LIMITED", retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
    }
    this.window.push({ at: now, units });
    this.used += units;
    if (this.used > this.reserved) {
      this.reserved = Math.ceil(this.used / this.caps.unitFlushEvery) * this.caps.unitFlushEvery;
      this.persist(this.reserved);
    }
    return { ok: true, used: this.used };
  }
}
