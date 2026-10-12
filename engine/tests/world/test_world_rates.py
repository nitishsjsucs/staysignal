"""C3: realized rates are plausible (SPEC 6.3 calibration ranges)."""

from tests.conftest import manifest


def test_annual_rates_in_range(canonical):
    r = manifest(canonical)["realized"]["annual_rates_per_100"]
    assert 10.0 <= r["voluntary"] <= 15.0
    assert 2.5 <= r["involuntary"] <= 5.0
    assert 0.5 <= r["retirement"] <= 1.5


def test_cycle_promotion_rates_in_range(canonical):
    rates = manifest(canonical)["realized"]["cycle_promotion_rates"]
    assert all(0.10 <= v <= 0.14 for v in rates.values()), rates


def test_intercepts_within_calibration_bounds(canonical):
    m = manifest(canonical)
    for k, start in m["hazard_intercepts_start"].items():
        bound = 0.4 if k == "promo" else 0.5
        assert abs(m["hazard_intercepts"][k] - start) <= bound + 1e-9
