import { describe, expect, it } from "vitest";
import { checkBudget, estimateBytes, GB, PROFILES } from "../../scripts/lib/memory-budget.ts";

describe("27B memory budget (C65)", () => {
  it("computes W + n_seq x (recurrent + ctx x 64 KiB) + prompt cache", () => {
    const est = estimateBytes({ nSeq: 2, ctxTokens: 1000, promptCacheBytes: 0, wBytes: 10 * GB });
    expect(est).toBeCloseTo(10 * GB + 2 * (0.151 * GB + 1000 * 65536), -3);
  });

  it("accepts the agent and Lab profiles and refuses anything over 17.2 GB", () => {
    expect(checkBudget(PROFILES.agent).ok).toBe(true);
    expect(checkBudget(PROFILES.lab).ok).toBe(true);
    expect(checkBudget({ nSeq: 8, ctxTokens: 8192, promptCacheBytes: 1e9 }).ok).toBe(false);
    expect(checkBudget({ nSeq: 1, ctxTokens: 8704, promptCacheBytes: 0, wBytes: 17.0 * GB }).ok).toBe(false);
  });
});

import { guardViolation, parseDfAvailable, parseSwapUsage, swapGrowthLimitBytes } from "../../scripts/lib/guards.ts";
import { decodeConcurrency, mlxArgs } from "../../scripts/llm.ts";

describe("machine guards", () => {
  it("parses sysctl vm.swapusage and df -k", () => {
    expect(parseSwapUsage("vm.swapusage: total = 7168.00M  used = 5999.06M  free = 1168.94M  (encrypted)")).toEqual({
      totalBytes: Math.round(7168 * 1024 ** 2),
      usedBytes: Math.round(5999.06 * 1024 ** 2),
    });
    expect(parseDfAvailable("Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s5 482344960 400000000 36000000 92% /")).toBe(36000000 * 1024);
  });

  it("stops on swap growth over 2 GB or free disk under 6 GB", () => {
    const base = { at: "", swapUsedBytes: 6e9, swapTotalBytes: 8e9, freeDiskBytes: 30e9, swapusage: "", dfHome: "" };
    expect(guardViolation(base, { ...base, swapUsedBytes: 7.9e9 })).toBeNull();
    expect(guardViolation(base, { ...base, swapUsedBytes: 8.1e9 })).toMatch(/swap grew/);
    expect(guardViolation(base, { ...base, freeDiskBytes: 5e9 })).toMatch(/free disk/);
  });

  it("takes the operator's SS_SWAP_GROWTH_LIMIT_GB override, and never overrides the free-disk floor", () => {
    expect(swapGrowthLimitBytes({})).toBe(2e9);
    expect(swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "" })).toBe(2e9);
    expect(swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "6" })).toBe(6e9);
    expect(swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "1.5" })).toBe(1.5e9);
    expect(() => swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "0" })).toThrow(/positive/);
    expect(() => swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "six" })).toThrow(/positive/);
    const base = { at: "", swapUsedBytes: 1e9, swapTotalBytes: 2e9, freeDiskBytes: 46e9, swapusage: "", dfHome: "" };
    const limit = swapGrowthLimitBytes({ SS_SWAP_GROWTH_LIMIT_GB: "6" });
    expect(guardViolation(base, { ...base, swapUsedBytes: 6.9e9 }, limit)).toBeNull();
    expect(guardViolation(base, { ...base, swapUsedBytes: 7.1e9 }, limit)).toMatch(/swap grew by 6\.10 GB \(limit 6 GB\)/);
    expect(guardViolation(base, { ...base, swapUsedBytes: 3.1e9 }, swapGrowthLimitBytes({}))).toMatch(/limit 2 GB/);
    expect(guardViolation(base, { ...base, freeDiskBytes: 5.9e9 }, limit)).toMatch(/free disk 5\.90 GB is under 6 GB/);
  });

  it("runs fewer sequences than the profile only when the operator asks, never more", () => {
    expect(decodeConcurrency("lab", null)).toBe(3);
    expect(decodeConcurrency("lab", 1)).toBe(1);
    expect(() => decodeConcurrency("lab", 4)).toThrow(/1 to 3/);
    expect(() => decodeConcurrency("agent", 0)).toThrow(/1 to 1/);
    const args = mlxArgs("lab", 1);
    expect(args[args.indexOf("--decode-concurrency") + 1]).toBe("1");
  });
});

import { parseVmStatAvailable } from "../../scripts/lib/guards.ts";

describe("27B pre-flight", () => {
  it("counts free, inactive, speculative and purgeable pages as available", () => {
    const vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:  100.\nPages active: 999.\nPages inactive: 50.\nPages speculative: 10.\nPages wired down: 7.\nPages purgeable: 5.\n";
    expect(parseVmStatAvailable(vm)).toBe((100 + 50 + 10 + 5) * 16384);
  });
});

describe("measured W", () => {
  it("refuses 4 Lab sequences and accepts 3 with the measured 15.7 GB", () => {
    expect(checkBudget({ nSeq: 4, ctxTokens: 2300, promptCacheBytes: 512e6 }).ok).toBe(false);
    expect(checkBudget(PROFILES.lab).ok).toBe(true);
    expect(PROFILES.lab.nSeq).toBe(3);
  });
});
