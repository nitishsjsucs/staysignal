// Stops wrangler dev and the fixture runner unless the run reused a server it did not start.
import { stopAll } from "../../scripts/lib/pids.ts";

export default async function globalTeardown(): Promise<void> {
  if (process.env.SS_E2E_REUSE === "1") return;
  await stopAll(8000, ["wrangler", "fixture-runner"]);
}
