"""The status-quo baseline `hist` (SPEC 9.4): each cohort's trailing 12-month voluntary rate, scaled to the horizon,
with binomial (independence) intervals. This is the "normalized" number a team would quote without a model."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

import numpy as np
from scipy.stats import binom

from staysignal.clock import add_months
from staysignal.features.reference import DAYS_PER_MONTH, FeatureRow, Vintage
from staysignal.forecast.cohorts import COMPANY
from staysignal.semantic.definitions import excludes
from staysignal.world.spec import level_band, tenure_band


def cohort_ids(org: str, group: str, team: str, lband: str, tband: str) -> list[str]:
    return [
        "company",
        f"org:{org}",
        f"group:{group}",
        f"team:{team}",
        f"org_level:{org}|{lband}",
        f"org_tenure:{org}|{tband}",
    ]


def trailing_rates(vin: Vintage, c: date, metric_def: str = "voluntary_departures@1") -> dict[str, dict[str, float]]:
    """Per cohort id: voluntary departures in [c - 12 months, c) and average headcount over the 12 month starts."""
    lo = add_months(c, -12)
    deps: dict[str, int] = defaultdict(int)
    for spells in vin.spells.values():
        for sp in spells:
            if sp.cause != "voluntary" or sp.end is None or not (lo <= sp.end < c):
                continue
            recs = [r for r in sp.records if r.record_type != "termination"]
            if not recs:
                continue
            a = recs[-1]
            if excludes(metric_def, a.employment_type):
                continue
            group, org = vin.team_info(a.team_id, sp.end)
            tb = tenure_band((sp.end - sp.start).days / DAYS_PER_MONTH)
            for cid in cohort_ids(org, group, a.team_id, level_band(a.level), tb):
                deps[cid] += 1
    hc: dict[str, float] = defaultdict(float)
    for m in range(12):
        d = add_months(lo, m)
        for en, a in vin.assignments_at(d).items():
            if excludes(metric_def, a.employment_type):
                continue
            sp = vin.spell_at(en, d)
            group, org = vin.team_info(a.team_id, d)
            tb = tenure_band(((d - sp.start).days if sp else 0) / DAYS_PER_MONTH)
            for cid in cohort_ids(org, group, a.team_id, level_band(a.level), tb):
                hc[cid] += 1.0 / 12.0
    return {
        cid: {
            "departures": float(deps.get(cid, 0)),
            "avg_headcount": hc[cid],
            "annual_rate": (deps.get(cid, 0) / hc[cid]) if hc[cid] > 0 else 0.0,
        }
        for cid in hc
    }


def hist_forecast(rate: float, n: int, horizon_months: int) -> dict[str, float]:
    p = 1.0 - (1.0 - min(rate, 0.99)) ** (horizon_months / 12.0)
    lo80, hi80 = binom.ppf([0.10, 0.90], n, p)
    lo95, hi95 = binom.ppf([0.025, 0.975], n, p)
    return {
        "expected": n * p,
        "annual_rate": rate,
        "lo80": float(lo80),
        "hi80": float(hi80),
        "lo95": float(lo95),
        "hi95": float(hi95),
    }


__all__ = ["COMPANY", "FeatureRow", "hist_forecast", "trailing_rates", "np", "timedelta"]
