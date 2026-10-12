"""Proxy strength (SPEC 17.7): how well tenure band and level band, which the forecast uses, separate the audit-only
age-40-or-over flag. Reported as the AUC of each ordinal band for the flag (0.5 means no information; ties count
one half), computed on the people employed at the audit date. Tenure correlates with age, which matters under the
ADEA; that is why the action audit screens by tenure band and why retirement is a cohort-level baseline."""

from __future__ import annotations

from collections import Counter
from datetime import date

from staysignal.features.reference import DAYS_PER_MONTH, Vintage
from staysignal.world.spec import LEVEL_BANDS, TENURE_BANDS, level_band, tenure_band


def auc(scores_pos: list[int], scores_neg: list[int]) -> float | None:
    """Mann-Whitney AUC from integer scores: P(positive > negative) + one half of P(tie)."""
    if not scores_pos or not scores_neg:
        return None
    neg = Counter(scores_neg)
    total = 0.0
    for s in scores_pos:
        less = sum(c for k, c in neg.items() if k < s)
        total += less + 0.5 * neg.get(s, 0)
    return total / (len(scores_pos) * len(scores_neg))


def proxy_strength(vin: Vintage, d: date, age40: dict[str, date | None]) -> dict:
    tenure_pos, tenure_neg, level_pos, level_neg = [], [], [], []
    for en, a in vin.assignments_at(d).items():
        sp = vin.spell_at(en, d)
        t = TENURE_BANDS.index(tenure_band(((d - sp.start).days if sp else 0) / DAYS_PER_MONTH))
        lv = LEVEL_BANDS.index(level_band(a.level))
        since = age40.get(en)
        if since is not None and since <= d:
            tenure_pos.append(t)
            level_pos.append(lv)
        else:
            tenure_neg.append(t)
            level_neg.append(lv)
    a_t, a_l = auc(tenure_pos, tenure_neg), auc(level_pos, level_neg)
    return {
        "date": d.isoformat(),
        "people": len(tenure_pos) + len(tenure_neg),
        "tenure_band_auc": None if a_t is None else round(a_t, 3),
        "level_band_auc": None if a_l is None else round(a_l, 3),
        "note": "AUC of each ordinal band for the audit-only age-40-or-over flag; 0.5 means the band carries no age information.",
    }


__all__ = ["auc", "proxy_strength"]
