// Engine warehouse shim client (SPEC 7.2, ADR 0012): the local engine on 8196 answers published-layer reads from
// compiled catalog entries on its DuckDB connection. Same contract as the fixtures client.
import type { ActionAuditDoc, ResearchDoc, CatalogRequest, CatalogResult, ChangesFixture, EvaluationFixture, ForecastFixture, HistoryFixture, MemoryCommit, MemoryFileDoc, MemoryFileInfo, ProfilesFixture, QualityFixture, RunsIndex } from "../../shared/contracts";
import type { MemoryHit } from "../../shared/memory/search";
import type { LineageFixture, WarehouseClient } from "../../shared/tools/registry";

export class EngineWarehouse implements WarehouseClient {
  readonly mode = "engine" as const;
  constructor(private readonly base: string) {}

  private async get<T>(path: string): Promise<T | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(`${this.base}/published/${path}`);
      if (r.status === 404) return null;
      if (r.status === 503) {
        await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
        continue;
      }
      if (!r.ok) throw new Error(`engine shim ${path}: ${r.status}`);
      return (await r.json()) as T;
    }
    throw new Error("warehouse busy");
  }

  async runs(): Promise<RunsIndex> {
    const r = await this.get<RunsIndex>("runs");
    if (!r) throw new Error("engine has no runs");
    return r;
  }
  forecast(runId: string) {
    return this.get<ForecastFixture>(`forecast/${encodeURIComponent(runId)}`);
  }
  history() {
    return this.get<HistoryFixture>("history");
  }
  changes(fromRun: string, toRun: string) {
    return this.get<ChangesFixture>(`changes/${encodeURIComponent(fromRun)}/${encodeURIComponent(toRun)}`);
  }
  quality() {
    return this.get<QualityFixture>("quality");
  }
  lineage() {
    return this.get<LineageFixture>("lineage");
  }
  profiles(runId: string) {
    return this.get<ProfilesFixture>(`profiles/${encodeURIComponent(runId)}`);
  }
  evaluation() {
    return this.get<EvaluationFixture>("evaluation");
  }
  actionAudit() {
    return this.get<ActionAuditDoc>("action-audit");
  }
  research() {
    return this.get<ResearchDoc>("research");
  }

  private async memoryGet<T>(path: string): Promise<T | null> {
    const r = await fetch(`${this.base}/memory/${path}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`engine memory ${path}: ${r.status}`);
    return (await r.json()) as T;
  }

  async memoryFiles(): Promise<MemoryFileInfo[] | null> {
    return (await this.memoryGet<{ files: MemoryFileInfo[] }>("files"))?.files ?? null;
  }

  async memoryFile(path: string): Promise<MemoryFileDoc | null> {
    return this.memoryGet<MemoryFileDoc>(`file?path=${encodeURIComponent(path)}`);
  }

  async memoryLog(): Promise<MemoryCommit[] | null> {
    return (await this.memoryGet<{ commits: MemoryCommit[] }>("log"))?.commits ?? null;
  }

  async memorySearch(query: string): Promise<MemoryHit[] | null> {
    return (await this.memoryGet<{ hits: MemoryHit[] }>(`search?q=${encodeURIComponent(query)}`))?.hits ?? null;
  }

  /** POST /catalog/{key} on the engine: an entry key and parameter values, never SQL (SPEC 7.2). */
  async catalog(key: string, request: CatalogRequest): Promise<CatalogResult | null> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await fetch(`${this.base}/catalog/${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      if (r.status === 404) return null;
      if (r.status === 503) {
        await new Promise((res) => setTimeout(res, 250 * 2 ** attempt));
        continue;
      }
      if (!r.ok) throw new Error(`engine catalog ${key}: ${r.status}`);
      return (await r.json()) as CatalogResult;
    }
    throw new Error("warehouse busy");
  }
}
