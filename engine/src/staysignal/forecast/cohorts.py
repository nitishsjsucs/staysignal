"""Cohorts the engine publishes (SPEC 9.6): the company, 9 organizations, groups, teams with at least 10 people,
and organization by level band and by tenure band. A cohort is a set of people at the cutoff; no cohort is a person.
Membership never leaves the engine; only n, joiners and leavers do."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from staysignal.features.reference import FeatureRow
from staysignal.world.spec import LEVEL_BANDS, TENURE_BANDS

COMPANY = "Larkspur"
MIN_CELL = 10


@dataclass(frozen=True)
class Cohort:
    id: str
    kind: str  # company | organization | group | team | org_level | org_tenure
    name: str
    parent: str | None


def cohort_index(rows: list[FeatureRow]) -> dict[Cohort, np.ndarray]:
    """Cohort -> member row indices, for cohorts with at least MIN_CELL people (smaller cells are never published)."""
    groups: dict[Cohort, list[int]] = {}

    def add(c: Cohort, i: int) -> None:
        groups.setdefault(c, []).append(i)

    for i, r in enumerate(rows):
        add(Cohort("company", "company", COMPANY, None), i)
        add(Cohort(f"org:{r.org}", "organization", r.org, "company"), i)
        add(Cohort(f"group:{r.group}", "group", r.group, f"org:{r.org}"), i)
        add(Cohort(f"team:{r.team}", "team", r.team, f"group:{r.group}"), i)
        add(Cohort(f"org_level:{r.org}|{r.level_band}", "org_level", f"{r.org} / {r.level_band}", f"org:{r.org}"), i)
        add(
            Cohort(f"org_tenure:{r.org}|{r.tenure_band}", "org_tenure", f"{r.org} / {r.tenure_band}", f"org:{r.org}"), i
        )
    return {c: np.array(ix) for c, ix in sorted(groups.items(), key=lambda kv: kv[0].id) if len(ix) >= MIN_CELL}


def sort_key(cohort_id: str) -> tuple[int, str]:
    order = {"company": 0, "org": 1, "group": 2, "team": 3, "org_level": 4, "org_tenure": 5}
    kind = cohort_id.split(":")[0]
    if kind == "org_level":
        org, band = cohort_id.split(":", 1)[1].split("|")
        return (4, f"{org}|{LEVEL_BANDS.index(band)}")
    if kind == "org_tenure":
        org, band = cohort_id.split(":", 1)[1].split("|")
        return (5, f"{org}|{TENURE_BANDS.index(band)}")
    return (order.get(kind, 9), cohort_id)
