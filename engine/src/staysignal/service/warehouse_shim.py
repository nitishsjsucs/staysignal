"""The warehouse shim's catalog path (SPEC 7.2, 7.3, ADR 0012): executes only compiled semantic-catalog entries, with
parameters bound by the server, on a cursor of the engine's own DuckDB connection.

Three layers keep it read-only: the Worker never sends SQL (only an entry key and parameter values); every entry's
SQL passes the sqlglot single-SELECT guard when the catalog is loaded (copied from DataTrust
`pipelines/datatrust/warehouse/readonly.py`, MIT); and parameters are validated before binding. While a dbt build
holds the engine's build lock the shim answers "warehouse busy" (503) instead of reading a half-built warehouse.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from functools import cache

import duckdb
import sqlglot
from sqlglot import exp

from staysignal.lineage.capture import BUILD_LOCK
from staysignal.semantic import catalog as catalog_io
from staysignal.semantic import params as P

_FORBIDDEN = (
    exp.Insert,
    exp.Update,
    exp.Delete,
    exp.Merge,
    exp.Create,
    exp.Drop,
    exp.Alter,
    exp.Command,
    exp.Copy,
    exp.Set,
    exp.Use,
    exp.Pragma,
    exp.TruncateTable,
    exp.Transaction,
    exp.Commit,
    exp.Rollback,
)
_FILE_FUNCTIONS = {
    "read_csv",
    "read_csv_auto",
    "read_json",
    "read_json_auto",
    "read_ndjson",
    "read_text",
    "read_blob",
    "glob",
    "sniff_csv",
    "parquet_scan",
    "read_parquet",
    "query_table",
    "iceberg_scan",
    "delta_scan",
}
MONTH = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_LIST = 64
MAX_NAME = 80


class ReadOnlyViolation(ValueError):
    pass


class BadParams(ValueError):
    pass


class WarehouseBusy(RuntimeError):
    pass


def assert_read_only(sql: str, dialect: str = "duckdb") -> None:
    try:
        statements = [s for s in sqlglot.parse(sql, read=dialect) if s is not None]
    except sqlglot.errors.ParseError as err:
        raise ReadOnlyViolation(f"unparseable SQL: {err}") from err
    if len(statements) != 1:
        raise ReadOnlyViolation(f"expected exactly one statement, got {len(statements)}")
    stmt = statements[0]
    if not isinstance(stmt, exp.Query):
        raise ReadOnlyViolation(f"not a query: {type(stmt).__name__}")
    for node in stmt.walk():
        if isinstance(node, _FORBIDDEN):
            raise ReadOnlyViolation(f"forbidden construct: {type(node).__name__}")
        if isinstance(node, exp.Func):
            name = str(node.name).lower() if isinstance(node, exp.Anonymous) else node.sql_name().lower()
            if name in _FILE_FUNCTIONS or isinstance(node, exp.ReadCSV):
                raise ReadOnlyViolation(f"file access function not allowed: {name}")


@cache
def entries() -> dict[str, dict]:
    """The committed DuckDB catalog, every entry checked by the guard once."""
    out = catalog_io.load("duckdb")["entries"]
    for entry in out.values():
        assert_read_only(entry["sql"], "duckdb")
    return out


def _month(value: object, name: str) -> date:
    if not isinstance(value, str) or not MONTH.match(value):
        raise BadParams(f"{name} must be a month as YYYY-MM")
    return date(int(value[:4]), int(value[5:7]), 1)


def _names(value: object, name: str) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_LIST:
        raise BadParams(f"{name} must be a list of 1 to {MAX_LIST} names")
    if not all(isinstance(v, str) and 0 < len(v) <= MAX_NAME and v != P.ALL for v in value):
        raise BadParams(f"{name} holds an invalid name")
    return list(value)


def bind(body: dict) -> dict[str, object]:
    """Validated parameter values from a request body: months as YYYY-MM, optional name lists (None means all)."""
    unknown = set(body) - {"start_month", "end_month", "organizations", "groups", "scope"}
    if unknown:
        raise BadParams(f"unknown parameters: {sorted(unknown)}")
    start, end = _month(body.get("start_month"), "start_month"), _month(body.get("end_month"), "end_month")
    if end < start:
        raise BadParams("end_month is before start_month")
    return P.bind_values(
        start,
        end,
        _names(body.get("organizations"), "organizations"),
        _names(body.get("groups"), "groups"),
        _names(body.get("scope"), "scope"),
    )


@dataclass
class QueryResult:
    key: str
    columns: list[str]
    rows: list[list]
    sql_sha256: str

    def as_json(self) -> dict:
        return {
            "key": self.key,
            "label": "synthetic",
            "columns": self.columns,
            "rows": self.rows,
            "sql_sha256": self.sql_sha256,
        }


def _jsonable(v: object) -> object:
    if isinstance(v, date):
        return v.isoformat()[:10]
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def run_entry(con: duckdb.DuckDBPyConnection, key: str, values: dict[str, object]) -> QueryResult:
    """Executes one catalog entry with bound values on a cursor of the engine's connection."""
    entry = entries().get(key)
    if entry is None:
        raise KeyError(key)
    if not BUILD_LOCK.acquire(blocking=False):
        raise WarehouseBusy("warehouse busy")
    try:
        cur = con.cursor()
        try:
            res = cur.execute(entry["sql"], values)
            columns = [d[0] for d in res.description]
            rows = [[_jsonable(v) for v in r] for r in res.fetchall()]
        finally:
            cur.close()
    finally:
        BUILD_LOCK.release()
    return QueryResult(key, columns, rows, entry["sha256"])


__all__ = [
    "BadParams",
    "QueryResult",
    "ReadOnlyViolation",
    "WarehouseBusy",
    "assert_read_only",
    "bind",
    "entries",
    "run_entry",
]
