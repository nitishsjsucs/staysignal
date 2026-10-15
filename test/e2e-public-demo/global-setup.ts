// Builds the app and starts wrangler dev (8795) as the public demo over https (ADR 0018). The Vite build empties dist/,
// which holds wrangler's local Durable Object state, so every run starts with no sandbox. SS_E2E_REUSE=1 runs against
// a server that is already up instead.
import { serve } from "../../scripts/serve.ts";
import { PORTS, portOpen } from "../../scripts/lib/pids.ts";

export default async function globalSetup(): Promise<void> {
  if (process.env.SS_E2E_REUSE === "1" && (await portOpen(PORTS.worker))) return;
  await serve({ build: true, publicDemo: true, https: true, llm: "stub", dataMode: "fixtures" });
}
