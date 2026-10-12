// Fixtures warehouse: answers published-layer reads from committed API fixtures exported by the engine
// (`staysignal demo build`). Used by CI, e2e, Playwright and the fixtures-mode deployment (no Google resource).
import { canonicalJson } from "../../shared/canonical-json";
import type { CatalogRequest, CatalogResult, ChangesFixture, EvaluationFixture, ForecastFixture, HistoryFixture, ProfilesFixture, QualityFixture, RunsIndex } from "../../shared/contracts";
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

  /** Engine job outputs keyed by job key (the fixture runner's source; SPEC 14.7). */
  job(jobKey: string): unknown {
    return this.get(`jobs/${jobKey}.json`);
  }
}
