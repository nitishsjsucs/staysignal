// C33 and SPEC 14.10: the memory answers "what did we decide last time?" through the search_memory tool and the API;
// the fixtures mode's TypeScript search returns exactly what the engine's git grep search returned for the exported
// memory; People Partners do not read other organizations' group notes.
import { describe, expect, it } from "vitest";
import type { MemorySearchData } from "../../src/shared/contracts";
import { searchMemory } from "../../src/shared/memory/search";
import { FIXTURES } from "../../src/worker/generated/fixtures-index";
import type { MemoryFixture } from "../../src/worker/warehouse/fixtures";
import { json, P } from "../helpers/api";

type Res = { refused?: boolean; code?: string; result_id?: string; data?: MemorySearchData };
type Turn = { grounding: string; tool_calls: { tool: string }[]; rendered: string };

describe("memory", () => {
  it("returns the engine's search results for every parity query (TypeScript search over the export)", () => {
    const m = FIXTURES["memory.json"] as MemoryFixture;
    expect(m.parity.length).toBeGreaterThanOrEqual(6);
    for (const p of m.parity) expect(searchMemory(m.files, m.aliases, p.query)).toEqual(p.hits);
  });

  it("answers what was decided about fixed-term employees, with the note's path, commit and date", async () => {
    const r = await json<Res>(`/api/memory/search?q=${encodeURIComponent("What did we decide last time about fixed-term employees?")}`, { as: P.analyst });
    expect(r.result_id).toMatch(/^res_/);
    const top = r.data!.hits[0]!;
    expect(top.path).toBe("decisions/DEC-2026-09-20-01.md");
    expect(top.snippet).toContain("voluntary_departures@2");
    expect(top.commit).toMatch(/^[0-9a-f]{16}$/);
  });

  it("routes a memory question through the agent with grounded narration", async () => {
    const t = await json<Turn>("/api/dev/agent/turn", { as: P.analyst, body: { question: "What did we decide last time about fixed-term employees?" } });
    expect(t.tool_calls[0]?.tool).toBe("search_memory");
    expect(t.grounding).toBe("passed");
    expect(t.rendered).toContain("DEC-2026-09-20-01");
  });

  it("scopes People Partners to their organizations' group notes and refuses roles without memory", async () => {
    const eng = await json<Res>(`/api/memory/search?q=${encodeURIComponent("hiring coverage commercial")}`, { as: P.hrbpEng });
    expect(eng.data!.hits.some((h) => h.path.startsWith("teams/sales/"))).toBe(false);
    const gtm = await json<Res>(`/api/memory/search?q=${encodeURIComponent("hiring coverage commercial")}`, { as: P.hrbpGtm });
    expect(gtm.data!.hits[0]?.path).toBe("teams/sales/commercial-sales.md");
    expect((await json<Res>("/api/memory/search?q=fixed-term", { as: P.dataEng })).code).toBe("NOT_PERMITTED");
    const files = await json<{ files: { path: string }[] }>("/api/memory/files", { as: P.hrbpEng });
    expect(files.files.some((f) => f.path.startsWith("teams/sales/"))).toBe(false);
    expect((await json<{ code?: string }>("/api/memory/file?path=teams/sales/commercial-sales.md", { as: P.hrbpEng })).code).toBe("NOT_PERMITTED");
  });

  it("serves the timeline tiers and the commit log", async () => {
    const files = await json<{ files: { path: string; commit: string }[] }>("/api/memory/files", { as: P.analyst });
    const paths = files.files.map((f) => f.path);
    expect(paths).toContain("timeline/monthly/2026-07.md");
    expect(paths).toContain("timeline/weekly/2026-W38.md");
    const log = await json<{ commits: { message: string }[] }>("/api/memory/log", { as: P.analyst });
    expect(log.commits.map((c) => c.message)).toEqual(["memory: coarsen the timeline as of 2026-10-05", "memory: seed"]);
    const doc = await json<{ bullets: { date: string }[]; meta: { id: string } }>("/api/memory/file?path=decisions/DEC-2026-09-20-01.md", { as: P.analyst });
    expect(doc.meta.id).toBe("DEC-2026-09-20-01");
    expect(doc.bullets[0]!.date).toBe("2026-09-20");
  });
});
