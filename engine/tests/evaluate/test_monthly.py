"""Monthly backtests on the small world: only mature windows are scored, every summary metric is finite, PIT
histograms sum to one, and the individual calibration keeps only bins of 10 or more."""

import json
import math
from datetime import date

import pytest

from staysignal.evaluate.monthly import MONTHLY_ORIGINS, backtest, summarize
from staysignal.ingest.landing import load_world_sources
from staysignal.world.spec import SMALL


def test_monthly_origins():
    assert (
        MONTHLY_ORIGINS[0] == date(2024, 10, 1)
        and MONTHLY_ORIGINS[-1] == date(2026, 9, 1)
        and len(MONTHLY_ORIGINS) == 24
    )


@pytest.fixture(scope="module")
def result(small, tmp_path_factory):
    sha = json.loads((small / "manifest.json").read_text())["world_sha256"]
    origins = [date(2026, 3, 1), date(2026, 4, 1), date(2026, 5, 1), date(2026, 8, 1)]
    bt = backtest(
        load_world_sources(small),
        SMALL.start,
        tmp_path_factory.mktemp("cache"),
        sha,
        origins=origins,
        log=lambda s: None,
    )
    return bt, summarize(bt)


def test_only_mature_windows_are_scored(result):
    bt, s = result
    # mature means o + h + 75 days <= 2026-10-01
    assert {e["status"] for e in bt["entries"] if e["origin"] == "2026-08-01"} <= {"provisional", "pending"}
    assert s["levels"]["company|1"]["origins"] == 3  # 2026-03, 2026-04, 2026-05
    assert s["levels"]["company|3"]["origins"] == 2  # 2026-03, 2026-04
    assert s["levels"]["company|1"]["effective_windows"] == 3 and s["levels"]["company|3"]["effective_windows"] == 0
    assert "company|6" not in s["levels"]
    assert s["provisional_windows_excluded"] > 0


def test_summary_metrics_are_well_formed(result):
    _, s = result
    for key, v in s["levels"].items():
        for f in ("mae", "rmse", "observed_over_expected", "coverage80", "coverage95", "rps", "interval_score80"):
            assert math.isfinite(v[f]), (key, f)
        assert sum(v["pit_histogram"]) == pytest.approx(1.0)
        assert 0 <= v["coverage80"] <= v["coverage95"] <= 1
        lo, hi = v["coverage80_block_i80"]
        assert lo <= hi


def test_individual_calibration_keeps_bins_of_ten(result):
    _, s = result
    c = s["calibration_3m"]
    assert c["n"] > 100 and c["ici"] >= 0 and c["e50"] <= c["e90"]
    assert all(r["n"] >= 10 for r in c["reliability"])
    assert all(r["observed_i80"][0] <= r["observed_i80"][1] for r in c["reliability"])
