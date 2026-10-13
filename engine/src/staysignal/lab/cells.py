"""Scenario Lab cohort cells (SPEC 15.2, ADR 0008): the only input the personas get from the company.

Cells cross job family, level band, tenure band, time-since-promotion band and reorganization exposure in the last 90
days, over the population at the published run's cutoff. A cell under 10 people is merged by coarsening tenure, then
time since promotion: the merged cell holds the remainder of its siblings that were too small and is labeled `other`,
not `any`, because the larger siblings keep their own cells. What is still under 10 after both steps is withheld and
only counted.

Each cell carries three cohort-level descriptive facts, rounded (shares to 0.05, months to whole months): the share
below band midpoint, the median months since the last promotion (or since hire when never promoted) and the share with
a manager change in 180 days. No individual row, no model output and no protected attribute leaves this module.
Synthetic world only.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date

from staysignal.features.reference import FeatureRow

MIN_CELL = 10
OTHER = "other"
PROMO_BANDS = ("under 12 months", "12 to 24 months", "24 months or more")


def promo_band(days: int) -> str:
    months = days / 30.4375
    return PROMO_BANDS[0] if months < 12 else PROMO_BANDS[1] if months < 24 else PROMO_BANDS[2]


def _key(r: FeatureRow) -> tuple:
    return (r.job_family, r.level_band, r.tenure_band, promo_band(r.days_since_last_promotion), r.reorg_exposure_90d)


def _round(x: float, step: float) -> float:
    return round(round(x / step) * step, 2)


def _facts(rows: list[FeatureRow]) -> dict:
    compa = [r.compa_ratio for r in rows if r.compa_ratio is not None]
    return {
        "share_below_midpoint": _round(sum(1 for c in compa if c < 1.0) / len(compa), 0.05) if compa else None,
        "median_months_since_promotion": round(statistics.median(r.days_since_last_promotion for r in rows) / 30.4375),
        "share_manager_change_180d": _round(sum(1 for r in rows if r.manager_changes_180d > 0) / len(rows), 0.05),
    }


def build_cells(rows: list[FeatureRow]) -> tuple[list[dict], int]:
    """Cells of at least MIN_CELL people and the number withheld, in a stable order."""
    groups: dict[tuple, list[FeatureRow]] = defaultdict(list)
    for r in rows:
        groups[_key(r)].append(r)
    for coarsen in (2, 3):  # tenure, then time since promotion
        merged: dict[tuple, list[FeatureRow]] = defaultdict(list)
        for k, members in groups.items():
            if len(members) >= MIN_CELL:
                merged[k] += members
            else:
                merged[k[:coarsen] + (OTHER,) + k[coarsen + 1 :]] += members
        groups = merged
    cells, withheld = [], 0
    for k in sorted(groups, key=lambda k: tuple(str(x) for x in k)):
        members = groups[k]
        if len(members) < MIN_CELL:
            withheld += len(members)
            continue
        family, level, tenure, promo, reorg = k
        cells.append(
            {
                "cell_id": f"C{len(cells) + 1:03d}",
                "job_family": family,
                "level_band": level,
                "tenure_band": tenure,
                "promotion_band": promo,
                "reorg_90d": reorg,
                "n": len(members),
                "facts": _facts(members),
            }
        )
    return cells, withheld


def export(rows: list[FeatureRow], run_id: str, cutoff: date) -> dict:
    cells, withheld = build_cells(rows)
    return {
        "label": "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.",
        "source": {"run_id": run_id, "cutoff": cutoff.isoformat(), "population": len(rows)},
        "min_cell": MIN_CELL,
        "withheld": withheld,
        "cells": cells,
    }


__all__ = ["MIN_CELL", "OTHER", "PROMO_BANDS", "build_cells", "export", "promo_band"]
