"""Named point-in-time feature tests (SPEC 8.4). Every test runs twice: on the pure-Python reference
(features/reference.py) and on pit.sql over a dbt build of the same micro-world, so both implementations are pinned
to the same exact values."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from staysignal.features.reference import PAYROLL_V1, PAYROLL_V2, Vintage, features_at
from tests.features.micro import build, load
from tests.features.sqlpath import sql_rows

C = date(2026, 1, 1)
V = datetime(2026, 1, 1, 6, tzinfo=UTC)
IMPL = {"name": "reference"}


@pytest.fixture(autouse=True, params=["reference", pytest.param("sql", marks=pytest.mark.dbt)])
def implementation(request):
    IMPL["name"] = request.param
    yield request.param
    IMPL["name"] = "reference"


def row(src, c=C, v=V, mapping=PAYROLL_V1, metric_def="voluntary_departures@1", clock=None):
    if IMPL["name"] == "sql":
        rows = sql_rows(src, c, v, mapping.version, metric_def, clock)
    else:
        rows = features_at(Vintage(src, v), c, mapping, metric_def, clock)
    return {r.employee_number: r for r in rows}


def hire(**kw):
    base = {"record_type": "hire", "effective_date": "2025-01-01"}
    base.update(kw)
    return base


def test_tenure_rehire_starts_new_spell():
    src = build(
        {
            "records": [
                hire(record_id="H1", effective_date="2022-01-01"),
                {
                    "record_id": "H2",
                    "record_type": "termination",
                    "effective_date": "2023-06-01",
                    "reason": "VOL_RESIGN",
                },
                {"record_id": "H3", "record_type": "rehire", "effective_date": "2025-07-01"},
            ]
        }
    )
    r = row(src)["E000001"]
    assert r.tenure_days == (C - date(2025, 7, 1)).days


def test_time_in_role_resets_on_level_or_job_change_not_on_manager_change():
    src = build(
        {
            "records": [
                hire(record_id="H1"),
                {"record_id": "H2", "record_type": "promotion", "effective_date": "2025-05-01", "level": "IC4"},
                {
                    "record_id": "H3",
                    "record_type": "manager_change",
                    "effective_date": "2025-08-01",
                    "level": "IC4",
                    "manager": "EZ",
                },
            ]
        }
    )
    r = row(src)["E000001"]
    assert r.time_in_role_days == (C - date(2025, 5, 1)).days


def test_days_since_last_promotion_uses_spell_start_when_never_promoted():
    r = row(build({"records": [hire(effective_date="2024-03-01")]}))["E000001"]
    assert r.never_promoted_in_spell and r.days_since_last_promotion == (C - date(2024, 3, 1)).days


def test_first_promotion_effective_after_cutoff_is_none_yet():
    src = build(
        {
            "records": [
                hire(record_id="H1"),
                {
                    "record_id": "H2",
                    "record_type": "promotion",
                    "effective_date": "2026-01-01",
                    "level": "IC4",
                    "recorded_at": "2025-12-20T06:00:00Z",
                },
            ]
        }
    )
    r = row(src)["E000001"]
    assert r.first_promotion_status == "none_yet" and r.level == "IC3"


def test_manager_changes_a_b_a_counts_two():
    src = load("manager_changes")
    r = row(src, c=date(2025, 10, 15), v=datetime(2025, 10, 15, 6, tzinfo=UTC))["E000001"]
    assert r.manager_changes_180d == 2


def test_manager_changes_duplicate_rows_count_once():
    recs = [
        hire(record_id="H1", manager="EA"),
        {"record_id": "H2", "record_type": "manager_change", "effective_date": "2025-09-01", "manager": "EB"},
        {
            "record_id": "H9",
            "record_type": "manager_change",
            "effective_date": "2025-09-01",
            "manager": "EB",
            "recorded_at": "2025-09-04T06:00:00Z",
        },
    ]
    assert row(build({"records": recs}))["E000001"].manager_changes_180d == 1


def test_manager_changes_reverted_correction_counts_zero():
    recs = [
        hire(record_id="H1", manager="EA"),
        {"record_id": "H2", "record_type": "manager_change", "effective_date": "2025-09-01", "manager": "EB"},
        {
            "record_id": "H3",
            "record_type": "correction",
            "corrects": "H2",
            "effective_date": "2025-09-01",
            "manager": "EA",
            "recorded_at": "2025-10-01T06:00:00Z",
        },
    ]
    assert row(build({"records": recs}))["E000001"].manager_changes_180d == 0


def test_manager_changes_correction_recorded_after_vintage_is_ignored():
    recs = [
        hire(record_id="H1", manager="EA"),
        {"record_id": "H2", "record_type": "manager_change", "effective_date": "2025-09-01", "manager": "EB"},
        {
            "record_id": "H3",
            "record_type": "correction",
            "corrects": "H2",
            "effective_date": "2025-09-01",
            "manager": "EA",
            "recorded_at": "2026-02-01T06:00:00Z",
        },
    ]
    assert row(build({"records": recs}))["E000001"].manager_changes_180d == 1


def test_manager_changes_window_is_half_open():
    lo = date(2025, 7, 5)  # C - 180 days
    recs = [
        hire(record_id="H1", manager="EA"),
        {"record_id": "H2", "record_type": "manager_change", "effective_date": lo.isoformat(), "manager": "EB"},
    ]
    assert row(build({"records": recs}))["E000001"].manager_changes_180d == 1
    recs = [
        hire(record_id="H1", manager="EA"),
        {"record_id": "H2", "record_type": "manager_change", "effective_date": "2025-07-04", "manager": "EB"},
    ]
    assert row(build({"records": recs}))["E000001"].manager_changes_180d == 0


def test_compa_ratio_uses_latest_period_before_cutoff_known_at_vintage():
    pay = [
        {"period": "2025-11", "amount": "9000.00"},
        {"period": "2025-12", "amount": "10000.00", "recorded_at": "2026-01-05T06:00:00Z"},
    ]
    r = row(build({"records": [hire()], "payroll": pay}))["E000001"]
    assert r.compa_ratio == round(9000 * 12 / 100000, 6)


def test_compa_ratio_pay_basis_mapping_monthly_and_annual():
    pay = [{"period": "2025-12", "amount": "120000.00", "basis": "ANN", "recorded_at": "2025-12-31T06:00:00Z"}]
    src = build({"records": [hire()], "payroll": pay})
    assert row(src, mapping=PAYROLL_V1)["E000001"].compa_ratio == 14.4  # payroll@1 treats ANN as monthly
    assert row(src, mapping=PAYROLL_V2)["E000001"].compa_ratio == 1.2


def test_population_excludes_hire_on_cutoff_and_departure_before_cutoff():
    recs = [
        hire(
            employee_number="E000001", record_id="H1", effective_date="2026-01-01", recorded_at="2025-12-15T06:00:00Z"
        ),
        hire(employee_number="E000002", record_id="H2"),
        {
            "employee_number": "E000002",
            "record_id": "H3",
            "record_type": "termination",
            "effective_date": "2026-01-01",
            "reason": "VOL_RESIGN",
            "recorded_at": "2025-12-31T06:00:00Z",
        },
        hire(employee_number="E000003", record_id="H4"),
    ]
    assert set(row(build({"records": recs}))) == {"E000003"}


def test_rescinded_termination_keeps_spell_open():
    recs = [
        hire(record_id="H1"),
        {"record_id": "H2", "record_type": "termination", "effective_date": "2025-10-01", "reason": "VOL_RESIGN"},
        {
            "record_id": "H3",
            "record_type": "rescission",
            "corrects": "H2",
            "effective_date": "2025-10-01",
            "recorded_at": "2025-10-10T06:00:00Z",
        },
    ]
    assert "E000001" in row(build({"records": recs}))


def test_late_termination_is_invisible_before_it_is_recorded():
    recs = [
        hire(record_id="H1"),
        {
            "record_id": "H2",
            "record_type": "termination",
            "effective_date": "2025-12-01",
            "reason": "VOL_RESIGN",
            "recorded_at": "2026-01-20T06:00:00Z",
        },
    ]
    assert "E000001" in row(build({"records": recs}))
    assert "E000001" not in row(build({"records": recs}), v=datetime(2026, 2, 1, tzinfo=UTC))


def test_prior_team_departures_excludes_self_future_and_unknown():
    recs = [
        hire(employee_number="E000001", record_id="H1", effective_date="2024-01-01"),
        {
            "employee_number": "E000001",
            "record_id": "H2",
            "record_type": "termination",
            "effective_date": "2025-08-01",
            "reason": "VOL_RESIGN",
        },
        {"employee_number": "E000001", "record_id": "H3", "record_type": "rehire", "effective_date": "2025-09-01"},
        hire(employee_number="E000002", record_id="H4", effective_date="2024-01-01"),
        {
            "employee_number": "E000002",
            "record_id": "H5",
            "record_type": "termination",
            "effective_date": "2025-10-01",
            "reason": "VOL_RESIGN",
        },
        hire(employee_number="E000003", record_id="H6", effective_date="2024-01-01"),
        {
            "employee_number": "E000003",
            "record_id": "H7",
            "record_type": "termination",
            "effective_date": "2026-01-15",
            "reason": "VOL_RESIGN",
            "recorded_at": "2025-12-20T06:00:00Z",
        },
        hire(employee_number="E000004", record_id="H8", effective_date="2024-01-01"),
        {
            "employee_number": "E000004",
            "record_id": "H9",
            "record_type": "termination",
            "effective_date": "2025-11-01",
            "reason": "VOL_RESIGN",
            "recorded_at": "2026-01-20T06:00:00Z",
        },
    ]
    r = row(build({"records": recs}))["E000001"]
    # own earlier departure excluded, E000003's is after the cutoff, E000004's is not known at the vintage
    assert r.prior_team_departures_180d == 1
    # org rate: 2 voluntary departures known in the window (including the subject's own) over 4 employed 180 days ago
    assert r.prior_team_rate == round((1 + 10 * (2 / 4)) / (4 + 10), 6)


@pytest.mark.parametrize(
    ("effective", "recorded", "exposed"),
    [
        ("2025-10-03", None, True),  # C - 90 days counts
        ("2025-10-02", None, False),  # one day earlier does not
        ("2025-12-31", None, True),
        ("2026-01-01", "2025-12-15T06:00:00Z", False),  # effective on the cutoff does not
        ("2025-11-01", "2026-01-10T06:00:00Z", False),  # recorded after the vintage is unknown
    ],
)
def test_reorg_exposure_window_boundaries(effective, recorded, exposed):
    event = {"team_id": "T001", "effective_date": effective}
    if recorded:
        event["recorded_at"] = recorded
    r = row(build({"records": [hire(effective_date="2024-01-01")], "org_events": [event]}))["E000001"]
    assert r.reorg_exposure_90d is exposed


def test_prior_team_departures_independent_of_metric_definition():
    recs = [
        hire(employee_number="E000001", record_id="H1", effective_date="2024-01-01"),
        hire(
            employee_number="E000002",
            record_id="H2",
            effective_date="2025-06-01",
            employment_type="fixed_term",
            contract_end="2026-06-01",
        ),
        hire(
            employee_number="E000003",
            record_id="H3",
            effective_date="2024-06-01",
            employment_type="fixed_term",
            contract_end="2026-06-01",
        ),
        {
            "employee_number": "E000003",
            "record_id": "H4",
            "record_type": "termination",
            "effective_date": "2025-11-01",
            "reason": "VOL_RESIGN",
            "employment_type": "fixed_term",
            "contract_end": "2026-06-01",
        },
    ]
    src = build({"records": recs})
    v1 = row(src, metric_def="voluntary_departures@1")
    v2 = row(src, metric_def="voluntary_departures@2")
    assert set(v1) == {"E000001", "E000002"} and set(v2) == {"E000001"}
    assert v1["E000001"] == v2["E000001"]
    assert v2["E000001"].prior_team_departures_180d == 1  # the fixed-term leaver still counts
