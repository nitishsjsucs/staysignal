"""Runs `pit.sql` (the point-in-time features as one parameterized DuckDB query) on a warehouse built at the run's
vintage and payroll mapping, returning reference-shaped rows keyed by `er_` employee keys (SPEC 8.2)."""

from __future__ import annotations

from dataclasses import fields
from datetime import date
from functools import cache
from pathlib import Path

import duckdb

from staysignal.features.reference import FeatureRow

SQL = Path(__file__).with_name("pit.sql")
COLUMNS = [f.name for f in fields(FeatureRow) if f.name != "employee_number"]


@cache
def query() -> str:
    return SQL.read_text(encoding="utf-8")


def features_sql(
    con: duckdb.DuckDBPyConnection, c: date, metric_def: str = "voluntary_departures@1", clock: date | None = None
) -> list[FeatureRow]:
    """Feature rows at cutoff c (clocks at `clock`, default c), sorted by employee key; `employee_number` holds the
    `er_` key, because nothing downstream of staging sees an employee number."""
    cur = con.execute(query(), {"cutoff": c, "clock": clock or c, "metric": metric_def})
    names = [d[0] for d in cur.description]
    out = []
    for row in cur.fetchall():
        r = dict(zip(names, row, strict=True))
        for k in ("compa_ratio", "prior_team_rate"):  # rounded here, as the reference rounds them
            if r[k] is not None:
                r[k] = round(float(r[k]), 6)
        out.append(FeatureRow(employee_number=r["employee_key"], **{k: r[k] for k in COLUMNS}))
    return out


__all__ = ["features_sql"]
