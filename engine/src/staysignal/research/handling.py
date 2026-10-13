"""Handling choices (research/PREREGISTRATION.md): how a training set is built from what was recorded.

- matured or naive: a training row (landmark s, period j) counts only when the period ended at least 75 days before
  the origin (matured, the 9.1 rule), or as soon as it ended (naive: an unreported exit looks like a stay);
- missing extract treated as no events (as recorded) or as censored (each person-landmark is followed only up to the
  missing month; a landmark inside it is dropped);
- duplicates not deduplicated (a departure recorded twice counts twice: its person-landmark appears twice) or
  deduplicated (as recorded once).
"""

from __future__ import annotations

from datetime import date

from staysignal.clock import add_months
from staysignal.model.train import Collected


def censor_month(collected: list[Collected], month: tuple[int, int]) -> list[Collected]:
    hole = date(month[0], month[1], 1)
    out = []
    for c in collected:
        rows, periods, causes = [], [], []
        for r, p, cs in zip(c.rows, c.periods, c.causes, strict=True):
            keep = p
            for j in range(1, p + 1):
                if add_months(c.s, j - 1) == hole:
                    keep = j - 1
                    break
            if keep <= 0:
                continue
            rows.append(r)
            periods.append(keep)
            causes.append(cs[:keep])
        out.append(Collected(c.s, rows, periods, causes))
    return out


def duplicate_exits(collected: list[Collected], duplicated: frozenset[str]) -> list[Collected]:
    out = []
    for c in collected:
        rows, periods, causes = list(c.rows), list(c.periods), list(c.causes)
        for r, p, cs in zip(c.rows, c.periods, c.causes, strict=True):
            if cs and cs[-1] >= 0 and r.employee_number in duplicated:
                rows.append(r)
                periods.append(p)
                causes.append(list(cs))
        out.append(Collected(c.s, rows, periods, causes))
    return out


__all__ = ["censor_month", "duplicate_exits"]
