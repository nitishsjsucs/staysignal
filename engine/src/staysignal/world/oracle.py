"""Forward-simulation oracle (SPEC 6.6).

From the true state of the world at cutoff `c` (true records, every latent propensity, the current team and
organization states, including the shocks of the quarter that contains `c`), the generator itself is run forward
`n_futures` times over 6 months. Each future draws fresh randomness for every stage and fresh team and organization
shocks for every later quarter; promotions, transfers, manager successions, reorganizations on their fixed dates, hires and
contagion all run as in the generator. The cohort is fixed at `c`: the people active at the cutoff, grouped by the
company and their organization at `c`. The result is the true distribution of departure counts by cause and horizon.

It knows what no model can (the latent propensity and the generator's exact form), so it is the unattainable floor for
count error and the reference for interval coverage (C5). Synthetic world only.
"""

from __future__ import annotations

import math
import pickle
from collections.abc import Iterable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import date

import numpy as np

from staysignal.clock import add_months, quarter_of
from staysignal.prng import stream
from staysignal.world.simulate import Simulator
from staysignal.world.spec import Profile

CAUSES = ("voluntary", "involuntary", "retirement")
HORIZONS = (1, 3, 6)
STREAMS = {
    "r_org": "org",
    "r_people": "people",
    "r_latent": "latent",
    "r_hazard": "hazards",
    "r_days": "days",
    "r_lags": "lags",
    "r_promo": "promotions",
    "r_transfer": "transfers",
    "r_hire": "hires",
    "r_pay": "pay",
    "r_ft": "fixed_term",
    "r_succ": "succession",
    "r_reqs": "requisitions",
}


@dataclass
class Cohort:
    """People active at the cutoff: the company, or one organization (by the person's team at the cutoff)."""

    id: str
    members: list[int]  # indexes into OracleState.people


@dataclass
class OracleState:
    cutoff: date
    seed: int
    people: list[str]  # employee numbers active at the cutoff
    cohorts: list[Cohort]
    fixed_term: list[bool]  # employment type at the cutoff (voluntary_departures@2 excludes fixed-term employees)
    blob: bytes  # the pickled simulator at the first day of the cutoff month


def true_state(profile: Profile, cutoff: date) -> tuple[Simulator, OracleState]:
    """Runs the generator up to (not including) the cutoff month and freezes its state."""
    m0 = next(m for m in range(profile.months + 1) if add_months(profile.start, m) == cutoff)
    sim = Simulator(profile)
    sim.setup()
    for _ in range(m0):
        sim.step()
    # The shocks of the quarter that contains the cutoff are part of the current state: a mid-quarter cutoff has them
    # already, and a quarter-start cutoff draws them here from the truth's own streams, so every cutoff is treated
    # alike. Later quarters get fresh shocks in each future.
    q = quarter_of(cutoff)
    sim.shock_org(q)
    for tid in sorted(t.id for t in sim.teams.values() if t.valid_to is None):
        sim.shock_team(tid, q)
    active = sorted((p for p in sim.people.values() if p.active), key=lambda p: p.num)
    people = [p.en for p in active]
    by_org: dict[str, list[int]] = {}
    for i, p in enumerate(active):
        by_org.setdefault(sim.teams[p.team].org, []).append(i)
    cohorts = [Cohort("company", list(range(len(active))))] + [
        Cohort(f"org:{org}", idx) for org, idx in sorted(by_org.items())
    ]
    # the futures need the people, teams and their histories, not the emitted records
    lean = Simulator.__new__(Simulator)
    lean.__dict__.update(sim.__dict__)
    lean.records, lean.payroll, lean.offers, lean.outcomes, lean.monthly = [], [], [], [], []
    lean.org_events = []
    lean.team_rows = []
    lean.write_payroll = False
    state = OracleState(
        cutoff=cutoff,
        seed=profile.seed,
        people=people,
        cohorts=cohorts,
        fixed_term=[p.emp_type == "fixed_term" for p in active],
        blob=pickle.dumps(lean, protocol=pickle.HIGHEST_PROTOCOL),
    )
    return sim, state


