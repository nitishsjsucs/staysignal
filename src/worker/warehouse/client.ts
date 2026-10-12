// The Worker's warehouse client (SPEC 7.3, 18): fixtures (committed API fixtures; CI and the fixtures deployment), the
// engine shim locally (catalog entries on the engine's DuckDB connection), BigQuery REST in production.
import type { WarehouseClient } from "../../shared/tools/registry";
import { parseConfig } from "../config";
import { EngineWarehouse } from "./engine-shim";
import { FixturesWarehouse } from "./fixtures";

let fixtures: FixturesWarehouse | null = null;

export function warehouseFor(env: Env): WarehouseClient {
  const cfg = parseConfig(env);
  if (cfg.dataMode === "engine") return new EngineWarehouse(cfg.engineUrl);
  if (!fixtures) fixtures = new FixturesWarehouse();
  return fixtures;
}
