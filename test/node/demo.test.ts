// The demo profile's snapshot plan (SPEC 22.4): every beat maps to a snapshot, snapshots hold the Workers state, the
// warehouse, the landing store and the published documents, and the reset result renders in the README.
import { describe, expect, it } from "vitest";
import { BEAT_SNAPSHOT, STATE_PATHS } from "../../scripts/demo.ts";
import { renderDemoReset } from "../../scripts/lib/results.ts";

describe("demo snapshots", () => {
  it("covers beats 1 to 5, with beats 1 to 3 sharing the initial state", () => {
    expect(Object.keys(BEAT_SNAPSHOT).map(Number)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set([BEAT_SNAPSHOT[1], BEAT_SNAPSHOT[2], BEAT_SNAPSHOT[3]]).size).toBe(1);
    expect(new Set(Object.values(BEAT_SNAPSHOT)).size).toBe(3);
  });

  it("holds the local Workers persistence and the engine's state, nothing outside the repository", () => {
    expect(STATE_PATHS).toContain("dist/staysignal/.wrangler/state");
    expect(STATE_PATHS).toContain("var/warehouse.duckdb");
    for (const p of STATE_PATHS) expect(p.startsWith("/") || p.includes("..")).toBe(false);
  });

  it("renders a reset time against its target", () => {
    const md = renderDemoReset("results/x.json", { kind: "demo-reset", command: "npm run demo:reset -- --beat 1 --record", date: "2026-10-12", beat: 1, seconds: 3, target_seconds: 20 });
    expect(md).toContain("took 3.0 s, against a target of 20 s");
  });
});
