// SPEC 14.10, production memory: "git-style history, not git". The WorkspaceAgent's store starts from the committed
// memory export with its history, takes the agent's writes as git-style commits (git's blob hashes; simplified tree
// and commit hashes chained to their parent), and serves them through the same memory API and search.
import { env } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { parseAliases } from "../../src/shared/memory/search";
import { blobHash } from "../../src/worker/memory/githash";
import { FIXTURES } from "../../src/worker/generated/fixtures-index";
import type { MemoryFixture } from "../../src/worker/warehouse/fixtures";
import { json, P } from "../helpers/api";

const fx = FIXTURES["memory.json"] as MemoryFixture;

describe("the git-style memory store", () => {
  it("hashes blobs as git does and reads the alias table as the engine does", async () => {
    expect(await blobHash("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a"); // git hash-object
    expect(parseAliases(fx.files["index/aliases.yml"]!.text)).toEqual(fx.aliases);
  });

  it("starts from the committed memory with its history", async () => {
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "store-a");
    const files = (await ws.memoryFilesLocal()) as unknown as { path: string; commit: string }[];
    expect(files.map((f) => f.path).sort()).toEqual(fx.index.map((f) => f.path).sort());
    const log = (await ws.memoryLogLocal()) as unknown as { commit: string; message: string }[];
    expect(log).toEqual(fx.log.map((c) => expect.objectContaining({ commit: c.commit, message: c.message })));
  });

  it("commits the agent's notes, chains them, reads them back and refuses a person", async () => {
    const ws = await getAgentByName(env.WORKSPACE_AGENT, "store-b");
    const at = "2026-10-06T09:00:00Z";
    const a = (await ws.memoryWriteLocal({ kind: "investigation", title: "Run held by check C01", bullets: ["Check C01 failed on payroll (synthetic)."] }, at)) as unknown as { written: boolean; id: string; commit: string; files: string[] };
    expect(a).toMatchObject({ written: true, id: "INV-2026-10-06-01", files: ["investigations/INV-2026-10-06-01.md", "timeline/daily/2026-10-06.md"] });
    expect(a.commit).toMatch(/^[0-9a-f]{16}$/);
    const again = (await ws.memoryWriteLocal({ kind: "investigation", id: "INV-2026-10-06-01", title: "Run held by check C01", bullets: ["Check C01 failed on payroll (synthetic)."] }, at)) as unknown as { commit: string | null };
    expect(again.commit).toBeNull(); // nothing changed, no empty commit
    const b = (await ws.memoryWriteLocal({ kind: "timeline", bullets: ["Replay matched (synthetic)."] }, "2026-10-06T10:00:00Z")) as unknown as { commit: string };
    const log = (await ws.memoryLogLocal()) as unknown as { commit: string; message: string; files: string[] }[];
    expect(log.slice(0, 2).map((c) => c.commit)).toEqual([b.commit, a.commit]);
    expect(log[0]!.message).toBe("memory: timeline 2026-10-06");
    const doc = (await ws.memoryFileLocal("timeline/daily/2026-10-06.md")) as unknown as { bullets: { text: string }[]; commit: string };
    expect(doc.bullets.map((x) => x.text)).toEqual(["INV-2026-10-06-01: Run held by check C01", "Replay matched (synthetic)."]);
    expect(doc.commit).toBe(b.commit);
    const hits = (await ws.memorySearchLocal("what did we find about check C01 on payroll")) as unknown as { path: string }[];
    expect(hits[0]?.path).toBe("investigations/INV-2026-10-06-01.md");
    const refused = (await ws.memoryWriteLocal({ kind: "timeline", bullets: ["E104233 resigned."] }, at)) as unknown as { written: boolean; reason: string };
    expect(refused).toEqual({ written: false, reason: "a memory note never names a person (cohort-level content only)" });
  });

  it("serves the store through the memory API and the search_memory tool", async () => {
    const r = await json<{ data: { hits: { path: string }[] } }>(`/api/memory/search?q=${encodeURIComponent("What did we decide last time about fixed-term employees?")}`, { as: P.analyst });
    expect(r.data.hits[0]?.path).toBe("decisions/DEC-2026-09-20-01.md");
  });
});
