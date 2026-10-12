"""Catalog parity (SPEC 7.3): an independent Python computation of the workforce flows from the pure-Python reference
(`features/reference.py` Vintage: spells, assignments and the organization tree as known at a vintage), and a
comparison with what a compiled catalog entry returns on the warehouse. Pattern from PeopleLens
`src/peoplelens/catalog/parity.py` (MIT): the warehouse path (dbt models, MetricFlow SQL) and this path share no code.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime

from staysignal.clock import add_months
from staysignal.features.reference import Vintage
from staysignal.semantic import params as P

FLOWS = P.BUNDLES["workforce_flows"]


@dataclass
class Cell:
    month: date
    organization: str
    group_name: str
    values: dict[str, int] = field(default_factory=lambda: dict.fromkeys(FLOWS, 0))
    next_headcount: int = 0


def _placement(vin: Vintage, d: date) -> dict[tuple[str, date], tuple[str, str, str, object]]:
    """{(employee, spell start): (team, group, organization, spell)} for everyone employed at the start of day d."""
    out = {}
    for en in vin.spells:
        sp = vin.spell_at(en, d)
        if sp is None:
            continue
        a = vin.assignment(sp, d)
        if a is None:
            continue
        group, org = vin.team_info(a.team_id, d)
        out[(en, sp.start)] = (a.team_id, group, org, sp)
    return out


def reference_flows(vin: Vintage, first: date, last: date) -> dict[tuple[date, str], Cell]:
    """Flows per (month start, group) for months first..last (each month's next month must be observable)."""
    cells: dict[tuple[date, str], Cell] = {}

    def cell(m: date, org: str, group: str) -> Cell:
        if (m, group) not in cells:
            cells[(m, group)] = Cell(m, org, group)
        return cells[(m, group)]

    m = first
    now = _placement(vin, m)
    while m <= last:
        nxt_m = add_months(m, 1)
        nxt = _placement(vin, nxt_m)
        for key, (team, group, org, sp) in now.items():
            c = cell(m, org, group)
            c.values["headcount"] += 1
            if sp.end is not None and sp.end <= nxt_m:
                c.values[
                    {
                        "voluntary": "voluntary_departures",
                        "involuntary": "involuntary_departures",
                        "retirement": "retirements",
                    }[sp.cause]
                ] += 1
            elif key in nxt and nxt[key][1] != group:
                c.values["transfers_out" if nxt[key][0] != team else "restructured_out"] += 1
        for key, (team, group, org, _sp) in nxt.items():
            c = cell(m, org, group)
            c.next_headcount += 1
            if key not in now:
                c.values["hires"] += 1
            elif now[key][1] != group:
                c.values["transfers_in" if now[key][0] != team else "restructured_in"] += 1
        now = nxt
        m = nxt_m
    return cells


def expected(
    cells: dict[tuple[date, str], Cell],
    level: str,
    grain: str,
    start: date,
    end: date,
    organizations: list[str] | None = None,
    groups: list[str] | None = None,
    scope: list[str] | None = None,
) -> dict[tuple, dict[str, int]]:
    """What a catalog entry should return: flows summed over the window, headcount at the first month of the window
    among the rows that pass the filters (MetricFlow's non-additive `window_choice: min`, no window groupings)."""
    rows = [
        c
        for c in cells.values()
        if start <= c.month <= end
        and (not organizations or c.organization in organizations)
        and (not groups or c.group_name in groups)
        and (not scope or c.organization in scope)
    ]
    out: dict[tuple, dict[str, int]] = defaultdict(lambda: dict.fromkeys(FLOWS, 0))
    first = min((c.month for c in rows), default=None)
    for c in rows:
        dims = tuple({"organization": c.organization, "group_name": c.group_name}[d] for d in P.LEVELS[level])
        key = dims + ((c.month,) if grain == "month" else ())
        tgt = out[key]
        for name in FLOWS:
            if name == "headcount":
                if grain == "month" or c.month == first:
                    tgt[name] += c.values[name]
            else:
                tgt[name] += c.values[name]
    return dict(out)


def actual(entry: dict, columns: list[str], rows: list[tuple]) -> dict[tuple, dict[str, int]]:
    """Catalog output keyed like `expected` (dimensions in level order, then the month)."""
    dims = [entry["columns"]["dimensions"][d] for d in P.LEVELS[entry["level"]]]
    time = entry["columns"]["time"]
    idx = {c: i for i, c in enumerate(columns)}
    out = {}
    for r in rows:
        key = tuple(r[idx[d]] for d in dims)
        if time:
            t = r[idx[time]]
            if isinstance(t, str):
                t = date.fromisoformat(t[:10])
            elif isinstance(t, datetime):
                t = t.date()
            key += (t,)
        out[key] = {name: int(r[idx[name]] or 0) for name in FLOWS}
    return out


def compare(entry: dict, got: dict[tuple, dict[str, int]], want: dict[tuple, dict[str, int]]) -> list[str]:
    problems = []
    if set(got) != set(want):
        missing, extra = sorted(set(want) - set(got))[:3], sorted(set(got) - set(want))[:3]
        return [f"{entry['key']}: cell keys differ (missing {missing}, extra {extra})"]
    for key, w in want.items():
        for name, value in w.items():
            if got[key][name] != value:
                problems.append(f"{entry['key']} {key}: {name} {got[key][name]} vs reference {value}")
    return problems


__all__ = ["Cell", "actual", "compare", "expected", "reference_flows"]
