"""C58: the adverse-impact screen on labeled toy tables: selection rates, impact ratios against the highest-rate
group, the four-fifths flag, Fisher's exact test against an independent hypergeometric computation, and the
small-sample rules."""

from math import comb

import pytest

from staysignal.audit.adverse_impact import GroupCount, adverse_impact


def fisher_two_sided(a: int, b: int, c: int, d: int) -> float:
    """Independent check: the sum of hypergeometric probabilities no larger than the observed table's."""
    r1, c1, n = a + b, a + c, a + b + c + d

    def p(x: int) -> float:
        return comb(c1, x) * comb(n - c1, r1 - x) / comb(n, r1)

    observed = p(a)
    lo, hi = max(0, r1 - (n - c1)), min(r1, c1)
    return min(1.0, sum(p(x) for x in range(lo, hi + 1) if p(x) <= observed * (1 + 1e-7)))


def by_group(rows):
    return {r["group"]: r for r in rows}


def test_ratios_and_the_four_fifths_flag():
    rows = by_group(
        adverse_impact([GroupCount("A", 50, 100, 100), GroupCount("B", 30, 100, 100), GroupCount("C", 45, 100, 100)])
    )
    assert rows["A"]["rate"] == 0.5 and rows["A"]["ratio"] == 1.0 and not rows["A"]["four_fifths_flag"]
    assert rows["B"]["ratio"] == pytest.approx(0.6) and rows["B"]["four_fifths_flag"]
    assert rows["C"]["ratio"] == pytest.approx(0.9) and not rows["C"]["four_fifths_flag"]


def test_fisher_exact_matches_the_hypergeometric_sum():
    rows = by_group(adverse_impact([GroupCount("A", 8, 10, 10), GroupCount("B", 1, 6, 10)]))
    # A against everyone else: [[8, 2], [1, 5]]
    assert rows["A"]["fisher_p"] == pytest.approx(fisher_two_sided(8, 2, 1, 5), rel=1e-9)
    assert rows["B"]["fisher_p"] == pytest.approx(fisher_two_sided(1, 5, 8, 2), rel=1e-9)
    assert rows["A"]["fisher_p"] < 0.05


def test_small_groups_are_not_screened_and_few_selections_are_flagged_unstable():
    rows = by_group(
        adverse_impact([GroupCount("big", 40, 200, 200), GroupCount("tiny", 1, 9, 9), GroupCount("few", 3, 150, 150)])
    )
    assert rows["tiny"]["too_small"] and rows["tiny"]["ratio"] is None and rows["tiny"]["fisher_p"] is None
    assert "too small to screen" in rows["tiny"]["warnings"][0]
    assert not rows["few"]["too_small"] and "unstable" in rows["few"]["warnings"][0]
    # the highest rate is taken over screenable groups only
    assert rows["big"]["ratio"] == 1.0


def test_people_not_units_decide_the_too_small_rule():
    rows = by_group(adverse_impact([GroupCount("a", 5, 120, 8), GroupCount("b", 9, 120, 40)]))
    assert rows["a"]["too_small"] and not rows["b"]["too_small"]
