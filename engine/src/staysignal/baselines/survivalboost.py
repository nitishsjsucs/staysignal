"""The challenger `survivalboost` (SPEC 9.4): `hazardous` 0.2.0 SurvivalBoost (MIT), installed with the optional uv
extra `challenger`. A gradient-boosted competing-risks model of the cumulative incidence in continuous time, fitted
on person-landmark rows (duration in days up to 180, cause) from quarterly landmarks, at most 12,000 rows.

The rows are the main model's own training people at those landmarks (`model.train.collect_landmarks`), so the
challenger sees exactly what the main model sees as known at the origin: each person is followed to the end of their
last matured month (the 75-day reporting buffer), and an exit counts only if it falls inside that window. The same
sampled people also train a like-for-like `dtcr-mnl` (`dtcr-mnl-12k`), so the row cap is a handicap both carry.

Cohort intervals: Poisson-binomial (independent people), and a shock-aware variant that multiplies each person's
cumulative incidence by mean-one lognormal organization and team shocks with the main model's sigma estimates.
Synthetic world only.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

import numpy as np

from staysignal.clock import add_months
from staysignal.features.reference import DAYS_PER_MONTH, FeatureRow, Outcome
from staysignal.model.train import Collected
from staysignal.world.spec import JOB_FAMILIES, LEVEL_BANDS

ROW_CAP = 12_000
N_ITER = 100
MAX_DAYS = 180
FIRST_PROMO = ["le18", "18to36", "gt36", "none_yet"]
FEATURES = [
    "tenure_months",
    "time_in_role_months",
    "months_since_promotion",
    "first_promotion_status",
    "manager_changes_180d",
    "compa_ratio",
    "prior_team_rate",
    "reorg_90d",
    "fixed_term",
    "fixed_term_days_remaining",
    "job_family",
    "level_band",
    "org",
    "landmark_month",
]


def available() -> bool:
    try:
        import hazardous  # noqa: F401
    except ImportError:
        return False
    return True


def quarterly_landmarks(landmarks: list[date]) -> list[date]:
    """The quarter-start landmarks (January, April, July, October) among the main model's monthly landmarks."""
    return [s for s in landmarks if s.month in (1, 4, 7, 10)]


def raw_features(row: FeatureRow, landmark: date, orgs: list[str]) -> list[float]:
    """Fourteen features with no spline or standardization (trees do not need them); categories as integer codes."""
    families = sorted(JOB_FAMILIES)
    ft = row.fixed_term_days_remaining
    return [
        row.tenure_days / DAYS_PER_MONTH,
        row.time_in_role_days / DAYS_PER_MONTH,
        row.days_since_last_promotion / DAYS_PER_MONTH,
        float(FIRST_PROMO.index(row.first_promotion_status)),
        float(min(row.manager_changes_180d, 3)),
        row.compa_ratio if row.compa_ratio is not None else 1.0,
        row.prior_team_rate,
        float(row.reorg_exposure_90d),
        float(row.employment_type == "fixed_term"),
        float(ft) if row.employment_type == "fixed_term" and ft is not None else -1.0,
        float(families.index(row.job_family)) if row.job_family in families else -1.0,
        float(LEVEL_BANDS.index(row.level_band)),
        float(orgs.index(row.org)) if row.org in orgs else -1.0,
        float(landmark.month),
    ]


def sample(collected: list[Collected], cap: int = ROW_CAP, seed: int = 0) -> list[Collected]:
    """At most `cap` person-landmarks drawn uniformly without replacement (deterministic for a seed), kept in
    landmark order so the training set assembles as usual."""
    pairs = [(li, i) for li, c in enumerate(collected) for i in range(len(c.rows))]
    if len(pairs) > cap:
        rng = np.random.default_rng(seed)
        chosen = set(map(tuple, np.array(pairs)[rng.choice(len(pairs), size=cap, replace=False)].tolist()))
    else:
        chosen = set(pairs)
    out = []
    for li, c in enumerate(collected):
        idx = [i for i in range(len(c.rows)) if (li, i) in chosen]
        out.append(Collected(c.s, [c.rows[i] for i in idx], [c.periods[i] for i in idx], [c.causes[i] for i in idx]))
    return out


@dataclass
class SurvivalRows:
    X: np.ndarray
    event: np.ndarray  # 0 censored, 1 voluntary, 2 involuntary, 3 retirement
    duration: np.ndarray  # days after the landmark


def survival_rows(collected: list[Collected], outcomes: list[dict[str, Outcome]], orgs: list[str]) -> SurvivalRows:
    """Each person-landmark followed to the end of their last matured month, capped at 180 days."""
    X, ev, du = [], [], []
    for c, outs in zip(collected, outcomes, strict=True):
        for r, n_periods, causes in zip(c.rows, c.periods, c.causes, strict=True):
            follow_end = add_months(c.s, n_periods)
            limit = min((follow_end - c.s).days, MAX_DAYS)
            o = outs[r.employee_number]
            event = 0
            days = limit
            if causes and causes[-1] >= 0 and o.end is not None and (o.end - c.s).days <= limit:
                event = causes[-1] + 1
                days = max(1, (o.end - c.s).days)
            X.append(raw_features(r, c.s, orgs))
            ev.append(event)
            du.append(days)
    return SurvivalRows(np.array(X, dtype=float), np.array(ev, dtype=np.int64), np.array(du, dtype=float))


