// ADR 0018: the public demo's budget arithmetic. The daily bounds recomputed from the committed caps and the measured
// per-unit costs must stay inside the demo's half of each Workers Free allowance; the ADR's table states the same
// numbers. The meter's lifetime cap holds across evictions, and the WebSocket guard bounds frames.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { budgetTable, CAPS, DEMO_SHARE, FREE_PLAN, MEASURED, UNITS } from "../../src/shared/demo/budget";
import { UnitMeter } from "../../src/worker/demo/meter";
import { guardFrames } from "../../src/worker/demo/frames";

describe("the budget arithmetic", () => {
  it("keeps every daily bound inside the demo's share of the Workers Free allowance", () => {
    for (const line of budgetTable()) expect(line.bound, line.quantity).toBeLessThanOrEqual(line.budget);
  });

  it("pins the caps and the table of ADR 0018", () => {
    expect(DEMO_SHARE).toBe(0.5);
    expect(FREE_PLAN).toMatchObject({ workerRequestsPerDay: 100_000, doRequestsPerDay: 100_000, doRowsWrittenPerDay: 100_000, doRowsReadPerDay: 5_000_000, doDurationGbSecondsPerDay: 13_000, workflowConcurrentInstances: 100 });
    expect(CAPS).toMatchObject({ requestsPerSandboxPerMinute: 300, sandboxLifetimeMs: 4 * 3600_000, newSandboxesPerClientPerHour: 3, newSandboxesPerDay: 15, liveSandboxes: 10, unitsPerSandbox: 600, routinesPerSandbox: 1, maxBodyBytes: 8192, maxQuestionChars: 500, maxReasonChars: 300, wsFramesPerMinute: 20, wsFramesPerConnection: 40 });
    expect(UNITS).toEqual({ read: 1, socket: 2, write: 12, chatTurn: 18, routine: 80 });
    expect(Object.fromEntries(budgetTable().map((l) => [l.quantity, l.bound]))).toEqual({
      "Worker requests per day": 9_045,
      "Durable Object requests per day": 45_030,
      "SQLite rows written per day": 45_120,
      "SQLite rows read per day": 456_000,
      "Durable Object duration per day (GB-s)": 864,
      "Bytes stored at any time": 10 * MEASURED.bytesPerSandbox,
      "Concurrent Workflow instances": 10,
    });
    const adr = readFileSync("docs/adr/0018-public-demo-mode.md", "utf8");
    for (const s of ["15 sandboxes x 600 units = 9,000", "15 x 600 x 5 = 45,000", "15 x 2 x (300 + 600 x 2) = 45,000", "10 live sandboxes x 4 MiB = 40 MiB", "a read 1, a write (POST) 12, a chat turn 18, the routine 80; a sandbox has 600 units"]) expect(adr).toContain(s);
  });

  it("would fail if a cap were raised past the budget", () => {
    expect(budgetTable({ ...CAPS, newSandboxesPerDay: 30 }).some((l) => l.bound > l.budget)).toBe(true);
    expect(budgetTable(CAPS, { ...MEASURED, doRequestsPerUnit: 8 }).some((l) => l.bound > l.budget)).toBe(true);
  });
});

