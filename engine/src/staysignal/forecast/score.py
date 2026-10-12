"""Scoring: individual cumulative incidences in memory only (SPEC 9.2, ADR 0014).

For each person in the population, hazards per calendar-month period j = 1..6 after the window start and cause k
give survival S(j) = prod_{l <= j} (1 - sum_k h_k(l)) and cumulative incidence F_k(j) = sum_{l <= j} h_k(l) S(l - 1).
Nothing individual is returned to callers outside the engine's scoring job: cohort aggregation happens next.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np

from staysignal.clock import add_months
from staysignal.features.reference import FeatureRow
from staysignal.model import mnl
from staysignal.model.artifact import Model
from staysignal.model.design import PERIODS, expand, ft_bands, landmark_block, standardize


@dataclass
class Scored:
    rows: list[FeatureRow]
    X: np.ndarray  # (n, 6, p) standardized design
    P: np.ndarray  # (n, 6, 3) hazards with shocks at their mean
    F: np.ndarray  # (n, 6, 3) cumulative incidence by month
    window_start: date


def design_rows(model: Model, rows: list[FeatureRow], window_start: date) -> np.ndarray:
    n = len(rows)
    if n == 0:
        return np.zeros((0, PERIODS, len(model.spec.columns)))
    L = landmark_block(rows, model.spec.knots)
    F = np.array([ft_bands(r) for r in rows], dtype=float)
    idx = np.repeat(np.arange(n), PERIODS)
    per = np.tile(np.arange(1, PERIODS + 1), n)
    mon = np.array([add_months(window_start, int(j) - 1).month for j in per])
    X = standardize(expand(L[idx], F[idx], per, mon, model.spec), model.spec)
    return X.reshape(n, PERIODS, -1)


def cumulative(P: np.ndarray) -> np.ndarray:
    """P (..., 6, 3) per-period cause probabilities -> F (..., 6, 3) cumulative incidence."""
    surv = np.cumprod(1.0 - P.sum(axis=-1), axis=-1)
    prev = np.concatenate([np.ones(P.shape[:-2] + (1,)), surv[..., :-1]], axis=-1)
    return np.cumsum(P * prev[..., None], axis=-2)


def score(model: Model, rows: list[FeatureRow], window_start: date, theta: np.ndarray | None = None) -> Scored:
    X = design_rows(model, rows, window_start)
    B = model.pk.unpack(model.theta if theta is None else theta)
    n = len(rows)
    P = mnl.probabilities(X.reshape(n * PERIODS, -1), B).reshape(n, PERIODS, 3) if n else np.zeros((0, PERIODS, 3))
    return Scored(rows, X, P, cumulative(P), window_start)
