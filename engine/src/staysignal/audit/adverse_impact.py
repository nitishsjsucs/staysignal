"""The adverse-impact screen (SPEC 17.7, C58): selection rates by group, each group's impact ratio against the group
with the highest rate, the four-fifths rule of thumb of the Uniform Guidelines (29 CFR 1607.4(D)) and Fisher's exact
test of each group against everyone else, with explicit small-sample warnings.

Both screens are unreliable on small samples, and the Guidelines treat the four-fifths rule as a rule of thumb, not a
finding: a flag is a reason to look, never a conclusion. A group with fewer than 10 people is reported as too small
to screen and gets no ratio or test.
"""

from __future__ import annotations

from dataclasses import dataclass

from scipy.stats import fisher_exact

MIN_GROUP = 10
FOUR_FIFTHS = 0.8
FEW_SELECTED = 5


@dataclass(frozen=True)
class GroupCount:
    group: str
    selected: int  # selection units (for example person-review opportunities that received attention)
    n: int  # selection units in the group
    people: int  # distinct people behind the units (the too-small rule counts people)


def adverse_impact(rows: list[GroupCount], min_group: int = MIN_GROUP) -> list[dict]:
    screenable = [r for r in rows if r.people >= min_group and r.n > 0]
    rates = {r.group: r.selected / r.n for r in screenable}
    best = max(rates.values(), default=0.0)
    total_sel = sum(r.selected for r in rows)
    total_n = sum(r.n for r in rows)
    out = []
    for r in rows:
        too_small = r.people < min_group or r.n == 0
        row: dict = {
            "group": r.group,
            "selected": r.selected,
            "n": r.n,
            "people": r.people,
            "too_small": too_small,
            "rate": None,
            "ratio": None,
            "four_fifths_flag": False,
            "fisher_p": None,
            "warnings": [],
        }
        if too_small:
            row["warnings"].append("fewer than 10 people: too small to screen")
            out.append(row)
            continue
        rate = r.selected / r.n
        ratio = rate / best if best > 0 else None
        rest_sel, rest_n = total_sel - r.selected, total_n - r.n
        if rest_n > 0:
            _, p = fisher_exact(
                [[r.selected, r.n - r.selected], [rest_sel, rest_n - rest_sel]], alternative="two-sided"
            )
            row["fisher_p"] = float(p)
        row.update(rate=rate, ratio=ratio, four_fifths_flag=ratio is not None and ratio < FOUR_FIFTHS)
        if r.selected < FEW_SELECTED:
            row["warnings"].append("fewer than 5 selected: the ratio is unstable")
        out.append(row)
    return out


__all__ = ["FOUR_FIFTHS", "MIN_GROUP", "GroupCount", "adverse_impact"]
