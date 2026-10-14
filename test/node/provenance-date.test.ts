// The Lab's manifests carry UTC timestamps; an evening recording in California must not read as the next day.
import { describe, expect, it } from "vitest";
import { recordedDate } from "../../src/shared/provenance";

describe("recorded dates name their zone", () => {
  it("shows a UTC timestamp with its zone and a bare date as it is", () => {
    expect(recordedDate("2026-10-14T00:19:06Z")).toBe("2026-10-14 00:19 UTC");
    expect(recordedDate("2026-10-14T01:03:02.123Z")).toBe("2026-10-14 01:03 UTC");
    expect(recordedDate("2026-10-13")).toBe("2026-10-13");
    expect(recordedDate(null)).toBeNull();
    expect(recordedDate("not a date")).toBeNull();
  });
});
