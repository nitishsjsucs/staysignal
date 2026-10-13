"""The phase-2 checks built in M5 (F04, R02, R04) at their edges: the late share, the missing-arrivals rule, and the
30-day reassignment grace. Stand-in records carry only the fields the rules read."""

from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace as NS

from staysignal.quality.run_checks import active_checks, manager_references, termination_reporting

V = datetime(2026, 9, 1, 6, tzinfo=UTC)


def term(eff: date, lag_days: int) -> NS:
    rec = datetime(eff.year, eff.month, eff.day, 6, tzinfo=UTC) + timedelta(days=lag_days)
    return NS(record_type="termination", effective_date=eff, recorded_at=rec, manager=None)


def spells_of(records: list[NS]) -> dict:
    return {f"E{i:06d}": [NS(records=(r,), start=date(2020, 1, 1), end=None)] for i, r in enumerate(records)}


def test_the_built_phase2_checks_run():
    assert {"F04", "R02", "R04"} <= {c["id"] for c in active_checks()}


def test_f04_fails_when_more_than_half_of_recent_arrivals_are_late():
    recent = [term(date(2026, 6, 20), 60), term(date(2026, 6, 25), 60), term(date(2026, 8, 20), 2)]
    failing, _ = termination_reporting(spells_of(recent), V)
    assert failing == 2


def test_f04_passes_at_half_late_and_with_one_late_arrival():
    half = [term(date(2026, 6, 20), 60), term(date(2026, 8, 20), 2)]
    assert termination_reporting(spells_of(half), V)[0] == 0
    assert termination_reporting(spells_of([term(date(2026, 6, 20), 60)]), V)[0] == 0


def test_f04_fails_when_nothing_arrived_after_a_year_of_monthly_terminations():
    year = [term(date(2025, 6, 10) + timedelta(days=28 * k), 2) for k in range(12)]
    assert termination_reporting(spells_of(year), V)[0] == 1
    assert termination_reporting(spells_of(year[:11]), V)[0] == 0  # under one a month: a quiet quarter is plausible


def test_manager_references_grace_and_unknown():
    def rec(eff: date, manager: str) -> NS:
        return NS(record_type="promotion", effective_date=eff, manager=manager)

    left = date(2026, 3, 1)
    spells = {
        "M1": [NS(records=(), start=date(2020, 1, 1), end=left)],
        "E1": [
            NS(
                records=(
                    rec(left + timedelta(days=29), "M1"),  # within the grace
                    rec(left + timedelta(days=30), "M1"),  # stale
                    rec(date(2019, 12, 31), "M1"),  # before the manager started
                    rec(date(2026, 4, 1), "E999999"),  # nobody
                ),
                start=date(2019, 1, 1),
                end=None,
            )
        ],
    }
    assert manager_references(spells) == (2, 1)
