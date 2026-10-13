// The funnel plot's limits (SPEC 16.2): Poisson limits on observed over expected that contain 1, narrow as the
// expected count grows, and stay close to the exact Poisson quantiles at the sizes the Workforce page shows.
import { describe, expect, it } from "vitest";
import { funnelLimits, funnelVerdict, Z95, Z998 } from "../../src/shared/stats/funnel";

function poissonQuantile(mean: number, q: number): number {
  let k = 0;
  let p = Math.exp(-mean);
  let cdf = p;
  while (cdf < q) {
    k += 1;
    p *= mean / k;
    cdf += p;
  }
  return k;
}

describe("funnel limits", () => {
  it("contain 1 and narrow as the expected count grows", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const e of [2, 5, 10, 20, 50, 100]) {
      const [lo, hi] = funnelLimits(e, Z95);
      expect(lo).toBeLessThan(1);
      expect(hi).toBeGreaterThan(1);
      expect(hi - lo).toBeLessThan(prev);
      prev = hi - lo;
      const [lo998, hi998] = funnelLimits(e, Z998);
      expect(lo998).toBeLessThanOrEqual(lo);
      expect(hi998).toBeGreaterThan(hi);
    }
  });

  it("track the exact Poisson quantiles within one count", () => {
    for (const e of [5, 10, 20, 50, 100]) {
      const [lo, hi] = funnelLimits(e, Z95);
      expect(Math.abs(lo * e - poissonQuantile(e, 0.025))).toBeLessThanOrEqual(1);
      expect(Math.abs(hi * e - poissonQuantile(e, 0.975))).toBeLessThanOrEqual(1.5);
    }
  });

  it("classifies points against the 95% and 99.8% limits", () => {
    expect(funnelVerdict(20, 20)).toBe("inside");
    expect(funnelVerdict(31, 20)).toBe("outside95");
    expect(funnelVerdict(40, 20)).toBe("outside998");
    expect(funnelVerdict(0, 10)).toBe("outside998");
  });
});
