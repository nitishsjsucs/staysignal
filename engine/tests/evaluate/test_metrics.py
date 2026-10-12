"""Every evaluation metric against a hand computation (SPEC 10)."""

import math

import numpy as np
import pytest

from staysignal.evaluate import metrics as m

DRAWS = np.array([0, 1, 1, 2, 4])


def test_count_errors_and_skill():
    assert m.mae([1, -2, 3]) == 2
    assert m.rmse([1, -2, 3]) == pytest.approx(math.sqrt(14 / 3))
    assert m.skill(2, 4) == 0.5
    assert m.skill(4, 2) == -1.0
    assert math.isnan(m.skill(1, 0))


def test_observed_over_expected():
    assert m.observed_over_expected([3, 5], [4, 4]) == 1.0
    assert m.observed_over_expected([3], [4]) == 0.75


def test_coverage_and_interval_score():
    assert m.covered(5, [5, 10]) and m.covered(10, [5, 10]) and not m.covered(11, [5, 10])
    assert m.interval_score(7, [5, 10], 0.8) == 5
    assert m.interval_score(12, [5, 10], 0.8) == pytest.approx(5 + 10 * 2)
    assert m.interval_score(3, [5, 10], 0.95) == pytest.approx(5 + 40 * 2)


def test_predictive_cdf_and_pit():
    assert m.predictive_cdf(DRAWS, -1) == 0.0
    assert m.predictive_cdf(DRAWS, 0) == pytest.approx(0.2)
    assert m.predictive_cdf(DRAWS, 1) == pytest.approx(0.6)
    assert m.pit_function(DRAWS, 1, 0.1) == 0.0
    assert m.pit_function(DRAWS, 1, 0.4) == pytest.approx(0.5)
    assert m.pit_function(DRAWS, 1, 0.7) == 1.0
    assert m.pit_histogram([(DRAWS, 1)], bins=5) == pytest.approx([0, 0.5, 0.5, 0, 0])


def test_ranked_probability_score():
    # k = 0..4: (0.2 - 0)^2 + (0.6 - 1)^2 + (0.8 - 1)^2 + (0.8 - 1)^2 + (1 - 1)^2
    assert m.ranked_probability_score(DRAWS, 1) == pytest.approx(0.04 + 0.16 + 0.04 + 0.04)
    assert m.ranked_probability_score(np.array([3, 3, 3]), 3) == 0.0


def test_effective_windows_and_block_bootstrap():
    assert m.effective_windows(19, 3) == 6
    assert m.effective_windows(16, 6) == 2
    assert m.block_bootstrap([1.0] * 12, block=3) == [1.0, 1.0]
    lo, hi = m.block_bootstrap([0, 1] * 10, block=1, n_boot=4000, seed=1)
    assert lo < 0.5 < hi


def test_reliability_table_by_bins():
    p = np.array([0.1] * 5 + [0.9] * 5)
    o = np.array([0, 0, 0, 0, 1, 1, 1, 1, 1, 0])
    t = m.reliability_table(p, o, bins=2)
    assert [(r["n"], r["predicted"], r["observed"]) for r in t] == [(5, 0.1, 0.2), (5, 0.9, 0.8)]


def test_calibration_indices_find_miscalibration():
    rng = np.random.default_rng(0)
    p = rng.uniform(0.01, 0.3, 20000)
    good = m.calibration_indices(p, rng.random(20000) < p)
    bad = m.calibration_indices(p, rng.random(20000) < 2 * p)
    assert good["ici"] < 0.01 and good["e50"] <= good["e90"]
    assert bad["ici"] > 0.1
