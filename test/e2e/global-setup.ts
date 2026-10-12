// Builds the app and starts wrangler dev (8795) with the stub model. Fixtures mode (default) adds the fixture runner;
// SS_E2E_DATA_MODE=engine prepares a fresh local engine state (staysignal engine prepare --fresh) and starts the engine
// on 8196, so every routine job is computed live. The Vite build empties dist/, which holds wrangler's local Durable
// Object state, so every run starts from the demo's initial state. SS_E2E_REUSE=1 runs against a server that is
// already up instead.
import { execFileSync } from "node:child_process";
import { serve } from "../../scripts/serve.ts";
import { PORTS, portOpen } from "../../scripts/lib/pids.ts";

export default async function globalSetup(): Promise<void> {
  if (process.env.SS_E2E_REUSE === "1" && (await portOpen(PORTS.worker))) return;
  const engine = process.env.SS_E2E_DATA_MODE === "engine";
  if (engine) execFileSync("uv", ["run", "--project", "engine", "staysignal", "engine", "prepare", "--fresh"], { stdio: "inherit" });
  await serve({ build: true, llm: "stub", dataMode: engine ? "engine" : "fixtures" });
}
