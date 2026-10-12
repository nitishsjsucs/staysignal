"""Exact Shapley values over factors from the values of every subset (SPEC 12; Shorrocks 2013).

phi_i = sum over subsets S not containing i of |S|! (n - |S| - 1)! / n! * (v(S + i) - v(S)). With 5 factors this uses
the 32 subset values and equals the average over the 120 orderings; the values sum exactly to v(all) - v(none).
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Callable, Sequence


def shapley(factors: Sequence[str], value: Callable[[frozenset[str]], float]) -> dict[str, float]:
    n = len(factors)
    cache: dict[frozenset[str], float] = {}

    def v(s: frozenset[str]) -> float:
        if s not in cache:
            cache[s] = value(s)
        return cache[s]

    phi: dict[str, float] = {}
    for f in factors:
        others = [x for x in factors if x != f]
        total = 0.0
        for k in range(n):
            w = math.factorial(k) * math.factorial(n - k - 1) / math.factorial(n)
            for combo in itertools.combinations(others, k):
                s = frozenset(combo)
                total += w * (v(s | {f}) - v(s))
        phi[f] = total
    return phi


def shapley_by_orderings(factors: Sequence[str], value: Callable[[frozenset[str]], float]) -> dict[str, float]:
    """Brute force over all orderings (for tests)."""
    phi = dict.fromkeys(factors, 0.0)
    perms = list(itertools.permutations(factors))
    for order in perms:
        s: frozenset[str] = frozenset()
        for f in order:
            phi[f] += value(s | {f}) - value(s)
            s = s | {f}
    return {f: x / len(perms) for f, x in phi.items()}
