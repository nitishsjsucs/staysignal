"""C9: cohort expected departures are the sum of individual cumulative incidences; C10 basics of the Monte Carlo."""

from datetime import date

import numpy as np

from staysignal.forecast.montecarlo import McConfig, run_mc
from staysignal.forecast.score import cumulative
from staysignal.model import mnl
from staysignal.model.artifact import Model
from staysignal.model.design import DesignSpec


def tiny_model(sigma_team=0.0, sigma_org=0.0, cov_scale=0.0):
    spec = DesignSpec(
        knots=[0, 1, 2, 3],
        columns=["intercept", "x"],
        mean=[0, 0],
        scale=[1, 1],
        masks={"voluntary": [0, 1], "involuntary": [0], "retirement": [0]},
        penalized=[False, True],
    )
    pk = mnl.Packing(p=2, masks=[np.array([0, 1]), np.array([0]), np.array([0])], penalized=np.array([False, True]))
    theta = np.array([-3.5, 0.4, -5.0, -7.0])
    cov = np.eye(4) * cov_scale
    shocks = {
        "sigma_team": sigma_team,
        "sigma_org": sigma_org,
        "sigma_team_draws": [sigma_team],
        "sigma_org_draws": [sigma_org],
    }
    return Model("t", "x", spec, pk, theta, cov, shocks, {})


def design(n=400, seed=1):
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    X = np.zeros((n, 6, 2))
    X[:, :, 0] = 1.0
    X[:, :, 1] = x[:, None]
    return X


def test_cumulative_incidence_matches_hand_computation():
    P = np.array([[[0.1, 0.0, 0.0], [0.2, 0.1, 0.0]] + [[0.0, 0.0, 0.0]] * 4])
    F = cumulative(P)
    assert np.isclose(F[0, 0, 0], 0.1)
    assert np.isclose(F[0, 1, 0], 0.1 + 0.2 * 0.9)
    assert np.isclose(F[0, 1, 1], 0.1 * 0.9)


def test_cohort_expectation_is_sum_and_mc_reduces_to_poisson_binomial():
    m = tiny_model()
    X = design()
    n = X.shape[0]
    B = m.pk.unpack(m.theta)
    P = mnl.probabilities(X.reshape(n * 6, 2), B).reshape(n, 6, 3)
    F = cumulative(P)
    members = np.vstack([np.ones(n), (np.arange(n) < n // 2).astype(float)])
    res = run_mc(m, X, ["T1"] * n, date(2026, 10, 1), members, seed=7, cfg=McConfig(n_theta=4, n_org=5, n_team=50))
    expected = members @ F[:, 2, 0]
    assert np.allclose(res.vol_mean[:, 2], expected, rtol=0.05)
    shares = res.variance[:, 2] / res.variance[:, 2].sum(axis=1, keepdims=True)
    assert np.allclose(shares.sum(axis=1), 1.0)
    # no parameter or shock uncertainty: everything is process variance
    assert shares[0, 3] > 0.999


def test_shocks_add_variance_and_a_window_crossing_a_quarter_draws_two_shocks():
    X = design(n=600)
    members = np.ones((1, X.shape[0]))
    calm = run_mc(tiny_model(), X, ["T1"] * 600, date(2026, 11, 1), members, seed=3, cfg=McConfig(4, 10, 20))
    shocked = run_mc(
        tiny_model(sigma_team=0.5, sigma_org=0.4),
        X,
        ["T1"] * 600,
        date(2026, 11, 1),
        members,
        seed=3,
        cfg=McConfig(4, 10, 20),
    )
    assert shocked.variance[0, 5].sum() > calm.variance[0, 5].sum()
    assert shocked.variance[0, 5, 1] > 0 and shocked.variance[0, 5, 2] > 0
