"""The arms match the pre-registration's design table, and the handling transforms do what they say."""

from datetime import date

from staysignal.features.reference import FeatureRow
from staysignal.model.train import Collected
from staysignal.research.arms import ORIGINS, PLANS, arms, research_profile
from staysignal.research.handling import censor_month, duplicate_exits


def test_every_preregistered_cell_is_an_arm_backed_by_a_fit():
    cells = {(a.factor, a.level, a.handling) for a in arms()}
    expected = {("A", lvl, h) for lvl in ("0", "0.15", "0.30") for h in ("naive", "matured")}
    expected |= {("B", lvl, h) for lvl in ("none", "missing") for h in ("no_events", "censored")}
    expected |= {("C", lvl, h) for lvl in ("0", "0.25", "0.5") for h in ("independence", "shock_aware")}
    expected |= {("D", lvl, h) for lvl in ("0", "0.05") for h in ("not_deduplicated", "deduplicated")}
    expected |= {("AxC", "0.30 x 0.5", "matured_shock_aware"), ("AxC", "0.30 x 0.5", "naive_independence")}
    assert cells == expected
    fits = {(p.condition.name, h.name, i) for p in PLANS for h in p.handlings for i in h.intervals}
    for a in arms():
        assert (a.condition, a.fit, a.interval) in fits, a
    assert len(ORIGINS) == 8


def test_the_base_world_and_the_shock_worlds():
    base = research_profile(3, next(p.condition for p in PLANS if p.condition.name == "base"))
    assert (base.seed, base.sigma_team, base.sigma_org, base.contagion, base.drift, base.planted) == (
        3,
        0.25,
        0.125,
        True,
        False,
        None,
    )
    shock = research_profile(3, next(p.condition for p in PLANS if p.condition.name == "shock_0.5"))
    assert (shock.sigma_team, shock.sigma_org, shock.contagion) == (0.5, 0.25, False)


def _row(en: str) -> FeatureRow:
    return FeatureRow(
        employee_number=en, org="Engineering", group="Data", team="T1", job_family="SWE", level="IC2", level_band="early",
        tenure_band="1-3y", location="RAL", employment_type="regular", tenure_days=400, time_in_role_days=200,
        days_since_last_promotion=400, never_promoted_in_spell=True, first_promotion_status="none_yet",
        manager_changes_180d=0, compa_ratio=1.0, prior_team_rate=0.1, prior_team_departures_180d=1,
        reorg_exposure_90d=False, fixed_term_days_remaining=None,
    )  # fmt: skip


def test_censoring_stops_follow_up_at_the_missing_month():
    c = [
        Collected(date(2024, 4, 1), [_row("E1"), _row("E2")], [6, 1], [[-1, -1, -1, -1, -1, -1], [0]]),
        Collected(date(2024, 6, 1), [_row("E3")], [3], [[-1, -1, -1]]),
    ]
    out = censor_month(c, (2024, 6))
    assert out[0].periods == [2, 1] and out[0].causes[0] == [-1, -1]
    assert out[1].rows == []  # a landmark inside the missing month is dropped


def test_duplicates_count_twice_only_for_recorded_exits():
    c = [Collected(date(2024, 4, 1), [_row("E1"), _row("E2"), _row("E3")], [2, 3, 6], [[-1, 0], [-1, -1, 1], [-1] * 6])]
    out = duplicate_exits(c, frozenset({"E1", "E3"}))
    assert [r.employee_number for r in out[0].rows] == ["E1", "E2", "E3", "E1"]