def _future(blob: bytes, people: list[str], cutoff: date, seed: int, f: int, months: int) -> np.ndarray:
    """One future: for each person active at the cutoff, the month (1 to `months`) and cause of departure, or 0."""
    sim: Simulator = pickle.loads(blob)
    salt = f":oracle:{cutoff.isoformat()}:{f}"
    for attr, name in STREAMS.items():
        setattr(sim, attr, stream(seed, f"{name}{salt}"))
    sim.shock_salt = salt
    index = {en: i for i, en in enumerate(people)}
    out = np.zeros((len(people), 2), dtype=np.int16)  # month, cause code (1 voluntary, 2 involuntary, 3 retirement)
    for k in range(months):
        for person, _end, cause, _reason in sim.step():
            i = index.get(person.en)
            if i is not None and out[i, 0] == 0:
                out[i] = (k + 1, CAUSES.index(cause) + 1)
    return out


def _chunk(args: tuple[bytes, list[str], date, int, Iterable[int], int]) -> list[np.ndarray]:
    blob, people, cutoff, seed, fs, months = args
    return [_future(blob, people, cutoff, seed, f, months) for f in fs]


def run_futures(state: OracleState, n_futures: int = 2000, months: int = 6, workers: int | None = None) -> np.ndarray:
    """All futures: an array of shape (n_futures, people, 2) with the departure month and cause code."""
    workers = workers or 1
    ids = list(range(n_futures))
    if workers <= 1:
        return np.stack(_chunk((state.blob, state.people, state.cutoff, state.seed, ids, months)))
    size = math.ceil(n_futures / (workers * 4))
    chunks = [ids[i : i + size] for i in range(0, n_futures, size)]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        parts = pool.map(_chunk, [(state.blob, state.people, state.cutoff, state.seed, c, months) for c in chunks])
        return np.stack([a for part in parts for a in part])


def counts(state: OracleState, futures: np.ndarray, exclude_fixed_term: bool = False) -> dict:
    """Departure counts per future: {cohort: {cause: {horizon: int array of length n_futures}}}."""
    month, cause = futures[:, :, 0], futures[:, :, 1]
    keep = ~np.array(state.fixed_term) if exclude_fixed_term else np.ones(len(state.people), dtype=bool)
    out: dict[str, dict[str, dict[int, np.ndarray]]] = {}
    for co in state.cohorts:
        idx = np.array([i for i in co.members if keep[i]], dtype=np.int64)
        out[co.id] = {}
        for c_i, c_name in enumerate(CAUSES, start=1):
            out[co.id][c_name] = {}
            for h in HORIZONS:
                hit = (cause[:, idx] == c_i) & (month[:, idx] >= 1) & (month[:, idx] <= h)
                out[co.id][c_name][h] = hit.sum(axis=1)
    return out


def realized(state: OracleState, outcomes: Iterable[dict], exclude_fixed_term: bool = False) -> dict:
    """The true counts for the same cohorts: departures of people active at the cutoff with end date in (c, c + h]."""
    index = {en: i for i, en in enumerate(state.people)}
    first: dict[int, tuple[date, str]] = {}
    for o in outcomes:
        i = index.get(o["employee_number"])
        end = o["end_date"]
        if i is None or end <= state.cutoff:
            continue
        if i not in first or end < first[i][0]:
            first[i] = (end, o["cause"])
    out: dict[str, dict[str, dict[int, int]]] = {}
    for co in state.cohorts:
        out[co.id] = {}
        for cause in CAUSES:
            out[co.id][cause] = {}
            for h in HORIZONS:
                end_h = add_months(state.cutoff, h)
                out[co.id][cause][h] = sum(
                    1
                    for i in co.members
                    if not (exclude_fixed_term and state.fixed_term[i])
                    and i in first
                    and first[i][1] == cause
                    and first[i][0] <= end_h
                )
    return out


def interval(draws: np.ndarray, level: float = 0.90) -> tuple[int, int]:
    """Equal-tailed interval of a count distribution (inverted empirical CDF at both tails)."""
    a = (1.0 - level) / 2.0
    s = np.sort(draws)
    lo = int(s[max(0, math.ceil(a * len(s)) - 1)])
    hi = int(s[min(len(s) - 1, math.ceil((1.0 - a) * len(s)) - 1)])
    return lo, hi


__all__ = ["CAUSES", "HORIZONS", "OracleState", "counts", "interval", "realized", "run_futures", "true_state"]
