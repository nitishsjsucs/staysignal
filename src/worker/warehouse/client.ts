// The Worker's warehouse client (SPEC 7.3, 18): fixtures (committed API fixtures; CI and the fixtures deployment), the
// engine shim locally (catalog entries on the engine's DuckDB connection), BigQuery REST in production. The memory
// (SPEC 14.10) is the engine's git repository in engine mode and the WorkspaceAgent's git-style store otherwise, so
// the agent's writes are read back everywhere.
import type { MemoryCommit, MemoryFileDoc, MemoryFileInfo } from "../../shared/contracts";
import type { MemoryHit } from "../../shared/memory/search";
import type { WarehouseClient } from "../../shared/tools/registry";
import { type WorkspaceRef, workspaceRef } from "../agents/workspace-port";
import { parseConfig } from "../config";
import { BigQueryWarehouse } from "./bigquery";
import { EngineWarehouse } from "./engine-shim";
import { FixturesWarehouse } from "./fixtures";

export interface MemoryPort {
  memoryFiles(): Promise<MemoryFileInfo[] | null>;
  memoryFile(path: string): Promise<MemoryFileDoc | null>;
  memoryLog(): Promise<MemoryCommit[] | null>;
  memorySearch(query: string): Promise<MemoryHit[] | null>;
}

let fixtures: FixturesWarehouse | null = null;
let bigquery: BigQueryWarehouse | null = null; // one per isolate, so its access token is reused

/** The memory of a workspace (the shared one, or a visitor's sandbox in the public demo) over RPC. */
export function memoryPort(ref: WorkspaceRef): MemoryPort {
  return {
    memoryFiles: async () => (await (await ref()).memoryFilesLocal()) as unknown as MemoryFileInfo[],
    memoryFile: async (path) => (await (await ref()).memoryFileLocal(path)) as unknown as MemoryFileDoc | null,
    memoryLog: async () => (await (await ref()).memoryLogLocal()) as unknown as MemoryCommit[],
    memorySearch: async (q) => (await (await ref()).memorySearchLocal(q)) as unknown as MemoryHit[],
  };
}

/** `memory` says where the memory lives: the WorkspaceAgent passes its own methods to avoid calling itself, requests
 * pass their workspace (memoryPort); the default is the shared workspace. */
export function warehouseFor(env: Env, memory?: MemoryPort): WarehouseClient {
  const cfg = parseConfig(env);
  if (cfg.dataMode === "engine") return new EngineWarehouse(cfg.engineUrl);
  const base: WarehouseClient = cfg.bigquery ? (bigquery ??= new BigQueryWarehouse(cfg.bigquery)) : (fixtures ??= new FixturesWarehouse());
  return Object.assign(Object.create(base) as WarehouseClient, memory ?? memoryPort(workspaceRef(env)));
}
