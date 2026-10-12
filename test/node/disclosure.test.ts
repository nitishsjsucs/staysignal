// C56: rounding steps by cohort size, the population-change rule, hidden-sum suppression.
import { describe, expect, it } from "vitest";
import { roundingFor, roundShare, roundToStep } from "../../src/shared/guard/disclosure";
import { comparisonServable } from "../../src/shared/guard/population";
import { hiddenSumSuppress } from "../../src/shared/guard/suppression";

describe("disclosure", () => {
  it("rounds by cohort size", () => {
    expect(roundingFor(2035).step).toBe(0.1);
    expect(roundingFor(120).step).toBe(0.5);
    expect(roundingFor(12).step).toBe(1);
    expect(() => roundingFor(9)).toThrow();
    expect(roundToStep(13.149, 0.1)).toBe(13.1);
    expect(roundToStep(13.25, 0.5)).toBe(13.5);
    expect(roundToStep(2.5, 1)).toBe(3);
    expect(roundShare(0.312)).toBe(30);
  });

  it("serves comparisons only when 0 or at least 10 people changed", () => {
    expect(comparisonServable(0, 0)).toBe(true);
    expect(comparisonServable(4, 5)).toBe(false);
    expect(comparisonServable(6, 4)).toBe(true);
  });

  it("suppresses the smallest visible child when hidden children hold 1 to 9 people", () => {
    const r = hiddenSumSuppress(59, [{ key: "a", n: 25 }, { key: "b", n: 26 }]);
    expect([...r.suppressed]).toEqual(["a"]);
    expect(hiddenSumSuppress(51, [{ key: "a", n: 25 }, { key: "b", n: 26 }]).suppressed.size).toBe(0);
  });
});
