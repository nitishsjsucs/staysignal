"""The forward-simulation oracle (SPEC 6.6) on the small profile: reproducible, fresh per future, and anchored on the
true state at the cutoff."""

from datetime import date

import numpy as np

from staysignal.clock import add_months
from staysignal.world import oracle
from staysignal.world.simulate import simulate
from staysignal.world.spec import SMALL

CUTOFF = add_months(SMALL.start, 9)


def active_at(world, c: date) -> set[str]:
    out = set()
    for p in world.people.values():
        for start, end, _, _ in p.spells:
            if start <= c and (end is None or end > c):
                out.add(p.en)
    return out


def test_true_state_is_the_generator_state_at_the_cutoff():
    world = simulate(SMALL)
    _, state = oracle.true_state(SMALL, CUTOFF)
    assert set(state.people) == active_at(world, CUTOFF)
    assert state.cohorts[0].id == "company" and len(state.cohorts[0].members) == len(state.people)
    assert sum(len(c.members) for c in state.cohorts[1:]) == len(state.people)


def test_futures_are_reproducible_and_differ_from_each_other():
    _, state = oracle.true_state(SMALL, CUTOFF)
    a = oracle.run_futures(state, n_futures=12, workers=1)
    b = oracle.run_futures(state, n_futures=12, workers=1)
    assert np.array_equal(a, b)
    company = oracle.counts(state, a)["company"]["voluntary"][6]
    assert len(set(company.tolist())) > 1
    assert ((a[:, :, 0] >= 0) & (a[:, :, 0] <= 6)).all()


def test_realized_counts_follow_the_backtest_window():
    world = simulate(SMALL)
    _, state = oracle.true_state(SMALL, CUTOFF)
    real = oracle.realized(state, world.outcomes)
    people = set(state.people)
    end = add_months(CUTOFF, 3)
    expected = sum(
        1
        for o in world.outcomes
        if o["employee_number"] in people and o["cause"] == "voluntary" and CUTOFF < o["end_date"] <= end
    )
    assert real["company"]["voluntary"][3] == expected
    assert real["company"]["voluntary"][1] <= real["company"]["voluntary"][3] <= real["company"]["voluntary"][6]


def test_interval_is_equal_tailed():
    draws = np.arange(100)
    assert oracle.interval(draws, 0.90) == (4, 94)
