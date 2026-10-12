// Engine warehouse shim client (SPEC 7.2, ADR 0012): the local engine on 8196 answers published-layer reads from
// compiled catalog entries on its DuckDB connection. Same contract as the fixtures client.
import type { ChangesFixture, ForecastFixture, HistoryFixture, ProfilesFixture, QualityFixture, RunsIndex } from "../../shared/contracts";
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
}