def fit(rows: SurvivalRows, n_iter: int = N_ITER, seed: int = 0):
    from hazardous import SurvivalBoost

    model = SurvivalBoost(n_iter=n_iter, ipcw_strategy="kaplan-meier", show_progressbar=False, random_state=seed)
    model.fit(rows.X, {"event": rows.event, "duration": rows.duration})
    return model


def voluntary_cif(model, X: np.ndarray, days: list[int]) -> np.ndarray:
    """(n, len(days)) cumulative incidence of a voluntary exit by each horizon."""
    curves = model.predict_cumulative_incidence(X, times=np.asarray(days, dtype=float))
    col = int(np.flatnonzero(np.asarray(model.event_ids_) == 1)[0])
    return np.clip(curves[:, col, :], 0.0, 1.0)


def poisson_binomial_pmf(p: np.ndarray) -> np.ndarray:
    pmf = np.zeros(len(p) + 1)
    pmf[0] = 1.0
    for k, q in enumerate(p, start=1):
        pmf[1 : k + 1] = pmf[1 : k + 1] * (1.0 - q) + pmf[:k] * q
        pmf[0] *= 1.0 - q
    return pmf


def quantiles_of_pmf(pmf: np.ndarray, qs: list[float]) -> list[float]:
    cdf = np.cumsum(pmf)
    return [float(np.searchsorted(cdf, q - 1e-12)) for q in qs]


def poisson_binomial_forecast(p: np.ndarray) -> dict:
    """Expected count and equal-tailed 80% and 95% intervals for independent people with probabilities p."""
    pmf = poisson_binomial_pmf(p)
    lo80, hi80, lo95, hi95 = quantiles_of_pmf(pmf, [0.10, 0.90, 0.025, 0.975])
    return {"expected": float(p.sum()), "i80": [lo80, hi80], "i95": [lo95, hi95]}


def shock_forecast(
    p: np.ndarray,
    orgs: np.ndarray,
    teams: np.ndarray,
    sigma_org_draws: list[float],
    sigma_team_draws: list[float],
    draws: int = 2000,
    seed: int = 0,
) -> dict:
    """Counts with shared shocks: per draw, a sigma pair from the main model's bootstrap draws, one mean-one lognormal
    shock per organization and per team, each person's probability scaled by both (capped at 1)."""
    rng = np.random.default_rng(seed)
    org_codes = np.unique(orgs, return_inverse=True)[1]
    team_codes = np.unique(teams, return_inverse=True)[1]
    counts = np.empty(draws)
    for d in range(draws):
        so = sigma_org_draws[d % len(sigma_org_draws)] if sigma_org_draws else 0.0
        st = sigma_team_draws[d % len(sigma_team_draws)] if sigma_team_draws else 0.0
        uo = np.exp(so * rng.standard_normal(org_codes.max() + 1) - 0.5 * so * so)
        ut = np.exp(st * rng.standard_normal(team_codes.max() + 1) - 0.5 * st * st)
        q = np.minimum(1.0, p * uo[org_codes] * ut[team_codes])
        counts[d] = float((rng.random(len(q)) < q).sum())
    lo80, hi80, lo95, hi95 = np.quantile(counts, [0.10, 0.90, 0.025, 0.975], method="inverted_cdf")
    return {"expected": float(p.sum()), "i80": [float(lo80), float(hi80)], "i95": [float(lo95), float(hi95)]}


def horizon_days(origin: date, months: int) -> int:
    return (add_months(origin, months) - origin).days


def seed_for(origin: date) -> int:
    return int(origin.strftime("%Y%m%d")) % (2**31 - 1)


def describe() -> dict:
    return {
        "model": "survivalboost",
        "package": "hazardous 0.2.0 (MIT)",
        "rows": f"person-landmarks at quarterly landmarks, at most {ROW_CAP:,}, followed up to {MAX_DAYS} days",
        "features": FEATURES,
        "ipcw_strategy": "kaplan-meier",
        "intervals": "Poisson-binomial; shock-aware variant with the main model's sigma draws",
    }


__all__ = [
    "N_ITER",
    "ROW_CAP",
    "SurvivalRows",
    "available",
    "fit",
    "horizon_days",
    "poisson_binomial_forecast",
    "poisson_binomial_pmf",
    "quarterly_landmarks",
    "raw_features",
    "sample",
    "seed_for",
    "shock_forecast",
    "survival_rows",
    "voluntary_cif",
]
