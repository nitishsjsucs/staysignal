// npm run stop: stops every process recorded in var/pids and every staysignal-* Docker container (SPEC 22.3).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stopAll } from "./lib/pids.ts";

export async function stop(): Promise<string[]> {
  const stopped = await stopAll(8000);
  try {
    const ids = execFileSync("docker", ["ps", "-q", "--filter", "name=staysignal-"], { encoding: "utf8" }).trim();
    if (ids) execFileSync("docker", ["stop", ...ids.split("\n")], { stdio: "inherit" });
  } catch {
    // docker not running: nothing to stop
  }
  return stopped;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const s = await stop();
  console.log(`[stop] stopped ${s.join(", ") || "nothing"}`);
}
