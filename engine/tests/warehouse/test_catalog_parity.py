"""C47 (catalog parity, SPEC 7.3): every compiled DuckDB catalog entry, executed by the warehouse shim on the canonical
warehouse, equals an independent Python computation of the same flows from the reference Vintage; the published flows
balance; the shim runs only guarded entries with validated parameters and answers "busy" during a build."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from staysignal.features.reference import Vintage
from staysignal.ingest.landing import load_world_sources
from staysignal.lineage.capture import BUILD_LOCK
from staysignal.semantic import parity
from staysignal.service import warehouse_shim as shim

pytestmark = pytest.mark.dbt

PARAM_SETS = [
    {"start_month": "2023-04", "end_month": "2026-09"},
    {"start_month": "2025-10", "end_month": "2026-09", "organizations": ["Engineering", "Sales"]},
    {
        "start_month": "2024-03",
        "end_month": "2024-11",
        "groups": ["Platform Engineering", "Data", "Enterprise Sales"],
        "scope": ["Engineering", "Product & Design"],
    },
]


@pytest.fixture(scope="module")
def reference(canonical):
    vin = Vintage(load_world_sources(canonical), datetime(2026, 10, 1, 6, tzinfo=UTC))
    # the first month with assignments: the migration baseline is effective 2023-04-01, so nobody is placed before it
    return parity.reference_flows(vin, date(2023, 5, 1), date(2026, 9, 1))


def _month(s: str) -> date:
    return date(int(s[:4]), int(s[5:7]), 1)


@pytest.mark.parametrize("key", sorted(shim.entries()))
def test_catalog_entry_matches_the_reference(built, reference, key):
    con = built[0]
    entry = shim.entries()[key]
    for body in PARAM_SETS:
        res = shim.run_entry(con, key, shim.bind(body))
        got = parity.actual(entry, res.columns, [tuple(r) for r in res.rows])
        want = parity.expected(
            reference,
            entry["level"],
            entry["grain"],
            _month(body["start_month"]),
            _month(body["end_month"]),
            body.get("organizations"),
            body.get("groups"),
            body.get("scope"),
        )
        assert want, f"{key}: the reference is empty for {body}"
        assert parity.compare(entry, got, want) == []


def test_published_flows_balance_and_cover_every_month(built):
    con = built[0]
    unbalanced = con.execute(
        """select count(*) from published.rpt_flows_monthly
        where next_headcount <> headcount + hires + transfers_in + restructured_in - transfers_out - restructured_out
            - voluntary_departures - involuntary_departures - retirements"""
    ).fetchone()[0]
    months = con.execute("select count(distinct month_start) from published.rpt_flows_monthly").fetchone()[0]
    small = con.execute(
        "select count(*) from published.rpt_flows_monthly where headcount between 1 and 9 or next_headcount between 1 and 9"
    ).fetchone()[0]
    moves = con.execute(
        "select sum(transfers_in) - sum(transfers_out), sum(restructured_in) - sum(restructured_out) "
        "from published.rpt_flows_monthly"
    ).fetchone()
    assert unbalanced == 0
    assert months == 41  # 2023-05 to 2026-09
    assert small == 0
    assert tuple(moves) == (0, 0)  # every move out of one group is a move into another


def test_the_guard_admits_catalog_sql_and_nothing_that_writes():
    for entry in shim.entries().values():
        shim.assert_read_only(entry["sql"])
    for bad in (
        "delete from published.rpt_flows_monthly",
        "select 1; drop table x",
        "copy published.rpt_flows_monthly to 'x.csv'",
        "select * from read_csv('/etc/passwd')",
        "create table t as select 1",
    ):
        with pytest.raises(shim.ReadOnlyViolation):
            shim.assert_read_only(bad)


def test_parameters_are_validated():
    ok = shim.bind({"start_month": "2025-10", "end_month": "2026-09", "organizations": ["Engineering"]})
    assert ok["f_organization"] == ["Engineering"] and ok["f_group_name"] == ["__all__"]
    for bad in (
        {"start_month": "2025-13", "end_month": "2026-09"},
        {"start_month": "2026-09", "end_month": "2025-10"},
        {"start_month": "2025-10", "end_month": "2026-09", "organizations": []},
        {"start_month": "2025-10", "end_month": "2026-09", "organizations": ["__all__"]},
        {"start_month": "2025-10", "end_month": "2026-09", "sql": "select 1"},
    ):
        with pytest.raises(shim.BadParams):
            shim.bind(bad)


def test_the_shim_is_busy_while_a_build_holds_the_lock(built):
    key = sorted(shim.entries())[0]
    with BUILD_LOCK, pytest.raises(shim.WarehouseBusy):
        shim.run_entry(built[0], key, shim.bind(PARAM_SETS[0]))
