"""The research benchmark's arms (research/PREREGISTRATION.md, SPEC 11): one factor at a time around a base world,
plus one interaction arm. Each arm crosses a data condition (a world, or what its source system recorded) with a
handling choice (how the training set is built, or which intervals are used).

A seed generates a handful of worlds that share its random streams (common random numbers): the base world, the
late-reporting and missing-extract and duplicate variants of what it recorded, and the shock worlds with contagion
off. Each world is fitted once per origin and handling; the arms are read off those fits.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date

from staysignal.world.spec import CANONICAL, SMALL, Profile

ORIGINS = [
    date(2024, 10, 1),
    date(2025, 1, 1),
    date(2025, 4, 1),
    date(2025, 7, 1),
    date(2025, 10, 1),
    date(2026, 1, 1),
    date(2026, 4, 1),
    date(2026, 7, 1),
]
SMALL_ORIGINS = [date(2026, 4, 1), date(2026, 7, 1)]  # the CI run: 2 seeds by 2 origins on the small world
HORIZON = 3
MISSING_MONTH = (2024, 6)  # the month whose HRIS termination extract is missing (before every canonical origin)
SMALL_MISSING_MONTH = (2025, 11)
BASE_SIGMA_TEAM = 0.25


@dataclass(frozen=True)
class Condition:
    """One world as recorded: generator knobs and what happened to its termination records."""

    name: str
    sigma_team: float = BASE_SIGMA_TEAM
    contagion: bool = True
    late_share: float = 0.0
    missing_extract: bool = False
    duplicate_share: float = 0.0


@dataclass(frozen=True)
class Handling:
    """How one fit's training set is built, and which interval methods are scored on it."""

    name: str
    buffer_days: int = 75  # matured (the 9.1 rule); 0 is naive
    missing: str = "none"  # none | no_events | censored
    dedupe: bool = True
    intervals: tuple[str, ...] = ("shock_aware",)


MATURED = Handling("matured")
NAIVE = Handling("naive", buffer_days=0)


@dataclass(frozen=True)
class Plan:
    condition: Condition
    handlings: tuple[Handling, ...] = field(default_factory=tuple)


PLANS: tuple[Plan, ...] = (
    Plan(Condition("base"), (MATURED, NAIVE)),
    Plan(Condition("late_0.15", late_share=0.15), (MATURED, NAIVE)),
    Plan(Condition("late_0.30", late_share=0.30), (MATURED, NAIVE)),
    Plan(
        Condition("missing", missing_extract=True),
        (Handling("no_events", missing="no_events"), Handling("censored", missing="censored")),
    ),
    Plan(
        Condition("shock_0", sigma_team=0.0, contagion=False),
        (Handling("shock", intervals=("independence", "shock_aware")),),
    ),
    Plan(
        Condition("shock_0.25", sigma_team=0.25, contagion=False),
        (Handling("shock", intervals=("independence", "shock_aware")),),
    ),
    Plan(
        Condition("shock_0.5", sigma_team=0.5, contagion=False),
        (Handling("shock", intervals=("independence", "shock_aware")),),
    ),
    Plan(
        Condition("duplicates_0.05", duplicate_share=0.05),
        (Handling("not_deduplicated", dedupe=False), Handling("deduplicated")),
    ),
    Plan(
        Condition("late_0.30_shock_0.5", sigma_team=0.5, contagion=False, late_share=0.30),
        (Handling("matured_shock_aware"), Handling("naive_independence", buffer_days=0, intervals=("independence",))),
    ),
)


@dataclass(frozen=True)
class Arm:
    """A pre-registered cell: factor, level and handling, read from a (condition, handling, interval) fit."""

    factor: str
    level: str
    handling: str
    condition: str
    fit: str
    interval: str = "shock_aware"


def arms() -> list[Arm]:
    """Every pre-registered cell; levels with no data problem reuse the base world's matured fit (both handlings are
    the same training set there)."""
    out: list[Arm] = []
    for level, cond in (("0", "base"), ("0.15", "late_0.15"), ("0.30", "late_0.30")):
        out += [Arm("A", level, "naive", cond, "naive"), Arm("A", level, "matured", cond, "matured")]
    out += [Arm("B", "none", "no_events", "base", "matured"), Arm("B", "none", "censored", "base", "matured")]
    out += [
        Arm("B", "missing", "no_events", "missing", "no_events"),
        Arm("B", "missing", "censored", "missing", "censored"),
    ]
    for level in ("0", "0.25", "0.5"):
        cond = f"shock_{level}"
        out += [
            Arm("C", level, "independence", cond, "shock", "independence"),
            Arm("C", level, "shock_aware", cond, "shock", "shock_aware"),
        ]
    out += [Arm("D", "0", "not_deduplicated", "base", "matured"), Arm("D", "0", "deduplicated", "base", "matured")]
    out += [
        Arm("D", "0.05", "not_deduplicated", "duplicates_0.05", "not_deduplicated"),
        Arm("D", "0.05", "deduplicated", "duplicates_0.05", "deduplicated"),
    ]
    out += [
        Arm("AxC", "0.30 x 0.5", "matured_shock_aware", "late_0.30_shock_0.5", "matured_shock_aware"),
        Arm("AxC", "0.30 x 0.5", "naive_independence", "late_0.30_shock_0.5", "naive_independence", "independence"),
    ]
    return out


def research_profile(seed: int, cond: Condition, small: bool = False) -> Profile:
    """The research profile (SPEC 6.7): the canonical structure (or the small one for CI) with no drift and no planted
    problems; sigma_org is half of sigma_team."""
    base = SMALL if small else CANONICAL
    return replace(
        base,
        name="research-small" if small else "research",
        seed=seed,
        drift=False,
        sigma_team=cond.sigma_team,
        sigma_org=cond.sigma_team / 2.0,
        contagion=cond.contagion,
        planted=None,
        exact_requisitions=None,
        exact_declined_offers=None,
        min_engineering_fixed_term_at_end=0,
        notes=("research benchmark world",),
    )


__all__ = ["ORIGINS", "PLANS", "SMALL_ORIGINS", "Arm", "Condition", "Handling", "Plan", "arms", "research_profile"]
