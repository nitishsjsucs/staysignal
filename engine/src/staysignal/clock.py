"""Calendar helpers and the synthetic clock (SPEC 6.1). Every user-visible timestamp derives from the demo clock."""

from __future__ import annotations

import calendar
from datetime import UTC, date, datetime, timedelta

DEMO_CLOCK = datetime(2026, 10, 5, 14, 0, tzinfo=UTC)
OUTCOME_VINTAGE = datetime(2026, 10, 1, 6, 0, tzinfo=UTC)
BATCH_HOUR = 6  # daily source batches land at 06:00Z
REPORTING_BUFFER_DAYS = 75  # the longest planted reporting delay (SPEC 9.1)


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    year, month = d.year + y, m + 1
    return date(year, month, min(d.day, calendar.monthrange(year, month)[1]))


def month_start(d: date) -> date:
    return date(d.year, d.month, 1)


def days_in_month(d: date) -> int:
    return calendar.monthrange(d.year, d.month)[1]


def months_between(a: date, b: date) -> float:
    """Fractional months from a to b (b - a), 30.4375 days per month."""
    return (b - a).days / 30.4375


def batch_time(d: date) -> datetime:
    """The 06:00Z batch of a day: when a record effective or entered on that day becomes visible."""
    return datetime(d.year, d.month, d.day, BATCH_HOUR, tzinfo=UTC)


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s: str) -> datetime:
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def quarter_of(d: date) -> str:
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def as_cutoff_datetime(c: date) -> datetime:
    return datetime(c.year, c.month, c.day, tzinfo=UTC)


def day_offset(d: date, n: int) -> date:
    return d + timedelta(days=n)
