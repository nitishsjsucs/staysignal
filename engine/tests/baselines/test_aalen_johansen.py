"""The Aalen-Johansen baseline: the estimator by hand on a small table, and a fit on the small world that agrees with
the empirical departure share where no competing risk or censoring intervenes."""

from datetime import UTC, date, datetime

import numpy as np
import pytest

from staysignal.baselines import aalen_johansen as aj
from staysignal.baselines.oracle import forecasts
from staysignal.ingest.landing import load_world_sources
from staysignal.model.train import landmark_dates
from staysignal.world.spec import SMALL


def test_curve_by_hand():
    # month 1: 100 at risk, 5 voluntary and 1 retirement; month 2: 94 at risk, 4 voluntary and 2 involuntary
    F = aj.aj_curve([100, 94], [[5, 0, 1], [4, 2, 0]])
    s1 = 1 - 6 / 100
    assert F[0, 0] == pytest.approx(0.05)
    assert F[2, 0] == pytest.approx(0.01)
    assert F[0, 1] == pytest.approx(0.05 + s1 * 4 / 94)
    assert F[1, 1] == pytest.approx(s1 * 2 / 94)
    # incidences never exceed one minus survival
    assert F[:, 1].sum() == pytest.approx(1 - s1 * (1 - 6 / 94))


def test_a_month_with_nobody_at_risk_adds_nothing():
    F = aj.aj_curve([10, 0, 10], [[1, 0, 0], [0, 0, 0], [1, 0, 0]])
    assert F[0, 1] == F[0, 0] and F[0, 2] == pytest.approx(0.1 + 0.9 * 0.1)


def test_fit_on_the_small_world(small):
    src = load_world_sources(small)
    T = date(2026, 6, 1)
    model = aj.fit(src, T, datetime(2026, 6, 1, 6, tzinfo=UTC), landmark_dates(SMALL.start, T))
    p3 = model.incidence("company", 3)
    assert 0.005 < p3 < 0.08  # small-world voluntary rates are 10% to 15% a year
    assert model.incidence("company", 6) >= p3 >= model.incidence("company", 1)
    for cid, curve in model.curves.items():
        assert np.all(np.diff(curve, axis=1) >= -1e-12), cid  # cumulative incidence never decreases
        assert curve[:, -1].sum() <= 1.0
    f = model.forecast("company", 200, 3)
    assert f["i95"][0] <= f["i80"][0] <= f["expected"] <= f["i80"][1] <= f["i95"][1]
    assert any(c.startswith("org:") for c in model.curves)


def test_oracle_forecasts_follow_the_metric_definition():
    origin = date(2026, 1, 1)
    v2 = forecasts(SMALL, origin, "voluntary_departures@2", n_futures=40, workers=1)
    v1 = forecasts(SMALL, origin, "voluntary_departures@1", n_futures=40, workers=1)
    assert v2["company"][3]["n"] <= v1["company"][3]["n"]
    for f in (v1, v2):
        c = f["company"]
        assert c[1]["expected"] <= c[3]["expected"] <= c[6]["expected"]
        assert c[3]["i95"][0] <= c[3]["i80"][0] <= c[3]["i80"][1] <= c[3]["i95"][1]
