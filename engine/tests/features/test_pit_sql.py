"""17: pit.sql agrees exactly with the Python reference on the small world at 6 cutoffs, at the final vintage and at
backtest vintages (v = c), under both payroll mappings and both metric definitions."""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, date, datetime

import pytest

from staysignal.duck import open_duckdb
from staysignal.features.pit import features_sql
from staysignal.features.reference import MAPPINGS, Vintage, features_at
from staysignal.ingest import mappings
from staysignal.ingest.landing import load_world_sources
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
from staysignal.lineage.capture import build

pytestmark = pytest.mark.dbt
CUTOFFS = [date(2025, 7, 1), date(2025, 10, 1), date(2026, 1, 1), date(2026, 3, 1), date(2026, 6, 1), date(2026, 9, 1)]
FINAL = datetime(2026, 10, 1, 6, tzinfo=UTC)


@pytest.fixture(scope="module")
def small_warehouse(small, tmp_path_factory):
    root = tmp_path_factory.mktemp("pit")
    db = root / "w.duckdb"
    con = open_duckdb(db)
    ingest(con, sorted((small / "sources").glob("*.csv")), root / "landing", datetime(2023, 4, 1, 6, tzinfo=UTC))
    mappings.write_raw(con)
    refresh_employee_keys(con)
    keys = dict(con.execute("SELECT employee_number, er FROM raw._employee_keys").fetchall())
    yield con, db, root, keys, load_world_sources(small)
    con.close()


def compare(setup, v: datetime, mapping: str, metric: str, cutoffs: list[date]) -> int:
    con, db, root, keys, src = setup
    stamp = v.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert build(
        db,
        root / f"t-{stamp}-{mapping}",
        {"vintage": stamp, "pay_basis_mapping": mapping},
        capture=False,
        command="run",
    ).success
    vin = Vintage(src, v)
    n = 0
    for c in cutoffs:
        sql = [asdict(r) for r in features_sql(con, c, metric)]
        ref = sorted(
            (
                {**asdict(r), "employee_number": keys[r.employee_number]}
                for r in features_at(vin, c, MAPPINGS[mapping], metric)
            ),
            key=lambda r: r["employee_number"],
        )
        assert sql == ref, c
        n += len(sql)
    return n


def test_pit_sql_matches_the_reference_at_the_final_vintage(small_warehouse):
    assert compare(small_warehouse, FINAL, "payroll@1", "voluntary_departures@1", CUTOFFS) > 6 * 100
    assert compare(small_warehouse, FINAL, "payroll@2", "voluntary_departures@2", CUTOFFS) > 6 * 100


@pytest.mark.parametrize("c", CUTOFFS[::2])
def test_pit_sql_matches_the_reference_at_backtest_vintages(small_warehouse, c):
    assert (
        compare(
            small_warehouse, datetime(c.year, c.month, c.day, tzinfo=UTC), "payroll@1", "voluntary_departures@2", [c]
        )
        > 100
    )
