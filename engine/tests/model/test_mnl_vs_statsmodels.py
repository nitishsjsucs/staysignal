"""The masked multinomial logit matches statsmodels MNLogit when unpenalized and unmasked (SPEC 9.1)."""

import numpy as np
import statsmodels.api as sm

from staysignal.model import mnl


def synthetic(n=6000, seed=3):
    rng = np.random.default_rng(seed)
    X = np.column_stack([np.ones(n), rng.normal(size=n), rng.binomial(1, 0.3, n)])
    B = np.array([[-2.5, -3.0, -4.0], [0.5, -0.2, 0.3], [0.4, 0.8, -0.5]])
    eta = X @ B
    P = np.exp(eta) / (1 + np.exp(eta).sum(axis=1, keepdims=True))
    u = rng.random(n)
    cum = np.cumsum(P, axis=1)
    y = np.where(u < cum[:, 0], 1, np.where(u < cum[:, 1], 2, np.where(u < cum[:, 2], 3, 0)))
    Y = np.zeros((n, 3))
    for k in range(3):
        Y[:, k] = y == k + 1
    return X, Y, y


def test_unpenalized_fit_equals_statsmodels():
    X, Y, y = synthetic()
    pk = mnl.Packing(p=3, masks=[np.arange(3)] * 3, penalized=np.array([False, True, True]))
    res = mnl.fit(X, Y, pk, lam=0.0)
    assert res.converged
    ref = sm.MNLogit(y, X).fit(disp=False, method="newton", maxiter=100)
    ours = pk.unpack(res.theta)
    assert np.allclose(ours, ref.params, atol=1e-6)
    assert abs(res.loglik - ref.llf) < 1e-6


def test_masks_and_penalty_shrink_only_slopes():
    X, Y, _ = synthetic()
    pk = mnl.Packing(p=3, masks=[np.arange(3), np.arange(3), np.array([0])], penalized=np.array([False, True, True]))
    free = mnl.fit(X, Y, pk, lam=0.0)
    pen = mnl.fit(X, Y, pk, lam=500.0)
    assert pk.unpack(pen.theta)[1:, 2].tolist() == [0.0, 0.0]  # masked columns stay zero
    assert abs(pen.theta[1]) < abs(free.theta[1])


def test_sandwich_is_symmetric_positive_definite():
    X, Y, _ = synthetic(n=3000)
    pk = mnl.Packing(p=3, masks=[np.arange(3)] * 3, penalized=np.array([False, True, True]))
    res = mnl.fit(X, Y, pk, lam=1.0)
    clusters = np.arange(len(X)) % 40
    V = mnl.cluster_sandwich(res.theta, X, Y, clusters, pk, 1.0)
    assert np.allclose(V, V.T)
    assert np.linalg.eigvalsh(V).min() > 0
