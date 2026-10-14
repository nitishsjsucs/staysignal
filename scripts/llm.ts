// npm run llm -- start 27b [--profile agent|lab] [--decode-concurrency N] [--allow-swap] | start 1.7b | stop | status
// Guarded local LLM lifecycle (SPEC 15.10): one LLM server at a time; refuses the 27B while a Docker build or the
// test suite runs and when the memory estimate exceeds 17.2 GB; records `sysctl vm.swapusage` and `df -h ~` before
// and after; a detached guard stops the server if swap grows by more than 2 GB or free disk drops under 6 GB.
// Operator overrides for a low-memory run, each recorded in var/llm/session.json: `--allow-swap` skips the 17 GB
// available-memory pre-flight, `SS_SWAP_GROWTH_LIMIT_GB` raises or lowers the 2 GB swap growth limit (the 6 GB
// free-disk floor stays), and `--decode-concurrency N` runs fewer sequences than the profile (1 to the profile's).
// Never downloads weights: the 27B runs with HF_HUB_OFFLINE=1 and requests always name `default_model`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { availableMemoryBytes, guardViolation, heavyWorkRunning, type MachineReading, MIN_AVAILABLE_FOR_27B_BYTES, readMachine, swapGrowthLimitBytes } from "./lib/guards.ts";
import { checkBudget, PROFILES, type ProfileName } from "./lib/memory-budget.ts";
import { PORTS, portOpen, readPidFiles, REPO_ROOT, startGroup, stopAll, waitForHttp } from "./lib/pids.ts";

const MODELS_DIR = path.join(os.homedir(), "Developer", "projects", "_models");
export const MLX_SERVER = path.join(MODELS_DIR, "mlx-venv", "bin", "mlx_lm.server");
export const MODEL_27B = "mlx-community/Qwen3.6-27B-4bit";
export const GGUF_17B = path.join(MODELS_DIR, "Qwen3-1.7B-Q4_0-rtn.gguf");
const STATE_DIR = path.join(REPO_ROOT, "var", "llm");
const SESSION = path.join(STATE_DIR, "session.json");

export interface Session {
  model: "27b" | "1.7b";
  profile: ProfileName | null;
  args: string[];
  before: MachineReading;
  /** The swap growth limit the guard applies (2 GB unless SS_SWAP_GROWTH_LIMIT_GB overrides it). */
  swapLimitBytes?: number;
  /** The available memory at start, by `availableMemoryBytes()`, and whether `--allow-swap` skipped the pre-flight. */
  availableBytes?: number;
  allowSwap?: boolean;
  startedAt: string;
  healthyAt: string | null;
  stoppedBy: string | null;
  after: MachineReading | null;
}

/** The decode concurrency for a profile: the profile's, or an operator's `--decode-concurrency N` between 1 and it. */
export function decodeConcurrency(profile: ProfileName, requested: number | null): number {
  const max = PROFILES[profile].nSeq;
  if (requested === null) return max;
  if (!Number.isInteger(requested) || requested < 1 || requested > max) throw new Error(`--decode-concurrency must be 1 to ${max} for the ${profile} profile`);
  return requested;
}

export function mlxArgs(profile: ProfileName, nSeq: number = PROFILES[profile].nSeq): string[] {
  const p = PROFILES[profile];
  return [
    "--model", MODEL_27B, "--host", "127.0.0.1", "--port", String(PORTS.mlx),
    "--decode-concurrency", String(nSeq), "--prompt-concurrency", "1",
    "--prompt-cache-size", String(p.promptCacheSize), "--prompt-cache-bytes", String(p.promptCacheBytes),
    "--chat-template-args", JSON.stringify({ enable_thinking: false }),
    ...(p.prefillStepSize ? ["--prefill-step-size", String(p.prefillStepSize)] : []),
    ...(p.kvBits ? ["--kv-bits", String(p.kvBits)] : []),
  ];
}

export function llamaArgs(): string[] {
  return ["-m", GGUF_17B, "--host", "127.0.0.1", "--port", String(PORTS.llama), "-np", "1", "-c", "8192", "-ngl", "99"];
}

function readSession(): Session | null {
  return existsSync(SESSION) ? (JSON.parse(readFileSync(SESSION, "utf8")) as Session) : null;
}

function writeSession(s: Session): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SESSION, JSON.stringify(s, null, 2) + "\n");
}

