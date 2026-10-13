"""C52: the equivalence test of the pre-registration (two one-sided tests on a seed bootstrap) and the PIT distance."""

import numpy as np

from staysignal.research.tost import ks_uniform, tost


def _seeds(center: float, spread: float, n_seeds: int = 20, per_seed: int = 8, seed: int = 1) -> list[list[float]]:
    rng = np.random.default_rng(seed)
    return [list(center + spread * rng.standard_normal(per_seed)) for _ in range(n_seeds)]


def test_equivalent_when_centered_and_precise():
    t = tost(_seeds(1.0, 0.05), (0.95, 1.05))
    assert t.equivalent and t.p < 0.05
    assert 0.95 < t.lo90 < t.estimate < t.hi90 < 1.05


def test_not_equivalent_when_shifted_or_noisy():
    assert not tost(_seeds(1.08, 0.05), (0.95, 1.05)).equivalent
    assert tost(_seeds(1.08, 0.05), (0.95, 1.05)).p_upper > 0.5
    assert not tost(_seeds(1.0, 0.6), (0.95, 1.05)).equivalent


def test_the_bootstrap_keeps_a_seeds_origins_together():
    # one seed far off with many windows moves the estimate, and its windows are resampled as a block
    seeds = _seeds(1.0, 0.01, n_seeds=19) + [[2.0] * 8]
    t = tost(seeds, (0.95, 1.05))
    assert t.estimate > 1.04 and not t.equivalent


def test_ks_distance_to_uniform():
    assert ks_uniform(np.linspace(0.0025, 0.9975, 200)) < 0.01
    assert ks_uniform(np.full(100, 0.9)) > 0.8
