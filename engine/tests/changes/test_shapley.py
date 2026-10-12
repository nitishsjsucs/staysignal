"""C16: the Shapley decomposition is exact, symmetric, gives a dummy factor zero and equals brute force."""

import itertools

import pytest

from staysignal.changes.shapley import shapley, shapley_by_orderings

F = ("calendar", "composition", "input_data", "model", "definition")


def game(s: frozenset[str]) -> float:
    w = {"calendar": -2.0, "composition": 0.7, "input_data": -0.4, "model": 0.3, "definition": 0.0}
    v = sum(w[f] for f in s)
    if {"calendar", "composition"} <= s:
        v += 0.5  # interaction
    return v


def test_efficiency_and_brute_force():
    phi = shapley(F, game)
    assert sum(phi.values()) == pytest.approx(game(frozenset(F)) - game(frozenset()), abs=1e-9)
    brute = shapley_by_orderings(F, game)
    for f in F:
        assert phi[f] == pytest.approx(brute[f], abs=1e-12)


def test_symmetry_and_dummy():
    phi = shapley(F, game)
    assert phi["definition"] == pytest.approx(0.0, abs=1e-12)
    assert phi["calendar"] - (-2.0) == pytest.approx(
        phi["composition"] - 0.7, abs=1e-12
    )  # the interaction splits evenly


def test_subset_count():
    calls = []

    def v(s):
        calls.append(s)
        return float(len(s))

    shapley(F, v)
    assert len(set(calls)) == 32
    assert len(list(itertools.permutations(F))) == 120
