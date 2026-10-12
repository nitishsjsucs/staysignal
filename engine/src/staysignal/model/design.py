"""Design matrices for the landmark discrete-time competing-risks model (SPEC 9.1).

One shared matrix holds every column; each cause uses a subset (its mask):
  voluntary and involuntary: tenure spline, role and promotion indicators, first-promotion status, manager changes,
    pay below and above the band midpoint, prior team departure rate, reorganization exposure, job family, level band,
    organization, fixed-term status, Fourier terms of the period's calendar month;
  involuntary also: fixed-term days remaining, banded;
  retirement: organization only (a cohort-level baseline, so no individual age proxy is scored).
Every cause also has its own intercept and period deviations (periods 2 to 6 after the landmark).
Continuous columns are standardized with training means and scales stored in the artifact.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from staysignal.features.reference import DAYS_PER_MONTH, FeatureRow
from staysignal.world.spec import JOB_FAMILIES

CAUSES = ("voluntary", "involuntary", "retirement")
PERIODS = 6
FAMILY_BASE = "SWE"
FAMILIES = [f for f in JOB_FAMILIES if f != FAMILY_BASE]
LEVEL_BANDS_X = ["early", "senior", "manager"]  # base: mid
FIRST_PROMO_X = ["none_yet", "18to36", "gt36"]  # base: le18
FT_BANDS = ["ft_le90", "ft_91to180", "ft_gt180"]
ORG_BASE = "Engineering"
ORGS = [
    "Product & Design",
    "Sales",
    "Customer Success & Support",
    "Marketing",
    "Finance",
    "People",
    "Legal",
    "IT & Operations",
]
SPLINE_QUANTILES = (0.2, 0.4, 0.6, 0.8)


def spline_basis(x: np.ndarray, knots: list[float]) -> np.ndarray:
    """Natural cubic spline basis without the constant (Hastie, Tibshirani and Friedman, eq. 5.4 to 5.5):
    x and K - 2 nonlinear terms that are linear beyond the boundary knots."""
    k = np.asarray(knots, dtype=float)
    K = len(k)

    def d(j: int) -> np.ndarray:
        return (np.maximum(x - k[j], 0.0) ** 3 - np.maximum(x - k[K - 1], 0.0) ** 3) / (k[K - 1] - k[j])

    cols = [x]
    dk = d(K - 2)
    for j in range(K - 2):
        cols.append(d(j) - dk)
    return np.column_stack(cols)


def log_tenure(row: FeatureRow) -> float:
    return math.log1p(row.tenure_days / DAYS_PER_MONTH)


@dataclass
class DesignSpec:
    knots: list[float]
    columns: list[str] = field(default_factory=list)
    mean: list[float] = field(default_factory=list)
    scale: list[float] = field(default_factory=list)
    masks: dict[str, list[int]] = field(default_factory=dict)
    penalized: list[bool] = field(default_factory=list)

    @staticmethod
    def column_names(knots: list[float]) -> list[str]:
        cols = ["intercept"] + [f"period_{j}" for j in range(2, PERIODS + 1)]
        cols += [f"tenure_s{i}" for i in range(1, len(knots) - 1 + 1)]
        cols += ["role_gt30m", "since_promo_ge24m"] + [f"first_promo_{x}" for x in FIRST_PROMO_X]
        cols += [
            "manager_changes_180d",
            "comp_below_mid",
            "comp_above_mid",
            "prior_team_rate",
            "reorg_90d",
            "fixed_term",
        ]
        cols += [f"family_{f}" for f in FAMILIES] + [f"band_{b}" for b in LEVEL_BANDS_X] + [f"org_{o}" for o in ORGS]
        cols += ["month_sin1", "month_cos1", "month_sin2", "month_cos2"] + FT_BANDS
        return cols

    @classmethod
    def build(cls, rows: list[FeatureRow]) -> DesignSpec:
        lt = np.array([log_tenure(r) for r in rows], dtype=float)
        knots = [float(np.quantile(lt, q)) for q in SPLINE_QUANTILES]
        spec = cls(knots=knots)
        spec.columns = cls.column_names(knots)
        idx = {c: i for i, c in enumerate(spec.columns)}
        shared = [
            c for c in spec.columns if c not in ("intercept",) and not c.startswith("period_") and c not in FT_BANDS
        ]
        base = [idx["intercept"]] + [idx[f"period_{j}"] for j in range(2, PERIODS + 1)]
        spec.masks = {
            "voluntary": base + [idx[c] for c in shared],
            "involuntary": base + [idx[c] for c in shared] + [idx[c] for c in FT_BANDS],
            "retirement": base + [idx[f"org_{o}"] for o in ORGS],
        }
        spec.penalized = [c != "intercept" for c in spec.columns]
        return spec


def row_features(row: FeatureRow, knots: list[float]) -> list[float]:
    """Landmark-level columns (everything except the intercept, the period and the calendar month)."""
    lt = math.log1p(row.tenure_days / DAYS_PER_MONTH)
    spl = spline_basis(np.array([lt]), knots)[0].tolist()
    compa = row.compa_ratio if row.compa_ratio is not None else 1.0
    out = spl + [
        float(row.time_in_role_days / DAYS_PER_MONTH > 30),
        float(row.days_since_last_promotion / DAYS_PER_MONTH >= 24),
    ]
    out += [float(row.first_promotion_status == x) for x in FIRST_PROMO_X]
    out += [
        float(min(row.manager_changes_180d, 3)),
        max(0.0, 1.0 - compa),
        min(max(0.0, compa - 1.0), 0.5),
        row.prior_team_rate,
        float(row.reorg_exposure_90d),
        float(row.employment_type == "fixed_term"),
    ]
    out += [float(row.job_family == f) for f in FAMILIES]
    out += [float(row.level_band == b) for b in LEVEL_BANDS_X]
    out += [float(row.org == o) for o in ORGS]
    return out


def ft_bands(row: FeatureRow) -> list[float]:
    ft = row.fixed_term_days_remaining
    if row.employment_type != "fixed_term" or ft is None:
        return [0.0, 0.0, 0.0]
    return [float(ft <= 90), float(90 < ft <= 180), float(ft > 180)]


def month_terms(month: int) -> list[float]:
    a = 2.0 * math.pi * (month - 1) / 12.0
    return [math.sin(a), math.cos(a), math.sin(2 * a), math.cos(2 * a)]


def landmark_block(rows: list[FeatureRow], knots: list[float]) -> np.ndarray:
    """(n_people, n_landmark_columns) for the columns after the period block, excluding month and FT terms."""
    return np.array([row_features(r, knots) for r in rows], dtype=float).reshape(len(rows), -1)


def expand(landmark: np.ndarray, ft: np.ndarray, period: np.ndarray, month: np.ndarray, spec: DesignSpec) -> np.ndarray:
    """Full raw design (before standardization) for person-period rows.

    landmark: (n, L) landmark columns per row; ft: (n, 3); period: (n,) in 1..6; month: (n,) calendar month 1..12."""
    n = landmark.shape[0]
    X = np.zeros((n, len(spec.columns)), dtype=float)
    X[:, 0] = 1.0
    for j in range(2, PERIODS + 1):
        X[:, j - 1] = (period == j).astype(float)
    off = PERIODS
    X[:, off : off + landmark.shape[1]] = landmark
    off += landmark.shape[1]
    ang = 2.0 * np.pi * (month - 1) / 12.0
    X[:, off] = np.sin(ang)
    X[:, off + 1] = np.cos(ang)
    X[:, off + 2] = np.sin(2 * ang)
    X[:, off + 3] = np.cos(2 * ang)
    X[:, off + 4 : off + 7] = ft
    return X


def standardize_fit(X: np.ndarray, spec: DesignSpec) -> None:
    """Means and scales of non-intercept, non-period columns; binary and period columns are left as they are."""
    mean = np.zeros(X.shape[1])
    scale = np.ones(X.shape[1])
    for i, c in enumerate(spec.columns):
        if c == "intercept" or c.startswith("period_"):
            continue
        col = X[:, i]
        if set(np.unique(col)).issubset({0.0, 1.0}):
            continue
        sd = float(col.std())
        if sd > 0:
            mean[i] = float(col.mean())
            scale[i] = sd
    spec.mean = mean.tolist()
    spec.scale = scale.tolist()


def standardize(X: np.ndarray, spec: DesignSpec) -> np.ndarray:
    return (X - np.asarray(spec.mean)) / np.asarray(spec.scale)