export async function start(model: "27b" | "1.7b", profile: ProfileName, nSeqRequested: number | null = null): Promise<void> {
  if ((await portOpen(PORTS.mlx)) || (await portOpen(PORTS.llama))) throw new Error("an LLM server is already listening on 8186 or 8187; run `npm run llm -- stop` first");
  const before = readMachine();
  const swapLimitBytes = swapGrowthLimitBytes();
  const allowSwap = process.argv.includes("--allow-swap");
  const nSeq = decodeConcurrency(profile, nSeqRequested);
  const availableBytes = availableMemoryBytes();
  if (model === "27b") {
    const heavy = heavyWorkRunning();
    if (heavy.length) throw new Error(`refusing the 27B while heavy work runs: ${heavy.join(", ")}`);
    const budget = checkBudget({ ...PROFILES[profile], nSeq });
    if (!budget.ok) throw new Error(`refusing: memory estimate ${budget.estimateGb} GB exceeds ${budget.limitGb} GB`);
    if (!existsSync(MLX_SERVER)) throw new Error(`mlx_lm.server not found at ${MLX_SERVER}`);
    if (availableBytes < MIN_AVAILABLE_FOR_27B_BYTES && !allowSwap) {
      throw new Error(`refusing the 27B: ${(availableBytes / 1e9).toFixed(1)} GB of memory available, ${(MIN_AVAILABLE_FOR_27B_BYTES / 1e9).toFixed(0)} GB needed without swapping; close other apps (browsers, chat apps) and retry`);
    }
  } else if (!existsSync(GGUF_17B)) {
    throw new Error(`model file not found: ${GGUF_17B}`);
  }
  const args = model === "27b" ? mlxArgs(profile, nSeq) : llamaArgs();
  const session: Session = { model, profile: model === "27b" ? profile : null, args, before, swapLimitBytes, availableBytes, allowSwap, startedAt: new Date().toISOString(), healthyAt: null, stoppedBy: null, after: null };
  writeSession(session);
  if (model === "27b") {
    startGroup("llm-27b", MLX_SERVER, args, { port: PORTS.mlx, env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
  } else {
    startGroup("llm-1.7b", "llama-server", args, { port: PORTS.llama });
  }
  startGroup("llm-guard", process.execPath, [fileURLToPath(import.meta.url), "guard"], { port: null });
  const url = model === "27b" ? `http://127.0.0.1:${PORTS.mlx}/health` : `http://127.0.0.1:${PORTS.llama}/health`;
  const ok = await waitForHttp(url, 300_000);
  if (!ok) {
    await stop("not healthy within 300 s");
    throw new Error("server did not become healthy; see var/logs/");
  }
  session.healthyAt = new Date().toISOString();
  writeSession(session);
  console.log(`[llm] ${model} healthy on ${url.replace("/health", "")}; ${(availableBytes / 1e9).toFixed(1)} GB available at start${allowSwap ? " (--allow-swap)" : ""}; swap growth limit ${swapLimitBytes / 1e9} GB; swap before ${before.swapusage}; disk ${before.dfHome}`);
}

export async function stop(reason = "requested"): Promise<Session | null> {
  const stopped = await stopAll(8000, ["llm-27b", "llm-1.7b", "llm-guard"]);
  const s = readSession();
  if (s && !s.after) {
    s.after = readMachine();
    s.stoppedBy = s.stoppedBy ?? reason;
    writeSession(s);
  }
  console.log(`[llm] stopped ${stopped.join(", ") || "nothing"}${s?.after ? `; swap after ${s.after.swapusage}; disk ${s.after.dfHome}` : ""}`);
  return s;
}

async function guard(): Promise<void> {
  const s = readSession();
  if (!s) return;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const running = readPidFiles().some((p) => p.name === "llm-27b" || p.name === "llm-1.7b");
    if (!running) return;
    const v = guardViolation(s.before, readMachine(), s.swapLimitBytes ?? swapGrowthLimitBytes());
    if (v) {
      const cur = readSession();
      if (cur) {
        cur.stoppedBy = `guard: ${v}`;
        writeSession(cur);
      }
      await stopAll(8000, ["llm-27b", "llm-1.7b"]);
      const after = readSession();
      if (after) {
        after.after = readMachine();
        writeSession(after);
      }
      return;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, model] = process.argv.slice(2);
  const profileFlag = process.argv.indexOf("--profile");
  const profile = (profileFlag > 0 ? process.argv[profileFlag + 1] : "agent") as ProfileName;
  const ncFlag = process.argv.indexOf("--decode-concurrency");
  const nSeq = ncFlag > 0 ? Number(process.argv[ncFlag + 1]) : null;
  try {
    if (cmd === "start" && (model === "27b" || model === "1.7b")) await start(model, profile in PROFILES ? profile : "agent", nSeq);
    else if (cmd === "stop") await stop();
    else if (cmd === "guard") await guard();
    else if (cmd === "status") console.log(JSON.stringify({ session: readSession(), pids: readPidFiles() }, null, 2));
    else {
      console.error("usage: npm run llm -- start 27b [--profile agent|lab] [--decode-concurrency N] [--allow-swap] | start 1.7b | stop | status");
      process.exit(2);
    }
  } catch (e) {
    console.error(`[llm] ${(e as Error).message}`);
    process.exit(1);
  }
}
