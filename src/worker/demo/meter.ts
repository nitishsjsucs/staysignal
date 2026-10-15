// A sandbox's requests and units (ADR 0018): a per-minute window of requests kept in memory, and a lifetime count of
// units persisted ahead of use.
// The lifetime count is written once per block of CAPS.unitFlushEvery units, and the block is reserved before it is
// spent, so an evicted object reloads a count at least as high as what was used: the lifetime cap holds across
// evictions. The per-minute window restarts when the object is evicted, which only makes it briefly more permissive.
import { CAPS } from "../../shared/demo/budget";

export type AdmitVerdict = { ok: true; used: number } | { ok: false; code: "SANDBOX_EXPIRED" | "RATE_LIMITED" | "SANDBOX_SPENT"; retryAfterSeconds: number };

export type MeterCaps = { unitsPerSandbox: number; requestsPerSandboxPerMinute: number; unitFlushEvery: number };

export class UnitMeter {
  private window: number[] = [];
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
    this.window = this.window.filter((at) => at > now - 60_000);
    if (this.window.length >= this.caps.requestsPerSandboxPerMinute) {
      const oldest = this.window[0] ?? now;
      return { ok: false, code: "RATE_LIMITED", retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
    }
    this.window.push(now);
    this.used += units;
    if (this.used > this.reserved) {
      this.reserved = Math.ceil(this.used / this.caps.unitFlushEvery) * this.caps.unitFlushEvery;
      this.persist(this.reserved);
    }
    return { ok: true, used: this.used };
  }
}
