"""The model comparison runs every model on the same origins and cohorts, with actuals only from the outcome vintage,
and uses the six quarterly origins whose 6-month window is mature."""

import json
from datetime import date

from staysignal.evaluate.comparison import COMPARISON_ORIGINS, MODELS, compare
from staysignal.ingest.landing import load_world_sources
from staysignal.world.spec import SMALL


def test_comparison_origins_are_the_six_mature_quarters():
    assert [o.isoformat() for o in COMPARISON_ORIGINS] == [
        "2024-10-01",
        "2025-01-01",
        "2025-04-01",
        "2025-07-01",
        "2025-10-01",
        "2026-01-01",
    ]


def test_every_model_on_the_same_cohorts(small, tmp_path):
    sha = json.loads((small / "manifest.json").read_text())["world_sha256"]
    out = compare(
        load_world_sources(small),
        SMALL,
        SMALL.start,
        tmp_path,
        sha,
        origins=[date(2026, 4, 1)],
        n_futures=20,
        workers=1,
        log=lambda m: None,
    )
    assert out["models"] == list(MODELS)
    company = [e for e in out["entries"] if e["cohort"] == "company"]
    assert [e["horizon_months"] for e in company] == [1, 3, 6]
    assert [e["status"] for e in company] == ["mature", "mature", "provisional"]
    for e in out["entries"]:
        for m in MODELS:
            f = e[m]
            assert f is not None, (e["cohort"], m)
            assert f["i95"][0] <= f["i80"][0] <= f["i80"][1] <= f["i95"][1]
            assert f["expected"] >= 0
        assert e["actual"] <= e["n"]
