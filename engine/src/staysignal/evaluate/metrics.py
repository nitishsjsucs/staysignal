"""Evaluation metrics (SPEC 10), each pinned by a hand-computed unit test (`engine/tests/evaluate/test_metrics.py`).

Counts: MAE, RMSE and skill against `hist`; observed over expected (calibration-in-the-large); interval coverage and
the interval (Winkler) score; the non-randomized PIT for count forecasts and the ranked probability score, both from a
forecast's predictive distribution given as Monte Carlo draws. Individuals: the reliability table by deciles of
predicted cumulative incidence and the integrated calibration index with E50 and E90 from a local-linear smoother.
Uncertainty over origins: a moving-block bootstrap with block length h months, and the effective number of
independent windows (origins divided by h, rounded down). Synthetic world only."""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np


def mae(errors: Sequence[float]) -> float:
    return float(np.mean(np.abs(errors)))


def rmse(errors: Sequence[float]) -> float:
    return float(np.sqrt(np.mean(np.square(errors))))


def skill(mae_model: float, mae_reference: float) -> float:
    """1 - MAE_model / MAE_reference: positive when the model beats the reference."""
    return float("nan") if mae_reference == 0 else 1.0 - mae_model / mae_reference


def observed_over_expected(observed: Sequence[float], expected: Sequence[float]) -> float:
    e = float(np.sum(expected))
    return float("nan") if e == 0 else float(np.sum(observed)) / e


def covered(actual: float, interval: Sequence[float]) -> bool:
    return interval[0] <= actual <= interval[1]


def interval_score(actual: float, interval: Sequence[float], level: float) -> float:
    """Winkler score of a central interval at `level` (lower is better): width plus 2 / alpha times the miss."""
    lo, hi = interval
    alpha = 1.0 - level
    return (hi - lo) + (2.0 / alpha) * max(0.0, lo - actual) + (2.0 / alpha) * max(0.0, actual - hi)


def predictive_cdf(draws: np.ndarray, k: int) -> float:
    """P(X <= k) under the empirical distribution of the draws (P(X <= -1) = 0)."""
    return 0.0 if k < 0 else float(np.mean(np.asarray(draws) <= k))


def pit_function(draws: np.ndarray, y: int, u: float) -> float:
    """Non-randomized PIT of a count observation y at u in [0, 1] (Czado, Gneiting and Held 2009)."""
    p_lo, p_hi = predictive_cdf(draws, y - 1), predictive_cdf(draws, y)
    if u <= p_lo:
        return 0.0
    if u >= p_hi:
        return 1.0
    return (u - p_lo) / (p_hi - p_lo)


def pit_histogram(cases: Sequence[tuple[np.ndarray, int]], bins: int = 10) -> list[float]:
    """Mean non-randomized PIT histogram over (draws, observation) cases: bin j holds the average of
    F(j / bins) - F((j - 1) / bins); a calibrated forecast gives about 1 / bins in every bin."""
    out = np.zeros(bins)
    for draws, y in cases:
        f = [pit_function(draws, y, j / bins) for j in range(bins + 1)]
        out += np.diff(f)
    return (out / max(1, len(cases))).tolist()


def ranked_probability_score(draws: np.ndarray, y: int) -> float:
    """RPS of a count forecast: sum over k >= 0 of (P(X <= k) - 1{y <= k})^2, up to the larger of y and max draw."""
    top = int(max(y, np.max(draws)))
    return float(sum((predictive_cdf(draws, k) - (1.0 if y <= k else 0.0)) ** 2 for k in range(top + 1)))


def effective_windows(n_origins: int, h: int) -> int:
    return n_origins // h


def block_bootstrap(
    values: Sequence[float], block: int, n_boot: int = 2000, seed: int = 0, level: float = 0.80
) -> list[float]:
    """Central interval of the mean of `values` (one per consecutive origin) under a moving-block bootstrap."""
    x = np.asarray(values, dtype=float)
    n = len(x)
    if n == 0:
        return [float("nan"), float("nan")]
    b = max(1, min(block, n))
    starts = np.arange(n - b + 1)
    rng = np.random.default_rng(seed)
    k = math.ceil(n / b)
    means = np.empty(n_boot)
    for i in range(n_boot):
        pick = rng.choice(starts, size=k)
        sample = np.concatenate([x[s : s + b] for s in pick])[:n]
        means[i] = sample.mean()
    a = (1.0 - level) / 2.0
    return [float(np.quantile(means, a)), float(np.quantile(means, 1.0 - a))]


def reliability_table(predicted: np.ndarray, observed: np.ndarray, bins: int = 10) -> list[dict]:
    """Deciles of predicted probability: n, mean predicted and observed proportion per bin."""
    p = np.asarray(predicted, dtype=float)
    o = np.asarray(observed, dtype=float)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    out = []
    for j in range(bins):
        m = idx == j
        if m.any():
            out.append(
                {"bin": j + 1, "n": int(m.sum()), "predicted": float(p[m].mean()), "observed": float(o[m].mean())}
            )
    return out


def smooth_calibration(
    predicted: np.ndarray, observed: np.ndarray, span: float = 0.75, grid: int = 200
) -> tuple[np.ndarray, np.ndarray]:
    """Local-linear (tricube) smoother of observed on predicted, evaluated on a quantile grid of the predictions."""
    p = np.asarray(predicted, dtype=float)
    o = np.asarray(observed, dtype=float)
    g = np.unique(np.quantile(p, np.linspace(0, 1, grid)))
    k = max(10, int(span * len(p)))
    fitted = np.empty(len(g))
    for i, x0 in enumerate(g):
        d = np.abs(p - x0)
        h = np.partition(d, min(k, len(d) - 1))[min(k, len(d) - 1)] or 1e-12
        w = np.clip(1 - (d / h) ** 3, 0, None) ** 3
        sw = w.sum()
        xm = (w * p).sum() / sw
        ym = (w * o).sum() / sw
        sxx = (w * (p - xm) ** 2).sum()
        slope = (w * (p - xm) * (o - ym)).sum() / sxx if sxx > 0 else 0.0
        fitted[i] = ym + slope * (x0 - xm)
    return g, fitted


def calibration_indices(predicted: np.ndarray, observed: np.ndarray) -> dict[str, float]:
    """ICI (mean absolute difference between the smoothed observed and the predicted), E50 and E90 (Austin et al.)."""
    p = np.asarray(predicted, dtype=float)
    g, f = smooth_calibration(p, observed)
    diff = np.abs(np.interp(p, g, f) - p)
    return {"ici": float(diff.mean()), "e50": float(np.median(diff)), "e90": float(np.quantile(diff, 0.9))}


__all__ = [
    "block_bootstrap",
    "calibration_indices",
    "covered",
    "effective_windows",
    "interval_score",
    "mae",
    "observed_over_expected",
    "pit_function",
    "pit_histogram",
    "predictive_cdf",
    "ranked_probability_score",
    "reliability_table",
    "rmse",
    "skill",
    "smooth_calibration",
]
