"""Appends landed extracts to the raw tables of the local warehouse (SPEC 7.1, ADR 0012).

Every raw table keeps the source columns as text (typing happens in staging) plus `_batch_id`, `_file_sha256`,
`_file_name` and `_loaded_at`. Loads are idempotent by file hash: `raw._loads` records each distinct file once, and a
re-delivered file appends nothing, following PeopleLake's replayable ingestion. Every delivery is still recorded in
`raw._deliveries` (file name, hash, delivery time), because two different deliveries can carry the same bytes (an
empty daily HRIS delta) and freshness (F01) is about deliveries, not contents. The audit-only attribute lands in the
isolated `audit` schema (ADR 0013).
"""

from __future__ import annotations

from datetime import datetime

import duckdb

from staysignal.ingest.landing import Landed
from staysignal.ingest.schemas import KINDS, FileKind, columns

LOADS_DDL = """
CREATE TABLE IF NOT EXISTS raw._loads (
  file_sha256 VARCHAR PRIMARY KEY,
  source VARCHAR NOT NULL,
  period VARCHAR NOT NULL,
  file_name VARCHAR NOT NULL,
  landed_path VARCHAR NOT NULL,
  rows_loaded INTEGER NOT NULL,
  batch_id VARCHAR NOT NULL,
  loaded_at TIMESTAMPTZ NOT NULL
)
"""

DELIVERIES_DDL = """
CREATE TABLE IF NOT EXISTS raw._deliveries (
  file_name VARCHAR NOT NULL,
  file_sha256 VARCHAR NOT NULL,
  source VARCHAR NOT NULL,
  period VARCHAR NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (file_name, file_sha256)
)
"""


def table_of(kind: FileKind) -> str:
    return f"{kind.raw_schema}.raw_{kind.source}"


def ensure_raw(con: duckdb.DuckDBPyConnection) -> None:
    con.execute("CREATE SCHEMA IF NOT EXISTS raw")
    con.execute("CREATE SCHEMA IF NOT EXISTS audit")
    con.execute(LOADS_DDL)
    con.execute(DELIVERIES_DDL)
    done: set[str] = set()
    for kind in KINDS:
        t = table_of(kind)
        if t in done:
            continue
        done.add(t)
        cols = ", ".join(f'"{c}" VARCHAR' for c in columns(kind))
        con.execute(
            f"CREATE TABLE IF NOT EXISTS {t} ({cols}, _batch_id VARCHAR NOT NULL, _file_sha256 VARCHAR NOT NULL, "
            "_file_name VARCHAR NOT NULL, _loaded_at TIMESTAMPTZ NOT NULL)"
        )


def batch_id(landed: Landed) -> str:
    return f"{landed.kind.source}:{landed.period}:{landed.sha256[:16]}"


def load(con: duckdb.DuckDBPyConnection, landed: Landed, loaded_at: datetime) -> bool:
    """Appends one landed file; returns False when that file was already loaded."""
    ensure_raw(con)
    con.execute(
        "INSERT INTO raw._deliveries VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [landed.name, landed.sha256, landed.kind.source, landed.period, loaded_at],
    )
    if con.execute("SELECT 1 FROM raw._loads WHERE file_sha256 = ?", [landed.sha256]).fetchone():
        return False
    header = _header(landed)
    select = ", ".join(f'"{c}"' if c in header else f'NULL AS "{c}"' for c in columns(landed.kind))
    bid = batch_id(landed)
    con.execute("BEGIN")
    try:
        con.execute(
            f"INSERT INTO {table_of(landed.kind)} SELECT {select}, ?, ?, ?, ? "
            "FROM read_csv(?, header = true, all_varchar = true, auto_detect = true)",
            [bid, landed.sha256, landed.name, loaded_at, str(landed.path)],
        )
        con.execute(
            "INSERT INTO raw._loads VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                landed.sha256,
                landed.kind.source,
                landed.period,
                landed.name,
                str(landed.path),
                landed.rows,
                bid,
                loaded_at,
            ],
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return True


def _header(landed: Landed) -> list[str]:
    with landed.path.open(encoding="utf-8") as f:
        return f.readline().rstrip("\r\n").split(",")


def loaded_files(con: duckdb.DuckDBPyConnection) -> list[tuple]:
    ensure_raw(con)
    return con.execute(
        "SELECT source, period, file_name, file_sha256, rows_loaded FROM raw._loads ORDER BY source, period, file_name"
    ).fetchall()


def ingest(con: duckdb.DuckDBPyConnection, paths: list, landing_root, default_loaded_at: datetime) -> list[dict]:
    """Lands and loads extracts in name order. Files with a `recorded_at` column are stamped with their delivery
    time on the synthetic clock (the newest `recorded_at`); reference files without one get `default_loaded_at`."""
    from staysignal.ingest.landing import land

    out = []
    for p in sorted(paths, key=lambda x: x.name):
        landed = land(p, landing_root)
        at = landed.arrived_at or default_loaded_at
        new = load(con, landed, at)
        out.append(
            {
                "file": landed.name,
                "source": landed.kind.source,
                "period": landed.period,
                "rows": landed.rows,
                "sha256": landed.sha256,
                "loaded": new,
            }
        )
    return out


def refresh_employee_keys(con: duckdb.DuckDBPyConnection, pseudo=None) -> int:
    """`raw._employee_keys`: the er_ key (HMAC, privacy/pseudo.py) of every employee number in the raw HRIS and payroll
    tables. Staging replaces employee numbers with these keys; the table is runner-only, like everything in `raw`."""
    from staysignal.privacy.pseudo import engine_pseudonymizer

    pseudo = pseudo or engine_pseudonymizer()
    ensure_raw(con)
    con.execute(
        "CREATE TABLE IF NOT EXISTS raw._employee_keys (employee_number VARCHAR PRIMARY KEY, er VARCHAR NOT NULL)"
    )
    have = {r[0] for r in con.execute("SELECT employee_number FROM raw._employee_keys").fetchall()}
    ids = {
        r[0]
        for r in con.execute(
            "SELECT employee_number FROM raw.raw_hris UNION SELECT manager_employee_number FROM raw.raw_hris "
            "UNION SELECT employee_number FROM raw.raw_payroll"
        ).fetchall()
        if r[0]
    }
    new = sorted(ids - have)
    if new:
        con.executemany(
            "INSERT INTO raw._employee_keys VALUES (?, ?)", [(e, pseudo.pseudonym("employee_ref", e)) for e in new]
        )
    return len(new)


__all__ = ["batch_id", "ensure_raw", "ingest", "load", "loaded_files", "refresh_employee_keys", "table_of"]
