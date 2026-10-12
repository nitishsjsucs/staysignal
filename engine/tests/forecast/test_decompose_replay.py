"""C16 (endpoints), C21: the decomposition reproduces both runs exactly; replay from landed files reproduces the
business-result hash and a replay forced to mapping v1 does not."""

from pathlib import Path

import pytest

from staysignal.forecast.decompose import decompose
from staysignal.forecast.replay import replay
from staysignal.forecast.run import RunInputs, make_run, population
from staysignal.ingest.landing import load_world_sources
from staysignal.model import artifact as artifact_io
from staysignal.service.demo import CANDIDATE_VINTAGE, P, Q, table

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def models():
    return {v: artifact_io.load(ROOT / "models" / v / "model.json") for v in ("m2026.08", "m2026.09")}


def test_decomposition_endpoints_equal_the_runs(canonical, models):
    src = load_world_sources(canonical)
    rp = make_run(src, RunInputs(P.run_id, P.cutoff, P.vintage, models[P.model], P.metric_def, P.mapping))
    rq = make_run(
        src,
        RunInputs(Q.run_id, Q.cutoff, Q.vintage, models[Q.model], Q.metric_def, Q.mapping),
        population(src, P.cutoff, P.vintage, P.metric_def, P.mapping),
    )
    ch = decompose(src, P, Q, models, table(rq), table(rp))
    assert ch["max_endpoint_error"] < 1e-9
    for e in ch["entries"]:
        assert abs(e["_exact"]["delta"] - e["_exact"]["phi_sum"]) < 1e-9
        assert len(e["evaluations"]) == 32
        for f in e["factors"]:
            if f["factor"] == "time_and_population":
                assert "calendar" in f["merged_from"]
            elif f["changed_people"]:
                assert f["changed_people"] >= 10, "factors that change 1 to 9 people are merged"


def test_replay_matches_and_wrong_mapping_differs(canonical, models):
    held = load_world_sources(canonical, include_held=True)
    run = make_run(
        held, RunInputs("R-2026-10-01#3", Q.cutoff, CANDIDATE_VINTAGE, models["m2026.09"], Q.metric_def, "payroll@2")
    )
    brief = {
        "run_id": run["run_id"],
        "cutoff": run["cutoff"],
        "vintage": run["vintage"],
        "model": "m2026.09",
        "metric_def": run["metric_def"],
        "mapping": "payroll@2",
        "result_hash": run["result_hash"],
    }
    landed = sorted((canonical / "sources").glob("*.csv")) + sorted((canonical / "held").glob("*.csv"))
    ok = replay(brief, landed, ROOT / "models")
    assert ok["equal"]
    bad = replay(brief, landed, ROOT / "models", force_mapping="payroll@1")
    assert not bad["equal"]
