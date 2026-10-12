"""Parameter draws for the Monte Carlo (SPEC 9.3, layer 1) come from the Cholesky factor of the sandwich covariance,
which is unique, so the same seed gives the same draws on macOS and on the Linux CI runner (C10, C21)."""

import hashlib
import json
from pathlib import Path

import numpy as np

from staysignal.forecast.montecarlo import NUGGET, cov_root, mvn_draws

REPO = Path(__file__).resolve().parents[3]

# SHA-256 of 20 draws for m2026.09 with seed 20261011, rounded to 1e-9; computed on macOS (Accelerate) and equal
# on Linux x86-64 and arm64 (OpenBLAS). The eigendecomposition used before gave different draws on the two platforms.
PINNED = "e1445518fcaebbfb"


def test_draws_from_a_singular_covariance_have_that_covariance():
    rng = np.random.default_rng(1)
    a = rng.normal(size=(4, 2))
    cov = a @ a.T  # rank 2
    draws = mvn_draws(np.random.default_rng(2), np.array([1.0, -1.0, 0.5, 0.0]), cov, 200_000)
    assert np.allclose(draws.mean(axis=0), [1.0, -1.0, 0.5, 0.0], atol=0.02)
    assert np.allclose(np.cov(draws.T), cov, atol=0.03 * np.abs(cov).max())


def test_root_reproduces_the_covariance_up_to_the_nugget():
    m = json.loads((REPO / "models" / "m2026.09" / "model.json").read_text())
    cov = np.array(m["covariance"])
    sym = (cov + cov.T) / 2
    L = cov_root(cov)
    assert np.allclose(L, np.tril(L))
    nugget = NUGGET * np.max(np.diag(sym))
    assert np.abs(L @ L.T - sym - nugget * np.eye(len(sym))).max() < 1e-12
    assert np.linalg.matrix_rank(sym, tol=1e-10) < len(sym)  # the sandwich is singular, hence the nugget


def test_zero_covariance_gives_the_point_estimate():
    mean = np.array([0.3, -2.0])
    assert np.array_equal(mvn_draws(np.random.default_rng(0), mean, np.zeros((2, 2)), 3), np.tile(mean, (3, 1)))


def test_draws_are_portable_across_platforms():
    m = json.loads((REPO / "models" / "m2026.09" / "model.json").read_text())
    draws = mvn_draws(np.random.default_rng(20261011), np.array(m["theta"]), np.array(m["covariance"]), 20)
    digest = hashlib.sha256(np.round(draws, 9).tobytes()).hexdigest()[:16]
    assert digest == PINNED
