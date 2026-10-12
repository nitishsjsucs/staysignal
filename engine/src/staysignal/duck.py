"""One DuckDB connection configuration per process (ADR 0012).

`open_duckdb` is the only way the engine opens a warehouse file: read-write, `TimeZone=UTC`. Opening the same file a
second time in one process with any other configuration raises in DuckDB 1.5, so every component (ingest, dbt in
process, the warehouse shim, lineage capture) shares the connection it returns. Replays build in their own files.
"""

from __future__ import annotations

from pathlib import Path

import duckdb

CONFIG = {"TimeZone": "UTC"}


def open_duckdb(path: Path | str) -> duckdb.DuckDBPyConnection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    return duckdb.connect(str(path), read_only=False, config=dict(CONFIG))
