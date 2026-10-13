"""Research worlds (SPEC 11): the generator's output for one seed and condition, loaded in memory, with the data
condition applied to what the HRIS recorded (never to the truth), and the clean final truth kept for the actuals.

Data conditions (research/PREREGISTRATION.md):
- late reporting: a share of termination records is recorded 30 to 75 days after the effective date;
- missing extract: every termination record recorded in one month is missing from training;
- duplicates: a share of departures is recorded twice (the duplicate counts only when the training set is not
  deduplicated, see `handling.py`).
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta

from staysignal.ingest.landing import Sources, add_text
from staysignal.prng import stream
from staysignal.research.arms import MISSING_MONTH, SMALL_MISSING_MONTH, Condition, research_profile
from staysignal.world.emit import build_files
from staysignal.world.simulate import simulate
from staysignal.world.spec import Profile

LATE_DAYS = (30, 75)


@dataclass(frozen=True)
class Spell:
    start: date
    end: date | None
    cause: str | None


@dataclass
class ResearchWorld:
    seed: int
    condition: Condition
    profile: Profile
    src: Sources
    truth: dict[str, list[Spell]]  # employee number -> the generator's true spells (clean final truth)
    duplicated: frozenset[str]  # employees whose departure is recorded twice
    missing_month: tuple[int, int] | None
    changed_records: int


def _truth(text: str) -> dict[str, list[Spell]]:
    out: dict[str, list[Spell]] = {}
    for r in csv.DictReader(io.StringIO(text, newline="")):
        end = date.fromisoformat(r["end_date"]) if r["end_date"] else None
        out.setdefault(r["employee_number"], []).append(
            Spell(date.fromisoformat(r["spell_start"]), end, r["cause"] or None)
        )
    return out


def true_voluntary_exit(truth: dict[str, list[Spell]], en: str, origin: date, end: date) -> bool:
    """Whether the person's true spell covering the origin ended voluntarily in (origin, end]."""
    for sp in truth.get(en, []):
        if sp.start <= origin and sp.end is not None and origin < sp.end <= end:
            return sp.cause == "voluntary"
    return False


def build(seed: int, cond: Condition, small: bool = False) -> ResearchWorld:
    profile = research_profile(seed, cond, small)
    world = simulate(profile)
    files, _ = build_files(world)
    src = Sources()
    for name in sorted(files):
        if name.startswith("sources/"):
            add_text(src, name.split("/", 1)[1], files[name])
    truth = _truth(files["truth/outcomes.csv"])
    terms = sorted((r for r in src.hris if r.record_type == "termination"), key=lambda r: r.record_id)
    changed = 0
    if cond.late_share > 0:
        r = stream(seed, f"research:late:{cond.late_share}")
        chosen = {t.record_id for t in r.sample(terms, round(cond.late_share * len(terms)))}
        lo, hi = LATE_DAYS
        late: dict[str, datetime] = {}
        for t in terms:
            if t.record_id in chosen:
                d = t.effective_date + timedelta(days=lo + r.below(hi - lo + 1))
                late[t.record_id] = max(t.recorded_at, datetime(d.year, d.month, d.day, 6, tzinfo=UTC))
        src.hris = [replace(x, recorded_at=late[x.record_id]) if x.record_id in late else x for x in src.hris]
        changed = len(late)
    month = (SMALL_MISSING_MONTH if small else MISSING_MONTH) if cond.missing_extract else None
    if month is not None:
        keep = [
            x
            for x in src.hris
            if not (x.record_type == "termination" and (x.recorded_at.year, x.recorded_at.month) == month)
        ]
        changed = len(src.hris) - len(keep)
        src.hris = keep
    duplicated: frozenset[str] = frozenset()
    if cond.duplicate_share > 0:
        r = stream(seed, f"research:duplicates:{cond.duplicate_share}")
        duplicated = frozenset(t.employee_number for t in r.sample(terms, round(cond.duplicate_share * len(terms))))
        changed = len(duplicated)
    return ResearchWorld(seed, cond, profile, src, truth, duplicated, month, changed)


__all__ = ["ResearchWorld", "Spell", "build", "true_voluntary_exit"]
