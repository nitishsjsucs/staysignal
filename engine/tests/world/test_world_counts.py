"""C2: structural counts of the canonical world are exact (SPEC 6.2)."""

import csv
from collections import Counter

from tests.conftest import manifest


def rows(path, name):
    with (path / name).open() as f:
        return list(csv.DictReader(f))


def test_baseline_structure(canonical):
    hris = rows(canonical, "sources/hris_records.csv")
    base = [r for r in hris if r["record_type"] == "migration_baseline"]
    assert len(base) == 1820
    assert Counter(r["employment_type"] for r in base) == {"regular": 1730, "fixed_term": 90}
    assert Counter(r["location_code"] for r in base) == {"RAL": 990, "PIT": 280, "VAN": 330, "MAN": 220}
    teams = [r for r in rows(canonical, "sources/org_teams.csv") if r["valid_from"] == "2023-04-01"]
    assert len(teams) == 110
    assert len({r["group_id"] for r in teams}) == 24
    assert len({r["org_id"] for r in teams}) == 9
    sizes = Counter(r["team_id"] for r in base)
    assert min(sizes.values()) >= 6 and max(sizes.values()) <= 28
    assert any(v < 10 for v in sizes.values()), "teams under 10 exist so suppression is exercised"
    by_org = Counter()
    org_of = {r["team_id"]: r["org_name"] for r in teams}
    for r in base:
        by_org[org_of[r["team_id"]]] += 1
    assert by_org == {
        "Engineering": 590,
        "Product & Design": 135,
        "Sales": 390,
        "Customer Success & Support": 285,
        "Marketing": 105,
        "Finance": 90,
        "People": 70,
        "Legal": 40,
        "IT & Operations": 115,
    }
    assert len({r["job_code"].rsplit("-", 1)[0] for r in hris}) == 17


def test_event_schedules(canonical):
    m = manifest(canonical)["realized"]
    assert m["hires"] == 1344 and m["new_hires"] == 1296 and m["rehires"] == 48
    assert m["requisitions"] == {"cancelled": 46, "filled": 1344, "open": 34}
    assert m["offers"] == {"accepted": 1344, "declined": 170}
    assert sum(m["reorganizations"].values()) == 9
    assert m["reorganizations"] == {"merge": 3, "split": 2, "move": 3, "restructure": 1}
    assert len(m["cycle_promotion_rates"]) == 7
    assert m["payroll_files"] == 126
    assert m["engineering_fixed_term_at_end"] >= 15


def test_hires_are_exactly_32_a_month(canonical):
    m = manifest(canonical)["realized"]
    assert m["hires_by_month_min_max"] == [32, 32]
    hris = rows(canonical, "sources/hris_records.csv")
    starts = {r["employee_number"] for r in hris if r["record_type"] == "hire"}
    assert len(starts) <= 1296
