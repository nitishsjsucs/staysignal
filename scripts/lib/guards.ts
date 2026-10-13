// Machine guards for LLM runs (SPEC 15.10, 22.3): swap and free disk readings, and detection of work the 27B must
// never run beside (a Docker build or the full test suite).
import { execFileSync } from "node:child_process";
import os from "node:os";

export const SWAP_GROWTH_LIMIT_BYTES = 2e9;
export const MIN_FREE_DISK_BYTES = 6e9;

/** The swap growth limit for this run: 2 GB, or the operator's explicit override `SS_SWAP_GROWTH_LIMIT_GB` (a positive
 * number of GB), for a low-memory run with `--allow-swap` where a one-time eviction to swap is expected and the disk has
 * room for it. The free-disk floor (6 GB) is never overridden. */
export function swapGrowthLimitBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SS_SWAP_GROWTH_LIMIT_GB?.trim();
  if (!raw) return SWAP_GROWTH_LIMIT_BYTES;
  const gb = Number(raw);
  if (!Number.isFinite(gb) || gb <= 0) throw new Error(`SS_SWAP_GROWTH_LIMIT_GB must be a positive number of GB, got "${raw}"`);
  return gb * 1e9;
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** Parses `sysctl vm.swapusage` ("total = 7168.00M  used = 5999.06M  free = ..."). */
export function parseSwapUsage(text: string): { totalBytes: number; usedBytes: number } {
  const get = (key: string): number => {
    const m = new RegExp(`${key} = ([\\d.]+)([KMG])`).exec(text);
    if (!m || m[1] === undefined || m[2] === undefined) throw new Error(`cannot parse swap ${key} from: ${text}`);
    return Math.round(Number(m[1]) * (UNIT[m[2]] ?? 1));
  };
  return { totalBytes: get("total"), usedBytes: get("used") };
}

/** Parses the data line of `df -k <path>` into available bytes. */
export function parseDfAvailable(text: string): number {
  const lines = text.trim().split("\n");
  const cols = (lines[lines.length - 1] ?? "").trim().split(/\s+/);
  const avail = Number(cols[3]);
  if (!Number.isFinite(avail)) throw new Error(`cannot parse df output: ${text}`);
  return avail * 1024;
}

export interface MachineReading {
  at: string;
  swapUsedBytes: number;
  swapTotalBytes: number;
  freeDiskBytes: number;
  swapusage: string;
  dfHome: string;
}

export function readMachine(): MachineReading {
  const swapusage = os.platform() === "darwin" ? execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" }).trim() : "vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M";
  const dfK = execFileSync("df", ["-k", os.homedir()], { encoding: "utf8" });
  const dfHome = execFileSync("df", ["-h", os.homedir()], { encoding: "utf8" }).trim().split("\n").pop() ?? "";
  const swap = parseSwapUsage(swapusage);
  return { at: new Date().toISOString(), swapUsedBytes: swap.usedBytes, swapTotalBytes: swap.totalBytes, freeDiskBytes: parseDfAvailable(dfK), swapusage, dfHome };
}

/** Why an LLM run must stop now, or null. `swapLimitBytes` defaults to `swapGrowthLimitBytes()`. */
export function guardViolation(baseline: MachineReading, now: MachineReading, swapLimitBytes: number = swapGrowthLimitBytes()): string | null {
  const growth = now.swapUsedBytes - baseline.swapUsedBytes;
  if (growth > swapLimitBytes) return `swap grew by ${(growth / 1e9).toFixed(2)} GB (limit ${Number((swapLimitBytes / 1e9).toFixed(2))} GB)`;
  if (now.freeDiskBytes < MIN_FREE_DISK_BYTES) return `free disk ${(now.freeDiskBytes / 1e9).toFixed(2)} GB is under 6 GB`;
  return null;
}

/** Processes the 27B must never run beside. */
export function heavyWorkRunning(): string[] {
  const patterns = [
    "docker build", "docker buildx", "buildkitd", "playwright test", "vitest run", "pytest engine/tests",
    // the research arms run multi-process fits; a 27B load beside them grew swap by 2.18 GB on 2026-10-12
    "staysignal research run",
  ];
  const out: string[] = [];
  for (const p of patterns) {
    try {
      const r = execFileSync("pgrep", ["-f", p], { encoding: "utf8" }).trim();
      if (r) out.push(p);
    } catch {
      // pgrep exits 1 when nothing matches
    }
  }
  return out;
}

/** Memory the system can hand to a new process without swapping: free, inactive, speculative and purgeable pages
 * from `vm_stat`. */
export function parseVmStatAvailable(text: string): number {
  const page = Number(/page size of (\d+)/.exec(text)?.[1] ?? 16384);
  const pages = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page;
}

export function availableMemoryBytes(): number {
  if (os.platform() !== "darwin") return os.freemem();
  return parseVmStatAvailable(execFileSync("vm_stat", { encoding: "utf8" }));
}

/** Pre-flight for the 27B: without this much memory available the load itself pushes other apps into swap (on
 * 2026-10-12 two loads with 8.1 and 12.3 GB available grew swap by 2.2 and 5.0 GB before the guard stopped them). */
export const MIN_AVAILABLE_FOR_27B_BYTES = 17e9;
