"""The `oracle` baseline in evaluation (SPEC 9.4, 6.6): the forward-simulation oracle's distribution of voluntary
departure counts per cohort and horizon at an origin, for the population of the metric definition (fixed-term
employees removed under voluntary_departures@2). It is the unattainable floor for count error and the coverage
reference: it knows the latent propensities and the generator's exact form. Synthetic world only."""

from __future__ import annotations

from datetime import date

from staysignal.world import oracle
from staysignal.world.spec import Profile


def forecasts(
    profile: Profile,
    origin: date,
    metric_def: str = "voluntary_departures@2",
    n_futures: int = 2000,
    workers: int | None = None,
) -> dict[str, dict[int, dict]]:
    """{cohort id: {h: {"n", "expected", "i80", "i95"}}} for the company and each organization."""
    _, state = oracle.true_state(profile, origin)
    futures = oracle.run_futures(state, n_futures=n_futures, workers=workers)
    exclude = metric_def.endswith("@2")
    counts = oracle.counts(state, futures, exclude_fixed_term=exclude)
    out: dict[str, dict[int, dict]] = {}
    for co in state.cohorts:
        n = sum(1 for i in co.members if not (exclude and state.fixed_term[i]))
        out[co.id] = {}
        for h, draws in counts[co.id]["voluntary"].items():
            out[co.id][h] = {
                "n": n,
                "expected": float(draws.mean()),
                "i80": list(oracle.interval(draws, 0.80)),
                "i95": list(oracle.interval(draws, 0.95)),
            }
    return out


__all__ = ["forecasts"]
