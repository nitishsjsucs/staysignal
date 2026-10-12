"""The SQL bitemporal layer agrees with the pure-Python reference (features/reference.py Vintage): spells, departures
and the population with its organization at cutoffs, on the canonical world at the 2026-10-01 vintage."""

from collections import Counter
from datetime import date

import pytest

from staysignal.clock import parse_ts
from staysignal.features.reference import Vintage
from staysignal.ingest.landing import load_world_sources
from staysignal.privacy.pseudo import engine_pseudonymizer

from .conftest import VINTAGE

pytestmark = pytest.mark.dbt


@pytest.fixture(scope="module")
def reference(canonical):
    return Vintage(load_world_sources(canonical), parse_ts(VINTAGE))


@pytest.fixture(scope="module")
def keys():
    p = engine_pseudonymizer()
    cache: dict[str, str] = {}

    def er(en: str) -> str:
        if en not in cache:
            cache[en] = p.pseudonym("employee_ref", en)
        return cache[en]

    return er


def test_spells_and_departures_match(built, reference, keys):
    con = built[0]
    sql = Counter(
        (r[0], r[1], r[2], r[3])
        for r in con.execute(
            "SELECT employee_key, start_date, end_date, cause FROM staging.int_hris__spells"
        ).fetchall()
    )
    ref = Counter((keys(en), sp.start, sp.end, sp.cause) for en, spells in reference.spells.items() for sp in spells)
    assert sql == ref


@pytest.mark.parametrize("cutoff", [date(2024, 1, 1), date(2025, 7, 1), date(2026, 9, 1)])
def test_population_and_organization_at_cutoffs_match(built, reference, keys, cutoff):
    con = built[0]
    rows = con.execute(
        "SELECT employee_key, team_id, org_name, employment_type FROM restricted.fct_employee_month WHERE month_start = ?",
        [cutoff],
    ).fetchall()
    sql = {r[0]: (r[1], r[2], r[3]) for r in rows}
    ref = {}
    for en, a in reference.assignments_at(cutoff).items():
        ref[keys(en)] = (a.team_id, reference.team_info(a.team_id, cutoff)[1], a.employment_type)
    assert sql == ref
