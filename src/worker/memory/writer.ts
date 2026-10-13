// The agent's memory writes (SPEC 14.10). Locally the engine commits the note to the git memory at `var/memory`,
// accepting the write only with the runner token, so only the Worker's agent writes. A fixtures deployment serves the
// committed memory and has no writable store yet (the SQLite store of 14.10 is not built), so the write is skipped and
// the routine says so. A failed write never fails the routine: memory is a record of the work, not part of it.
import type { MemoryNoteInput, MemoryWriteOutcome } from "../../shared/contracts";
import { parseConfig } from "../config";

export async function writeMemoryNote(env: Env, note: MemoryNoteInput, at: string): Promise<MemoryWriteOutcome> {
  const cfg = parseConfig(env);
  if (cfg.dataMode !== "engine") return { written: false, reason: "fixtures mode serves the committed memory read-only" };
  if (!cfg.runnerToken) return { written: false, reason: "no runner token configured" };
  try {
    const r = await fetch(`${cfg.engineUrl}/memory/note`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.runnerToken}` },
      body: JSON.stringify({ ...note, at }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      const detail = ((await r.json().catch(() => null)) as { detail?: string } | null)?.detail;
      return { written: false, reason: `engine refused the note (${r.status}${detail ? `: ${detail}` : ""})` };
    }
    const out = (await r.json()) as { id: string | null; commit: string | null; files: string[] };
    return { written: true, id: out.id, commit: out.commit, files: out.files };
  } catch (e) {
    return { written: false, reason: `engine unreachable (${e instanceof Error ? e.message : String(e)})` };
  }
}
