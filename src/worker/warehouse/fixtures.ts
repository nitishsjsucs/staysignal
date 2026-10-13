// Fixtures warehouse: answers published-layer reads from committed API fixtures exported by the engine
// (`staysignal demo build`). Used by CI, e2e, Playwright and the fixtures-mode deployment (no Google resource).
import { canonicalJson } from "../../shared/canonical-json";
import type { ActionAuditDoc, CatalogRequest, CatalogResult, ChangesFixture, EvaluationFixture, ForecastFixture, HistoryFixture, LabDoc, LabIndex, MemoryCommit, MemoryFileDoc, MemoryFileInfo, ProfilesFixture, QualityFixture, ResearchDoc, RunsIndex } from "../../shared/contracts";
import { type MemoryFileText, type MemoryHit, parseNote, searchMemory } from "../../shared/memory/search";
import { sha256Hex } from "../../shared/sha256";
import type { LineageFixture, WarehouseClient } from "../../shared/tools/registry";
import { FIXTURES } from "../generated/fixtures-index";

export function slug(runId: string): string {
  return runId.replace("#", "-");
}

/** The fixture name of a catalog request: 16 hex characters of SHA-256 over its canonical JSON (the engine's export,
 * `staysignal semantic export-fixtures`, names files the same way). */
export function catalogFixtureId(key: string, request: CatalogRequest): string {
  return sha256Hex(canonicalJson({ key, request })).slice(0, 16);
}

/** The demo memory exported by `staysignal memory export-fixture`. */
export interface MemoryFixture {
  label: "synthetic";
  aliases: Record<string, string[]>;
  files: Record<string, MemoryFileText>;
  index: MemoryFileInfo[];
  log: MemoryCommit[];
  parity: { query: string; hits: MemoryHit[] }[];
}

export class FixturesWarehouse implements WarehouseClient {
  readonly mode = "fixtures" as const;

  private get<T>(path: string): T | null {
    return (FIXTURES[path] as T | undefined) ?? null;
  }

  async runs(): Promise<RunsIndex> {
    const r = this.get<RunsIndex>("runs.json");
    if (!r) throw new Error("fixtures: runs.json missing");
    return r;
  }

  async forecast(runId: string): Promise<ForecastFixture | null> {
    return this.get<ForecastFixture>(`forecast/${slug(runId)}.json`);
  }

  async history(): Promise<HistoryFixture | null> {
    return this.get<HistoryFixture>("history.json");
  }

  async changes(fromRun: string, toRun: string): Promise<ChangesFixture | null> {
    return this.get<ChangesFixture>(`changes/${slug(fromRun)}__${slug(toRun)}.json`);
  }

  async quality(): Promise<QualityFixture | null> {
    return this.get<QualityFixture>("quality.json");
  }

  async lineage(): Promise<LineageFixture | null> {
    return this.get<LineageFixture>("lineage.json");
  }

  async profiles(runId: string): Promise<ProfilesFixture | null> {
    return this.get<ProfilesFixture>(`profiles/${slug(runId)}.json`);
  }

  async evaluation(): Promise<EvaluationFixture | null> {
    return this.get<EvaluationFixture>("evaluation.json");
  }

  /** Catalog results exported from the canonical warehouse for the requests the tools make by default; any other
   * request is unavailable in fixtures mode (null), never computed here. */
  async catalog(key: string, request: CatalogRequest): Promise<CatalogResult | null> {
    return this.get<CatalogResult>(`catalog/${catalogFixtureId(key, request)}.json`);
  }

  /** The committed memory export: what the production memory store starts from (SPEC 14.10). */
  memoryFixture(): MemoryFixture | null {
    return this.memory();
  }

  private memory(): MemoryFixture | null {
    return this.get<MemoryFixture>("memory.json");
  }

  async memoryFiles(): Promise<MemoryFileInfo[] | null> {
    return this.memory()?.index ?? null;
  }

  async memoryFile(path: string): Promise<MemoryFileDoc | null> {
    const f = this.memory()?.files[path];
    if (!f || !path.endsWith(".md")) return null;
    return { path, ...parseNote(f.text), commit: f.commit, date: f.date };
  }

  async memoryLog(): Promise<MemoryCommit[] | null> {
    return this.memory()?.log ?? null;
  }

  /** The same search as the engine's `git grep` over the exported memory (shared/memory/search.ts). */
  async memorySearch(query: string): Promise<MemoryHit[] | null> {
    const m = this.memory();
    return m ? searchMemory(m.files, m.aliases, query) : null;
  }

  async actionAudit(): Promise<ActionAuditDoc | null> {
    return this.get<ActionAuditDoc>("action-audit.json");
  }

  async research(): Promise<ResearchDoc | null> {
    return this.get<ResearchDoc>("research.json");
  }

  /** Engine job outputs keyed by job key (the fixture runner's source; SPEC 14.7). */
  job(jobKey: string): unknown {
    return this.get(`jobs/${jobKey}.json`);
  }

  async labIndex(): Promise<LabIndex | null> {
    return this.get<LabIndex>("lab/index.json");
  }

  async lab(proposal: string): Promise<LabDoc | null> {
    if (!/^[a-z0-9-]{3,60}$/.test(proposal)) return null;
    return this.get<LabDoc>(`lab/${proposal}.json`);
  }
}
