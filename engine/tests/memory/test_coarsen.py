"""C33: coarsening is lossless and deterministic. Daily files older than 7 days merge into ISO-week files, weekly
files older than 5 weeks into month files, every bullet keeps its date, and a second run changes nothing."""

from collections import Counter
from datetime import UTC, date, datetime

from staysignal.memory.coarsen import coarsen, week_id
from staysignal.memory.notes import parse

TODAY = date(2026, 10, 5)
WHEN = datetime(2026, 10, 5, 7, tzinfo=UTC)


def timeline_bullets(repo) -> Counter:
    return Counter(b for f in repo.files() if f.startswith("timeline/") for b in parse(repo.read(f)).bullets)


def test_coarsening_is_lossless_and_follows_the_tiers(repo):
    before = timeline_bullets(repo)
    assert coarsen(repo, TODAY, WHEN) is not None
    after = timeline_bullets(repo)
    assert after == before
    files = repo.files()
    dailies = [f for f in files if f.startswith("timeline/daily/")]
    assert dailies == ["timeline/daily/2026-10-01.md"]  # within 7 days of the clock
    assert "timeline/weekly/2026-W38.md" in files  # 2026-09-15 and 2026-09-20 (week 38 ends 2026-09-20)
    assert "timeline/monthly/2026-07.md" in files and "timeline/monthly/2026-08.md" in files
    for f in files:
        if f.startswith("timeline/weekly/"):
            assert all(week_id(d) == f.rsplit("/", 1)[1][:-3] for d, _ in parse(repo.read(f)).bullets)
        if f.startswith("timeline/monthly/"):
            assert all(d.strftime("%Y-%m") == f.rsplit("/", 1)[1][:-3] for d, _ in parse(repo.read(f)).bullets)


def test_coarsening_twice_changes_nothing_and_later_days_coarsen_further(repo):
    first = coarsen(repo, TODAY, WHEN)
    assert coarsen(repo, TODAY, WHEN) is None
    later = coarsen(repo, date(2026, 11, 30), datetime(2026, 11, 30, 7, tzinfo=UTC))
    assert later is not None and later != first
    files = repo.files()
    assert not any(f.startswith(("timeline/daily/", "timeline/weekly/")) for f in files)
    assert sum(len(parse(repo.read(f)).bullets) for f in files if f.startswith("timeline/")) == 7
