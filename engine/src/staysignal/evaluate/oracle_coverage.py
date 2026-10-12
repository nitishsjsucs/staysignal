"""C5: realized outcomes are consistent with the truth (SPEC 6.6, 20).

Over quarterly origins x the company and its organizations x causes x horizons, the forward-simulation oracle's 90%
intervals should contain the realized counts in 80% to 97% of cells. The realized counts come from the same generator
run (the truth), so a coverage far from 90% means the oracle and the generator disagree, which would make every
evaluation that uses the oracle wrong. Run before the hazard intercepts are frozen. Synthetic world only.
"""

from __future__ import annotations

import os
import time
from collections import defaultdict
from datetime import date

from staysignal.clock import add_months
from staysignal.world import oracle
from staysignal.world.simulate import simulate
from staysignal.world.spec import Profile

LEVEL = 0.90
BAND = (0.80, 0.97)


def quarterly_origins(
    profile: Profile, first: date = date(2023, 10, 1), last_end: date = date(2026, 10, 1)
) -> list[date]:
    """Quarterly cutoffs from the first landmark whose 6-month window ends by the outcome vintage."""
    out = []
    c = first
    while add_months(c, 6) <= last_end:
        out.append(c)
        c = add_months(c, 3)
    return out


def coverage(
    profile: Profile,
    origins: list[date] | None = None,
    n_futures: int = 2000,
    workers: int | None = None,
    log=print,
) -> dict:
    origins = origins or quarterly_origins(profile)
    workers = workers or max(1, (os.cpu_count() or 2) - 2)
    truth = simulate(profile)
    cells: list[dict] = []
    t_all = time.perf_counter()
    for c in origins:
        t0 = time.perf_counter()
        _, state = oracle.true_state(profile, c)
        futures = oracle.run_futures(state, n_futures=n_futures, workers=workers)
        sim_counts = oracle.counts(state, futures)
        real = oracle.realized(state, truth.outcomes)
        for cohort, by_cause in sim_counts.items():
            n = len(next(co for co in state.cohorts if co.id == cohort).members)
            for cause, by_h in by_cause.items():
                for h, draws in by_h.items():
                    lo, hi = oracle.interval(draws, LEVEL)
                    r = real[cohort][cause][h]
                    cells.append(
                        {
                            "origin": c.isoformat(),
                            "cohort": cohort,
                            "n": n,
                            "cause": cause,
                            "horizon_months": h,
                            "oracle_mean": round(float(draws.mean()), 3),
                            "oracle_i90": [lo, hi],
                            "realized": r,
                            "inside": lo <= r <= hi,
                        }
                    )
        log(f"oracle origin {c}: {len(state.people)} people, {n_futures} futures, {time.perf_counter() - t0:.1f} s")
    by: dict[str, list[bool]] = defaultdict(list)
    for cell in cells:
        by[f"{cell['cause']}|{cell['horizon_months']}"].append(cell["inside"])
    overall = sum(c["inside"] for c in cells) / len(cells)
    return {
        "kind": "oracle-coverage",
        "label": "synthetic world; the oracle and the realized outcomes both come from the generator",
        "profile": profile.name,
        "seed": profile.seed,
        "level": LEVEL,
        "band": list(BAND),
        "n_futures": n_futures,
        "origins": [c.isoformat() for c in origins],
        "cells": len(cells),
        "coverage": round(overall, 4),
        "within_band": BAND[0] <= overall <= BAND[1],
        "by_cause_horizon": {
            k: {"cells": len(v), "coverage": round(sum(v) / len(v), 4)} for k, v in sorted(by.items())
        },
        "seconds": round(time.perf_counter() - t_all, 1),
        "detail": cells,
    }


__all__ = ["BAND", "LEVEL", "coverage", "quarterly_origins"]
