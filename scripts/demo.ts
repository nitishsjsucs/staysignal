// The demo profile and its per-beat snapshots (SPEC 22.4).
//   npm run demo                      the demo profile: built app under wrangler dev 8795, the local engine on 8196,
//                                     SS_DEMO=1; the recorded provider when recorded turns exist, otherwise the stub
//   npm run demo:snapshots            builds var/snapshots/beat-<N>/ by driving the routine through the API
//   npm run demo:reset [-- --beat N]  stops everything, restores the snapshot for the start of beat N (default 1),
//                                     restarts the demo profile and records the time it took with --record
// A snapshot holds the local Workers persistence (Durable Objects and Workflows), the warehouse file, the landing
// store, the engine's published documents and the memory repository. Beats 1 to 3 start from the same data state (beats 1 and 2 only ask
// questions; beat 3 starts the arrival), beat 4 starts with the run held and the mapping proposal waiting for a data
// engineer, and beat 5 starts after the repair, the publication of version 3 and its replay.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS } from "./lib/pids.ts";
import { serve } from "./serve.ts";
import { stop } from "./stop.ts";

const SNAPSHOTS = "var/snapshots";
const BASE = `http://127.0.0.1:${PORTS.worker}`;
const LEAD = "pa-lead@larkspur.example";
const DATA_ENG = "data-eng@larkspur.example";

/** What a snapshot holds, relative to the repository root. */
export const STATE_PATHS = ["dist/staysignal/.wrangler/state", "var/warehouse.duckdb", "var/landing", "var/engine/published", "var/memory"] as const;
/** The snapshot each beat starts from. */
export const BEAT_SNAPSHOT: Record<number, string> = { 1: "beat-1", 2: "beat-1", 3: "beat-1", 4: "beat-4", 5: "beat-5" };

function save(name: string): void {
  const dir = join(SNAPSHOTS, name);
  rmSync(dir, { recursive: true, force: true });
  for (const p of STATE_PATHS) {
    if (existsSync(p)) cpSync(p, join(dir, p), { recursive: true });
  }
  console.log(`[demo] saved ${dir}`);
}

function restore(name: string): void {
  const dir = join(SNAPSHOTS, name);
  if (!existsSync(dir)) throw new Error(`no snapshot ${dir}; run npm run demo:snapshots`);
  for (const p of STATE_PATHS) {
    rmSync(p, { recursive: true, force: true });
    rmSync(`${p}.wal`, { force: true });
    if (existsSync(join(dir, p))) cpSync(join(dir, p), p, { recursive: true });
  }
}

// counted from the directory: the generated index imports JSON, which Node cannot import without an attribute
function llmFor(): string {
  const recorded = existsSync(join("demo", "recordings")) && readdirSync(join("demo", "recordings")).some((f) => f.endsWith(".json"));
  return recorded ? "recorded" : "stub";
}

export async function startDemo(build: boolean): Promise<void> {
  await serve({ build, dataMode: "engine", llm: llmFor() });
  if (llmFor() === "stub") console.log("[demo] no recorded 27B turns yet: answers come from the stub model (labeled)");
}

const tokens = new Map<string, string>();
async function api<T>(path: string, principal: string, body?: unknown): Promise<T> {
  if (!tokens.has(principal)) {
    const r = await fetch(`${BASE}/dev/login?principal=${encodeURIComponent(principal)}`);
    tokens.set(principal, ((await r.json()) as { token: string }).token);
  }
  const r = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${tokens.get(principal)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 180_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

interface Incident { incident_id: string; status: string; run_id: string; resolved_by_run: string | null }
interface Approval { subject_id: string; status: string }

export async function buildSnapshots(): Promise<void> {
  await stop();
  execFileSync("uv", ["run", "--project", "engine", "staysignal", "engine", "prepare", "--fresh"], { stdio: "inherit" });
  execFileSync("npx", ["vite", "build"], { stdio: "inherit" });
  rmSync("dist/staysignal/.wrangler", { recursive: true, force: true });
  rmSync(SNAPSHOTS, { recursive: true, force: true });
  mkdirSync(SNAPSHOTS, { recursive: true });

  // beats 1 to 3: the initial state, with the WorkspaceAgent created and the published run known
  await startDemo(false);
  await api("/api/me", LEAD);
  await api("/api/runs", LEAD);
  await stop();
  save("beat-1");

  // beat 4: the September payroll has arrived, the candidate is held and the mapping proposal waits for approval
  await startDemo(false);
  await api("/api/demo/arrival", LEAD, {});
  await until("the mapping proposal", async () => (await api<{ approvals: Approval[] }>("/api/approvals", DATA_ENG)).approvals.find((a) => a.status === "pending"));
  await stop();
  save("beat-4");

  // beat 5: the data engineer approved the mapping; version 3 is published and its replay recorded
  await startDemo(false);
  const pending = (await api<{ approvals: Approval[] }>("/api/approvals", DATA_ENG)).approvals.find((a) => a.status === "pending");
  if (!pending) throw new Error("no pending mapping proposal after restoring beat 4");
  await api(`/api/approvals/${encodeURIComponent(pending.subject_id)}/approve`, DATA_ENG, { reason: null });
  await until("the repaired run", async () => (await api<{ incidents: Incident[] }>("/api/quality/checks", LEAD)).incidents.find((i) => i.resolved_by_run));
  await until("the replay of version 3", async () => (await api<{ replays: unknown[] }>(`/api/runs/${encodeURIComponent("R-2026-10-01#3")}/replays`, LEAD)).replays.length > 0);
  await stop();
  save("beat-5");
  writeFileSync(join(SNAPSHOTS, "manifest.json"), JSON.stringify({ label: "synthetic", snapshots: readdirSync(SNAPSHOTS).filter((d) => d.startsWith("beat-")), beats: BEAT_SNAPSHOT, built_at: new Date().toISOString() }, null, 2) + "\n");
}

export async function reset(beat: number, record: boolean): Promise<number> {
  const t0 = Date.now();
  await stop();
  restore(BEAT_SNAPSHOT[beat] ?? "beat-1");
  await startDemo(false);
  const ms = Date.now() - t0;
  console.log(`[demo] reset to the start of beat ${beat} in ${(ms / 1000).toFixed(1)} s`);
  if (record) {
    mkdirSync("results", { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(join("results", `demo-reset-${date}.json`), JSON.stringify({ kind: "demo-reset", label: "synthetic demo state", command: `npm run demo:reset -- --beat ${beat} --record`, date, beat, seconds: Math.round(ms / 100) / 10, target_seconds: 20 }, null, 2) + "\n");
  }
  return ms;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2] ?? "start";
  const i = process.argv.indexOf("--beat");
  const beat = i > 0 ? Number(process.argv[i + 1]) : 1;
  if (cmd === "snapshots") await buildSnapshots();
  else if (cmd === "reset") await reset(beat, process.argv.includes("--record"));
  else await startDemo(!existsSync("dist/staysignal/wrangler.json"));
}
