"""Timeline coarsening (SPEC 14.10, the `memory_digest` routine; deterministic, no LLM): daily files older than 7
days merge into their ISO-week file, and weekly files older than 5 weeks merge into the month files of their bullets'
dates, in one commit. Bullets keep their original dates, so nothing is lost (StaySignal's own design, inspired by a
public write-up of an assistant's git-tracked memory)."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta

from staysignal.memory.notes import Note, merge_bullets, parse, render
from staysignal.memory.repo import MemoryRepo

DAILY_DAYS = 7
WEEKLY_WEEKS = 5


def week_id(d: date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def week_end(wid: str) -> date:
    y, w = wid.split("-W")
    return date.fromisocalendar(int(y), int(w), 7)


def _load(repo: MemoryRepo, rel: str, kind: str, ident: str) -> Note:
    if (repo.path / rel).exists():
        return parse(repo.read(rel))
    return Note({"id": f"TL-{ident}", "type": kind, "aliases": [], "links": []}, f"Timeline {ident}", [])


def coarsen(repo: MemoryRepo, today: date, when: datetime) -> str | None:
    files = repo.files()
    writes: dict[str, Note] = {}
    removes: list[str] = []
    # daily -> weekly
    daily = [f for f in files if f.startswith("timeline/daily/")]
    for rel in daily:
        day = date.fromisoformat(rel.rsplit("/", 1)[1][:-3])
        if day >= today - timedelta(days=DAILY_DAYS):
            continue
        wid = week_id(day)
        target = f"timeline/weekly/{wid}.md"
        note = writes.get(target) or _load(repo, target, "timeline_weekly", wid)
        note.bullets = merge_bullets(note.bullets, parse(repo.read(rel)).bullets)
        writes[target] = note
        removes.append(rel)
    # weekly -> monthly (by each bullet's own month)
    weekly = sorted({f for f in files if f.startswith("timeline/weekly/")} | {t for t in writes if "weekly" in t})
    for rel in weekly:
        wid = rel.rsplit("/", 1)[1][:-3]
        if week_end(wid) >= today - timedelta(weeks=WEEKLY_WEEKS):
            continue
        source = writes.pop(rel, None) or parse(repo.read(rel))
        by_month: dict[str, list] = defaultdict(list)
        for b in source.bullets:
            by_month[b[0].strftime("%Y-%m")].append(b)
        for month, bullets in sorted(by_month.items()):
            target = f"timeline/monthly/{month}.md"
            note = writes.get(target) or _load(repo, target, "timeline_monthly", month)
            note.bullets = merge_bullets(note.bullets, bullets)
            writes[target] = note
        if (repo.path / rel).exists():
            removes.append(rel)
    if not writes and not removes:
        return None
    return repo.write(
        {rel: render(n) for rel, n in sorted(writes.items())},
        f"memory: coarsen the timeline as of {today.isoformat()}",
        when,
        remove=sorted(set(removes)),
    )


__all__ = ["DAILY_DAYS", "WEEKLY_WEEKS", "coarsen", "week_end", "week_id"]
