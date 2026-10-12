"""Published forecast tables (SPEC 7.2): the engine writes each forecast run's cohort aggregates into the `published`
schema, the only layer the Worker reads. Only cohorts of 10 or more people are ever written (they are suppressed
upstream, `privacy/suppression.py`); `warehouse/tests/published/assert_no_small_cells.sql` fails the build otherwise.
Writing a run replaces its rows, so publishing is idempotent. Synthetic world only.
"""

from __future__ import annotations

import json

import duckdb

DDL = (
    "CREATE SCHEMA IF NOT EXISTS published",
    """CREATE TABLE IF NOT EXISTS published.forecast_runs (
        run_id VARCHAR PRIMARY KEY, run_key VARCHAR NOT NULL, cutoff DATE NOT NULL, vintage TIMESTAMPTZ NOT NULL,
        model VARCHAR NOT NULL, model_sha256 VARCHAR NOT NULL, metric_def VARCHAR NOT NULL, mapping VARCHAR NOT NULL,
        status VARCHAR NOT NULL, result_hash VARCHAR NOT NULL, population INTEGER NOT NULL, mc_config VARCHAR NOT NULL,
        label VARCHAR NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS published.forecast_cohort (
        run_id VARCHAR NOT NULL, cohort_id VARCHAR NOT NULL, kind VARCHAR NOT NULL, name VARCHAR NOT NULL,
        parent VARCHAR, n INTEGER NOT NULL, size_band VARCHAR NOT NULL, rounding_step DOUBLE NOT NULL,
        horizon_months INTEGER NOT NULL, expected DOUBLE NOT NULL, lo80 INTEGER NOT NULL, hi80 INTEGER NOT NULL,
        lo95 INTEGER NOT NULL, hi95 INTEGER NOT NULL, other_expected DOUBLE, trailing_expected DOUBLE,
        suppressed BOOLEAN NOT NULL, PRIMARY KEY (run_id, cohort_id, horizon_months))""",
)


def ensure(con: duckdb.DuckDBPyConnection) -> None:
    for stmt in DDL:
        con.execute(stmt)


def write_run(con: duckdb.DuckDBPyConnection, fixture: dict) -> int:
    """Writes one run in the API fixture format (`fixtures/export_api.py`); returns the cohort rows written."""
    ensure(con)
    run = fixture["run"]
    rows = []
    for c in fixture["cohorts"]:
        for h, hz in sorted(c["horizons"].items(), key=lambda kv: int(kv[0])):
            rows.append(
                (
                    run["run_id"],
                    c["cohort_id"],
                    c["kind"],
                    c["name"],
                    c.get("parent"),
                    int(c["n"]),
                    c["rounding"]["band"],
                    float(c["rounding"]["step"]),
                    int(h),
                    float(hz["expected"]),
                    int(hz["i80"][0]),
                    int(hz["i80"][1]),
                    int(hz["i95"][0]),
                    int(hz["i95"][1]),
                    float(hz["other"]["expected"]) if hz.get("other") else None,
                    float(hz["hist"]["expected"]) if hz.get("hist") else None,
                    False,
                )
            )
    con.execute("BEGIN")
    try:
        con.execute("DELETE FROM published.forecast_cohort WHERE run_id = ?", [run["run_id"]])
        con.execute("DELETE FROM published.forecast_runs WHERE run_id = ?", [run["run_id"]])
        con.execute(
            "INSERT INTO published.forecast_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                run["run_id"],
                run["run_key"],
                run["cutoff"],
                run["vintage"],
                run["model"],
                run["model_sha256"],
                run["metric_def"],
                run["mapping"],
                run["status"],
                run["result_hash"],
                int(run["population"]),
                json.dumps(run["mc_config"], sort_keys=True),
                "synthetic",
            ],
        )
        con.executemany(
            "INSERT INTO published.forecast_cohort VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return len(rows)


__all__ = ["ensure", "write_run"]
