"""Equivalence by two one-sided tests on a seed bootstrap (research/PREREGISTRATION.md): resample the seeds with
replacement (each seed keeps all its origins together), recompute the metric, and test whether it lies inside the
equivalence bounds. Each one-sided p-value is the bootstrap share on the wrong side of its bound (with the usual +1
correction); the TOST p-value is the larger of the two, and equivalence at alpha 0.05 is the same as the bootstrap 90%
interval lying inside the bounds."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

import numpy as np

RESAMPLES = 2000
ALPHA = 0.05


@dataclass(frozen=True)
class Tost:
    estimate: float
    lo90: float
    hi90: float
    p_lower: float
    p_upper: float
    p: float
    equivalent: bool


def seed_bootstrap(
    per_seed: Sequence[Sequence[float]], stat: Callable[[np.ndarray], float], resamples: int = RESAMPLES, seed: int = 0
) -> np.ndarray:
    """per_seed: one list of window values per seed. Returns the statistic over `resamples` seed resamples."""
    groups = [np.asarray(v, dtype=float) for v in per_seed]
    rng = np.random.default_rng(seed)
    out = np.empty(resamples)
    k = len(groups)
    for b in range(resamples):
        pick = rng.integers(0, k, size=k)
        out[b] = stat(np.concatenate([groups[i] for i in pick]))
    return out


def tost(
    per_seed: Sequence[Sequence[float]],
    bounds: tuple[float, float],
    stat: Callable[[np.ndarray], float] = np.mean,
    resamples: int = RESAMPLES,
    seed: int = 0,
) -> Tost:
    lo, hi = bounds
    est = float(stat(np.concatenate([np.asarray(v, dtype=float) for v in per_seed])))
    boot = seed_bootstrap(per_seed, stat, resamples, seed)
    p_lower = float((np.sum(boot <= lo) + 1) / (resamples + 1))
    p_upper = float((np.sum(boot >= hi) + 1) / (resamples + 1))
    p = max(p_lower, p_upper)
    lo90, hi90 = (float(x) for x in np.quantile(boot, [0.05, 0.95]))
    return Tost(est, lo90, hi90, p_lower, p_upper, p, p < ALPHA)


def ks_uniform(u: Sequence[float]) -> float:
    """Kolmogorov-Smirnov distance between values in [0, 1] and the uniform distribution."""
    x = np.sort(np.asarray(u, dtype=float))
    n = len(x)
    if n == 0:
        return float("nan")
    i = np.arange(1, n + 1)
    return float(max(np.max(i / n - x), np.max(x - (i - 1) / n)))


__all__ = ["ALPHA", "RESAMPLES", "Tost", "ks_uniform", "seed_bootstrap", "tost"]
