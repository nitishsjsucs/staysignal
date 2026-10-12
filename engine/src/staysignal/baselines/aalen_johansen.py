"""The `aj` baseline (SPEC 9.4): Aalen-Johansen marginal cumulative incidence per organization from the training
landmarks, with binomial (independence) intervals. Own implementation on the monthly grid, no dependency.

Each landmark s contributes everyone in the population at (s, v = s) for calendar months j = 1..6 after s until the
first event, with outcomes as known at the training vintage and the matured rule of SPEC 9.1 (month j counts only when
it ends at least 75 days before T). With n_j at risk and d_kj events of cause k in month j:

    h_k(j) = d_kj / n_j,    S(j) = S(j - 1) * (1 - sum_k h_k(j)),    F_k(h) = sum_{j <= h} S(j - 1) * h_k(j)

so F_k is competing-risks-correct: a person who retired can no longer resign. Organizations use their own curve; the
company pools everyone. Synthetic world only.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import numpy as np
from scipy.stats import binom

from staysignal.clock import REPORTING_BUFFER_DAYS, add_months, as_cutoff_datetime
from staysignal.features.reference import Vintage, features_at, outcomes_at
from staysignal.ingest.landing import Sources

CAUSES = ("voluntary", "involuntary", "retirement")
PERIODS = 6


def aj_curve(at_risk: list[int], events: list[list[int]]) -> np.ndarray:
    """Cumulative incidence F[k, h - 1] for causes k and months h = 1..len(at_risk) from per-month counts:
    at_risk[j] people at risk at the start of month j + 1, events[j][k] events of cause k in it."""
    n = len(at_risk)
    out = np.zeros((len(CAUSES), n))
    surv = 1.0
    cum = np.zeros(len(CAUSES))
    for j in range(n):
        if at_risk[j] > 0:
            h = np.array(events[j], dtype=float) / at_risk[j]
            cum = cum + surv * h
            surv *= 1.0 - h.sum()
        out[:, j] = cum
    return out


@dataclass
class AJModel:
    T: date
    metric_def: str
    curves: dict[str, np.ndarray] = field(default_factory=dict)  # cohort id -> F[cause, month]
    at_risk: dict[str, list[int]] = field(default_factory=dict)

    def incidence(self, cohort_id: str, h: int, cause: str = "voluntary") -> float:
        curve = self.curves.get(cohort_id, self.curves["company"])
        return float(curve[CAUSES.index(cause), h - 1])

    def forecast(self, cohort_id: str, n: int, h: int) -> dict:
        """Expected voluntary departures for a cohort of n people over h months, with binomial 80% and 95% ranges."""
        p = self.incidence(cohort_id, h)
        return {
            "expected": n * p,
            "i80": [int(binom.ppf(0.10, n, p)), int(binom.ppf(0.90, n, p))],
            "i95": [int(binom.ppf(0.025, n, p)), int(binom.ppf(0.975, n, p))],
        }


def fit(
    src: Sources,
    T: date,
    vintage_T: datetime,
    landmarks: list[date],
    metric_def: str = "voluntary_departures@2",
    buffer_days: int = REPORTING_BUFFER_DAYS,
) -> AJModel:
    vin_T = Vintage(src, vintage_T)
    at_risk: dict[str, list[int]] = defaultdict(lambda: [0] * PERIODS)
    events: dict[str, list[list[int]]] = defaultdict(lambda: [[0, 0, 0] for _ in range(PERIODS)])
    for s in landmarks:
        rows = features_at(Vintage(src, as_cutoff_datetime(s)), s, metric_def=metric_def)
        outs = outcomes_at(vin_T, s, [r.employee_number for r in rows])
        for r in rows:
            o = outs[r.employee_number]
            if o.cause == "not_employed":
                continue  # known at T to have left before s
            for cid in ("company", f"org:{r.org}"):
                for j in range(1, PERIODS + 1):
                    lo, hi = add_months(s, j - 1), add_months(s, j)
                    if hi + timedelta(days=buffer_days) > T:
                        break
                    at_risk[cid][j - 1] += 1
                    if o.end is not None and lo < o.end <= hi:
                        events[cid][j - 1][CAUSES.index(o.cause or "involuntary")] += 1
                        break
    model = AJModel(T, metric_def)
    for cid in at_risk:
        model.at_risk[cid] = list(at_risk[cid])
        model.curves[cid] = aj_curve(at_risk[cid], events[cid])
    return model


__all__ = ["AJModel", "CAUSES", "aj_curve", "fit"]
