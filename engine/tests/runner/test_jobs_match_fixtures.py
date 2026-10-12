"""The runner computes the demo routine's engine jobs live from the warehouse and the landing store, and every output
equals the committed fixture the fixture runner replays (test/fixtures/jobs/<job_key>.json), except the replay's
measured duration. This is what makes the fixtures mode an honest stand-in for the local engine."""

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from staysignal.duck import open_duckdb
from staysignal.forecast.published_tables import ensure
from staysignal.ingest import mappings
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
from staysignal.runner.jobs import EngineState, execute
from staysignal.service.demo import job_key

pytestmark = pytest.mark.dbt

REPO = Path(__file__).resolve().parents[3]
FIXTURES = REPO / "test" / "fixtures"
CAND = "2026-10-05T14:05:00Z"
RUN = {"cutoff": "2026-10-01", "vintage": CAND, "model": "m2026.09", "metric_def": "voluntary_departures@2"}
ROUTINE = [
    ("ingest_source", {"source": "payroll", "period": "2026-09"}),
    ("run_checks", {"vintage": CAND, "mapping": "payroll@1"}),
    ("score_forecast", {"run_id": "R-2026-10-01#2", **RUN, "mapping": "payroll@1"}),
    ("rca_probe", {"run_id": "R-2026-10-01#2", "failing": ["C01", "C02", "C03"]}),
    ("propose_mapping", {"source": "payroll", "active": "payroll@1", "evidence_run": "R-2026-10-01#2"}),
    ("score_forecast", {"run_id": "R-2026-10-01#3", **RUN, "mapping": "payroll@2"}),
    ("run_checks", {"vintage": CAND, "mapping": "payroll@2"}),
    ("what_changed", {"from_run": "R-2026-10-01#1", "to_run": "R-2026-10-01#3"}),
    ("replay", {"run_id": "R-2026-10-01#3"}),
]


@pytest.fixture(scope="module")
def state(canonical, tmp_path_factory):
    var = tmp_path_factory.mktemp("engine-var")
    world = var / "world"
    shutil.copytree(canonical, world)
    published = var / "engine" / "published"
    (published / "forecast").mkdir(parents=True)
    shutil.copy(FIXTURES / "api" / "runs.json", published / "runs.json")
    for name in ("R-2026-09-01-1.json", "R-2026-10-01-1.json"):
        shutil.copy(FIXTURES / "api" / "forecast" / name, published / "forecast" / name)
    con = open_duckdb(var / "warehouse.duckdb")
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    ingest(con, paths, var / "landing", datetime(2023, 4, 1, 6, tzinfo=UTC))
    mappings.write_raw(con)
    refresh_employee_keys(con)
    ensure(con)
    st = EngineState(
        con, var / "warehouse.duckdb", world, var / "landing", REPO / "models", published, var / "engine" / "work"
    )
    yield st
    con.close()


def test_every_routine_job_equals_its_fixture(state):
    for kind, params in ROUTINE:
        expected = json.loads((FIXTURES / "jobs" / f"{job_key(kind, params)}.json").read_text())
        got = json.loads(json.dumps(execute(state, kind, params)))
        if kind == "replay":
            assert got["equal"] and got["detail"]["negative_check"]["hash_differs"]
            expected.pop("duration_ms"), got.pop("duration_ms")
        assert got == expected, kind
    published = {r[0] for r in state.con.execute("SELECT run_id FROM published.forecast_runs").fetchall()}
    assert published == {"R-2026-10-01#2", "R-2026-10-01#3"}
