"""Phase-1 checks on the warehouse (dbt tests plus engine SQL) equal the Python checks (quality/run_checks.py) on the
canonical world: the canonical runs pass, X01 catches the late terminations before the audit batch, and the payroll
defect gives exactly C01, C02, C03 failing with C04 warning while X01 and F01 pass (C17); payroll@2 repairs it."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from staysignal.duck import open_duckdb
from staysignal.forecast.published_tables import ensure
from staysignal.ingest import mappings
from staysignal.ingest.landing import load_world_sources
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
from staysignal.lineage.capture import build
from staysignal.quality.run_checks import run_checks, summarize
from staysignal.quality.warehouse_checks import phase1_results

pytestmark = pytest.mark.dbt

MIGRATION = datetime(2023, 4, 1, 6, tzinfo=UTC)
ARRIVAL = datetime(2026, 10, 5, 14, 5, tzinfo=UTC)
CASES = [
    (datetime(2026, 9, 1, 6, tzinfo=UTC), "payroll@1"),  # R-2026-09-01#1
    (datetime(2026, 9, 10, 6, tzinfo=UTC), "payroll@1"),  # before the 2026-09-15 audit batch: X01 fails
    (datetime(2026, 10, 1, 6, tzinfo=UTC), "payroll@1"),  # R-2026-10-01#1
    (ARRIVAL, "payroll@1"),  # the held run of beat 3
    (ARRIVAL, "payroll@2"),  # the repaired run of beat 4
]


@pytest.fixture(scope="module")
def setup(canonical, tmp_path_factory):
    root = tmp_path_factory.mktemp("quality-warehouse")
    db = root / "w.duckdb"
    con = open_duckdb(db)
    paths = sorted((canonical / "sources").glob("*.csv")) + sorted((canonical / "held").glob("*.csv"))
    ingest(con, paths, root / "landing", MIGRATION)
    mappings.write_raw(con)
    refresh_employee_keys(con)
    ensure(con)
    yield con, db, root, load_world_sources(canonical, include_held=True)
    con.close()


def warehouse_results(setup, v: datetime, mapping: str) -> list[dict]:
    con, db, root, _ = setup
    stamp = v.strftime("%Y-%m-%dT%H:%M:%SZ")
    res = build(
        Path(db), root / f"target-{stamp}-{mapping}", {"vintage": stamp, "pay_basis_mapping": mapping}, capture=False
    )
    assert res.success
    return phase1_results(con, res, v)


@pytest.mark.parametrize(("v", "mapping"), CASES, ids=[f"{v:%Y-%m-%dT%H%M}-{m}" for v, m in CASES])
def test_warehouse_checks_equal_the_python_checks(setup, v, mapping):
    wh = {r["check_id"]: (r["status"], r["failing_rows"]) for r in warehouse_results(setup, v, mapping)}
    py = {r["check_id"]: (r["status"], r["failing_rows"]) for r in run_checks(setup[3], v, mapping)}
    assert wh == py


def test_defect_pattern_and_repair_on_the_warehouse(setup):
    held = summarize(warehouse_results(setup, ARRIVAL, "payroll@1"))
    assert held["failing"] == ["C01", "C02", "C03"]
    assert held["warnings"] == ["C04"]
    status = {r["check_id"]: r["status"] for r in held["results"]}
    assert status["X01"] == "pass" and status["F01"] == "pass"
    assert summarize(warehouse_results(setup, ARRIVAL, "payroll@2"))["failing"] == []
    for v in (datetime(2026, 9, 1, 6, tzinfo=UTC), datetime(2026, 10, 1, 6, tzinfo=UTC)):
        assert summarize(warehouse_results(setup, v, "payroll@1"))["failing"] == []
