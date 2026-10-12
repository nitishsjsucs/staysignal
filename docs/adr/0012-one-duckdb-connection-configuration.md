# ADR 0012: One DuckDB connection configuration per process

Status: accepted (2026-10-12). Extends PeopleLake ADR 0008 (MIT).

## Context
DuckDB allows one read-write process per file, and within a process it refuses a second connection with a different configuration: verified with duckdb 1.5.6, a `read_only=True` connection beside a read-write one raises "different configuration". The engine needs dbt builds, a query shim for the Worker and lineage capture against the same warehouse.

## Decision
The engine process opens `var/warehouse.duckdb` once with `open_duckdb` (read-write, `TimeZone=UTC`). dbt runs in process through `dbtRunner` with the same configuration. The warehouse shim answers the Worker with cursors from the engine connection, behind DataTrust's sqlglot single-SELECT guard, and executes only compiled catalog entries. Lineage is captured in process from dbt's `manifest.json` and `run_results.json`. Replays build in a separate file, `var/replay/<run_id>.duckdb`.

Fallback if in-process lineage does not match `dbt-ol`: close the connection under a job lock, run `dbt-ol build` as a subprocess, reopen, and answer shim queries with 503 "warehouse busy" meanwhile.

## Consequences
No second process ever opens the live warehouse. A test queries the shim while a dbt build runs and expects consistent results or a 503, never an error.

## Spike result (2026-10-12, M2)
`engine/tests/lineage/test_inprocess_lineage.py` builds a toy project twice: once with `dbt-ol build` in a subprocess (file transport) and once in process with `dbtRunner` while the engine's connection to the same file stays open, followed by the same `DbtLocalArtifactProcessor` that `dbt-ol` uses. The completed events, their inputs, outputs and column-lineage fields are equal apart from run IDs, times and the dataset namespace (which embeds the absolute file path), so the in-process path is kept and the subprocess fallback is not needed. Two conditions make it work: the dbt profile passes `TimeZone: UTC` under `config_options` (a connection option; under `settings` dbt opens the file with a different configuration and DuckDB refuses it), and no importable top-level module may be named `dbt_*`, because dbt's plugin manager imports every such module it finds on the path. Column lineage only resolves through CTEs that list their columns, so models on the paths the checks follow avoid `select *`.

