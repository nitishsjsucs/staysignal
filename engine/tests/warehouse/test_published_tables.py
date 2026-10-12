"""Published forecast tables hold cohort aggregates of 10 or more people only, and writing a run is idempotent."""

import json
from pathlib import Path

import pytest

from staysignal.forecast.published_tables import write_run
from staysignal.lineage.capture import invoke

from .conftest import VINTAGE

pytestmark = pytest.mark.dbt
FIXTURES = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "api" / "forecast"


def small_cell_failures(db, root) -> int:
    ok, tp = invoke(
        ["test", "--select", "assert_no_small_cells"], db, root / "target-published", dbt_vars={"vintage": VINTAGE}
    )
    results = json.loads((tp / "run_results.json").read_text())["results"]
    assert len(results) == 1
    return int(results[0]["failures"] or 0)


def test_runs_publish_idempotently_and_never_below_ten(built):
    con, db, root, _ = built
    for name in ("R-2026-09-01-1.json", "R-2026-10-01-1.json"):
        fixture = json.loads((FIXTURES / name).read_text())
        n = write_run(con, fixture)
        assert write_run(con, fixture) == n
    assert con.execute("SELECT count(DISTINCT run_id) FROM published.forecast_runs").fetchone()[0] == 2
    assert con.execute("SELECT min(n) FROM published.forecast_cohort").fetchone()[0] >= 10
    assert small_cell_failures(db, root) == 0

    con.execute(
        "INSERT INTO published.forecast_cohort VALUES ('R-test', 'team:T999', 'team', 'Tiny', NULL, 6, 'n<20', 1, 3, "
        "0.4, 0, 1, 0, 2, NULL, NULL, false)"
    )
    try:
        assert small_cell_failures(db, root) == 1
    finally:
        con.execute("DELETE FROM published.forecast_cohort WHERE run_id = 'R-test'")
