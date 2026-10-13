"""C15: the challenger (SPEC 9.4). Pure parts always run: Poisson-binomial intervals, the deterministic row sample,
follow-up and censoring of person-landmarks. The SurvivalBoost smoke (n_iter=3 on the small world) runs only with
the uv extra `challenger` installed (the CI `challenger` job)."""

from datetime import date
from pathlib import Path

import numpy as np
import pytest
from scipy.stats import binom

from staysignal.baselines import survivalboost as sb
from staysignal.features.reference import Outcome
from staysignal.model.train import Collected


def test_poisson_binomial_matches_the_binomial_when_probabilities_are_equal():
    p = np.full(40, 0.07)
    np.testing.assert_allclose(sb.poisson_binomial_pmf(p), binom.pmf(np.arange(41), 40, 0.07), atol=1e-12)
    f = sb.poisson_binomial_forecast(p)
    assert f["expected"] == pytest.approx(2.8)
    assert f["i80"] == [float(x) for x in binom.ppf([0.10, 0.90], 40, 0.07)]
    assert f["i95"] == [float(x) for x in binom.ppf([0.025, 0.975], 40, 0.07)]


def test_poisson_binomial_against_brute_force():
    p = np.array([0.1, 0.5, 0.25, 0.9])
    brute = np.zeros(5)
    for bits in range(16):
        k = bin(bits).count("1")
        brute[k] += np.prod([p[i] if bits >> i & 1 else 1 - p[i] for i in range(4)])
    np.testing.assert_allclose(sb.poisson_binomial_pmf(p), brute, atol=1e-12)


def test_shared_shocks_widen_the_interval_but_keep_the_mean():
    p = np.full(600, 0.02)
    orgs = np.array(["A", "B", "C"] * 200)
    teams = np.array([f"T{i % 40}" for i in range(600)])
    plain = sb.poisson_binomial_forecast(p)
    shock = sb.shock_forecast(p, orgs, teams, [0.3], [0.6], draws=3000, seed=1)
    assert shock["expected"] == plain["expected"]
    assert shock["i95"][1] - shock["i95"][0] > plain["i95"][1] - plain["i95"][0]
    no_shock = sb.shock_forecast(p, orgs, teams, [0.0], [0.0], draws=3000, seed=1)
    assert abs(no_shock["i80"][1] - plain["i80"][1]) <= 1


def _row(en: str):
    from staysignal.features.reference import FeatureRow

    return FeatureRow(
        employee_number=en, org="Engineering", group="Platform Engineering", team="T1", job_family="SWE", level="IC2",
        level_band="early", tenure_band="1-3y", location="RAL", employment_type="regular", tenure_days=400,
        time_in_role_days=200, days_since_last_promotion=400, never_promoted_in_spell=True,
        first_promotion_status="none_yet", manager_changes_180d=1, compa_ratio=0.95, prior_team_rate=0.1,
        prior_team_departures_180d=1, reorg_exposure_90d=False, fixed_term_days_remaining=None,
    )  # fmt: skip


def test_rows_follow_people_to_their_last_matured_month():
    s = date(2025, 1, 1)
    c = Collected(s, [_row("E1"), _row("E2"), _row("E3")], [6, 2, 3], [[-1] * 6, [-1, -1], [-1, -1, 0]])
    outs = {
        "E1": Outcome(None, None),
        "E2": Outcome(date(2025, 6, 1), "voluntary"),  # after its 2 matured months: censored
        "E3": Outcome(date(2025, 3, 10), "voluntary"),
    }
    r = sb.survival_rows([c], [outs], ["Engineering"])
    assert r.event.tolist() == [0, 0, 1]
    assert r.duration.tolist() == [180.0, 59.0, 68.0]
    assert r.X.shape == (3, len(sb.FEATURES))


def test_the_sample_is_capped_deterministic_and_keeps_landmark_order():
    cs = [Collected(date(2025, m, 1), [_row(f"E{m}{i}") for i in range(50)], [1] * 50, [[-1]] * 50) for m in (1, 4, 7)]
    a = sb.sample(cs, cap=60, seed=7)
    b = sb.sample(cs, cap=60, seed=7)
    assert sum(len(c.rows) for c in a) == 60
    assert [[r.employee_number for r in c.rows] for c in a] == [[r.employee_number for r in c.rows] for c in b]
    assert [c.s for c in a] == [c.s for c in cs]
    assert sum(len(c.rows) for c in sb.sample(cs, cap=1000, seed=7)) == 150
    assert sb.quarterly_landmarks([date(2025, m, 1) for m in range(1, 13)]) == [date(2025, m, 1) for m in (1, 4, 7, 10)]


def test_the_trust_page_gets_the_challenger_only_on_the_same_origins():
    from staysignal.evaluate.report import with_challenger

    cmp = {
        "design": "main",
        "origins": ["2025-01-01"],
        "models": ["dtcr-mnl"],
        "summary": {"company|3": {"level": "company", "horizon_months": 3, "windows": 1, "dtcr-mnl": {"mae": 1.0}}},
    }
    ch = {
        "design": "challenger",
        "origins": ["2025-01-01"],
        "models": ["survivalboost"],
        "summary": {
            "company|3": {"level": "company", "horizon_months": 3, "windows": 1, "survivalboost": {"mae": 2.0}}
        },
    }
    merged = with_challenger(cmp, ch)
    assert merged["models"] == ["dtcr-mnl", "survivalboost"]
    assert merged["summary"]["company|3"]["dtcr-mnl"] == {"mae": 1.0}
    assert merged["summary"]["company|3"]["survivalboost"] == {"mae": 2.0}
    assert merged["design"] == "main; challenger"
    assert with_challenger(cmp, {**ch, "origins": ["2025-04-01"]}) == cmp
    assert with_challenger(cmp, None) == cmp


@pytest.mark.skipif(not sb.available(), reason="needs the uv extra `challenger`")
def test_survivalboost_smoke_on_the_small_world(tmp_path):
    import json

    from staysignal.evaluate.challenger import run_challenger
    from staysignal.ingest.landing import load_world_sources
    from staysignal.world.emit import generate
    from staysignal.world.spec import PROFILES

    world = tmp_path / "world"
    generate(PROFILES["small"], world)
    sha = json.loads((world / "manifest.json").read_text())["world_sha256"]
    out = run_challenger(
        load_world_sources(world), PROFILES["small"].start, tmp_path / "cache", sha,
        origins=[date(2026, 4, 1)], n_iter=3, shock_draws=200, log=lambda *_: None,
    )  # fmt: skip
    assert out["models"] == ["survivalboost", "survivalboost-shock", "dtcr-mnl-12k"]
    company = [e for e in out["entries"] if e["cohort"] == "company"]
    assert [e["horizon_months"] for e in company] == [1, 3, 6]
    for e in company:
        for m in out["models"]:
            f = e[m]
            assert 0 <= f["i95"][0] <= f["i80"][0] <= f["i80"][1] <= f["i95"][1] <= e["n"]
            assert 0 < f["expected"] < e["n"]
    assert Path(tmp_path / "cache").exists()