describe("the unit meter", () => {
  const caps = { unitsPerSandbox: 600, requestsPerSandboxPerMinute: 180, unitFlushEvery: 25 };

  it("refuses past 180 requests a minute, whatever their units, and admits again once the minute passes", () => {
    const m = new UnitMeter(0, () => undefined, caps);
    for (let i = 0; i < 180; i++) expect(m.admit(i % 2 ? 1 : 2, 1_000 + i).ok).toBe(true);
    expect(m.admit(1, 2_000)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(m.admit(1, 62_000).ok).toBe(true);
  });

  it("reserves each block of 25 before it is spent, so a reload never undercounts", () => {
    const writes: number[] = [];
    let reserved = 0;
    let m = new UnitMeter(reserved, (r) => {
      writes.push(r);
      reserved = r;
    }, caps);
    let t = 0;
    let truth = 0;
    for (let i = 0; i < 1000; i++) {
      // evict (reload from the persisted count) every 7 requests, spending one minute between requests
      if (i % 7 === 0) m = new UnitMeter(reserved, (r) => {
        writes.push(r);
        reserved = r;
      }, caps);
      const out = m.admit(1, (t += 61_000));
      if (!out.ok) {
        expect(out.code).toBe("SANDBOX_SPENT");
        break;
      }
      truth++;
      expect(reserved).toBeGreaterThanOrEqual(m.spent);
    }
    expect(truth).toBeLessThanOrEqual(600);
    expect(m.admit(1, (t += 61_000))).toMatchObject({ ok: false, code: "SANDBOX_SPENT" });
    // one write per block reserved, never one per request
    expect(writes.length).toBeLessThanOrEqual(truth);
    expect(new UnitMeter(0, () => undefined, caps).admit(601, 0)).toMatchObject({ ok: false, code: "SANDBOX_SPENT" });
  });
});

describe("the WebSocket frame guard", () => {
  function fake(filter?: (c: unknown, m: string) => string | null) {
    const seen: string[] = [];
    const closed: [number, string][] = [];
    const agent = { onMessage: (_c: unknown, m: string | ArrayBuffer) => void seen.push(String(m)) };
    guardFrames(agent as never, { caps: { maxWsFrameBytes: 100, wsFramesPerMinute: 3, wsFramesPerConnection: 5 }, ...(filter ? { filter: filter as never } : {}) });
    // a connection whose state, like a hibernatable WebSocket's attachment, outlives the object in memory
    const conn = {
      id: "c1",
      state: { principal: "p" } as Record<string, unknown> | null,
      setState(s: Record<string, unknown>) {
        this.state = s;
        return s;
      },
      close: (code: number, reason: string) => void closed.push([code, reason]),
    };
    return { agent, seen, closed, conn };
  }

  it("drops frames over the size limit, counting UTF-8 bytes, and closes the connection", async () => {
    const f = fake();
    await f.agent.onMessage(f.conn as never, "x".repeat(101));
    // 40 three-byte characters are 120 bytes
    await f.agent.onMessage(f.conn as never, "\u20ac".repeat(40));
    expect(f.seen).toEqual([]);
    expect(f.closed).toEqual([
      [1009, "frame too large"],
      [1009, "frame too large"],
    ]);
  });

  it("closes a connection that sends more frames a minute than allowed", async () => {
    const f = fake();
    for (let i = 0; i < 4; i++) await f.agent.onMessage(f.conn as never, `m${i}`);
    expect(f.seen).toEqual(["m0", "m1", "m2"]);
    expect(f.closed).toEqual([[4429, "too many messages"]]);
  });

  it("counts in the connection's state, so a new guard (a woken object) keeps the counts and the lifetime cap holds", async () => {
    const f = fake();
    let t = 0;
    const now = Date.now;
    Date.now = () => t;
    try {
      for (let i = 0; i < 5; i++) {
        // a fresh guard on every frame, a minute apart: the per-minute window never fills
        const again = { onMessage: (_c: unknown, m: string | ArrayBuffer) => void f.seen.push(String(m)) };
        guardFrames(again as never, { caps: { maxWsFrameBytes: 100, wsFramesPerMinute: 3, wsFramesPerConnection: 5 } });
        t += 61_000;
        await again.onMessage(f.conn as never, `m${i}`);
      }
      t += 61_000;
      await f.agent.onMessage(f.conn as never, "m5");
    } finally {
      Date.now = now;
    }
    expect(f.seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(f.closed).toEqual([[4429, "this connection has sent its frames; reconnect"]]);
    expect(f.conn.state).toMatchObject({ principal: "p" });
  });

  it("hands the SDK only what the filter lets through, rewritten if it says so, and never binary frames", async () => {
    const f = fake((_c, m) => (m === "drop" ? null : m === "rewrite" ? "rewritten" : m));
    for (const m of ["keep", "drop", "rewrite"]) await f.agent.onMessage(f.conn as never, m);
    await f.agent.onMessage(f.conn as never, new ArrayBuffer(4) as never);
    expect(f.seen).toEqual(["keep", "rewritten"]);
  });
});
