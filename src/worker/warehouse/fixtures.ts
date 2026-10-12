// Fixtures warehouse: answers published-layer reads from committed API fixtures exported by the engine
// (`staysignal demo build`). Used by CI, e2e, Playwright and the fixtures-mode deployment (no Google resource).
import type { ChangesFixture, ForecastFixture, HistoryFixture, ProfilesFixture, QualityFixture, RunsIndex } from "../../shared/contracts";
import type { LineageFixture, WarehouseClient } from "../../shared/tools/registry";
import { FIXTURES } from "../generated/fixtures-index";

export function slug(runId: string): string {
  return runId.replace("#", "-");
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

  /** Engine job outputs keyed by job key (the fixture runner's source; SPEC 14.7). */
  job(jobKey: string): unknown {
    return this.get(`jobs/${jobKey}.json`);
  }
}
