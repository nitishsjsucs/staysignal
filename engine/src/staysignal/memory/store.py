"""The engine's memory: seeding for the demo state, the read views the Worker uses (files, a file, the commit log,
search), and the fixture export that lets the fixtures mode (CI, e2e, the fixtures deployment) answer the same reads
without git. Commit IDs are shown as their first 16 hex characters: they are SHAs of the memory repository, never of
this code repository, and no committed file holds a full git SHA (ADR 0017)."""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

import yaml

from staysignal.memory.coarsen import coarsen
from staysignal.memory.notes import Note, parse, render
from staysignal.memory.repo import MemoryRepo
from staysignal.memory.search import search
from staysignal.paths import REPO_ROOT

SEED = REPO_ROOT / "engine" / "tests" / "fixtures" / "memory_seed"
SEEDED_AT = datetime(2026, 10, 1, 7, 0, tzinfo=UTC)
DIGEST_DAY = date(2026, 10, 5)  # the demo day; the memory_digest routine runs at 07:00 UTC
DIGEST_AT = datetime(2026, 10, 5, 7, 0, tzinfo=UTC)
FIXTURE = REPO_ROOT / "test" / "fixtures" / "api" / "memory.json"
PARITY_QUERIES = [
    "What did we decide last time about fixed-term employees?",
    "Do we use performance ratings?",
    "why are team level values hidden from partners",
    "duplicate HRIS records",
    "What happened with the audit batch in September?",
    "Platform Engineering promotion windows",
    "hiring coverage",
    "zebra quantum",
]


def short(sha: str) -> str:
    return sha[:16]


def prepare(path: Path) -> MemoryRepo:
    """The demo's memory: the seed committed on 2026-10-01, then the demo day's digest (coarsening)."""
    repo = MemoryRepo(path)
    repo.init(SEED, SEEDED_AT)
    coarsen(repo, DIGEST_DAY, DIGEST_AT)
    return repo


def files(repo: MemoryRepo) -> list[dict]:
    out = []
    for rel in repo.files():
        if not rel.endswith(".md"):
            continue
        note = parse(repo.read(rel))
        sha, when = repo.last_commit(rel)
        out.append(
            {
                "path": rel,
                "id": note.meta.get("id"),
                "type": note.meta.get("type"),
                "title": note.title,
                "bullets": len(note.bullets),
                "commit": short(sha),
                "date": when,
            }
        )
    return out


def file(repo: MemoryRepo, rel: str) -> dict:
    note = parse(repo.read(rel))
    sha, when = repo.last_commit(rel)
    return {
        "path": rel,
        "meta": note.meta,
        "title": note.title,
        "bullets": [{"date": d.isoformat(), "text": t} for d, t in note.bullets],
        "commit": short(sha),
        "date": when,
    }


def log(repo: MemoryRepo, limit: int = 50) -> list[dict]:
    return [{"commit": short(c.sha), "date": c.date, "message": c.message, "files": c.files} for c in repo.log(limit)]


def search_json(repo: MemoryRepo, query: str) -> list[dict]:
    return [
        {
            "path": h.path,
            "line": h.line,
            "snippet": h.snippet,
            "hits": h.hits,
            "commit": short(h.commit),
            "date": h.date,
        }
        for h in search(repo, query)
    ]


PERSON = re.compile(r"\bE\d{6}\b|\b(?:wk|er|an|sr)_[a-z2-7]{20,}\b|@(?!larkspur\.example)[a-z0-9.-]+\.[a-z]{2,}", re.I)
LINK = re.compile(r"^[a-z0-9][a-z0-9/_.-]{0,120}$")
NOTE_ID = re.compile(r"^(INV|DEC)-\d{4}-\d{2}-\d{2}-\d{2}$")
MAX_BULLET = 400


class NoteRejected(ValueError):
    pass


def _check_text(text: str) -> str:
    text = " ".join(text.split())
    if not text or len(text) > MAX_BULLET:
        raise NoteRejected("a bullet must hold 1 to 400 characters")
    if PERSON.search(text):
        raise NoteRejected("a memory note never names a person (cohort-level content only)")
    return text


def _append(old: list[tuple[date, str]], new: list[tuple[date, str]]) -> list[tuple[date, str]]:
    """Adds bullets not already present; a stable sort by date keeps same-day bullets in the order they were written
    (an investigation reads in the order things happened). A repeated write changes nothing."""
    out = list(old)
    seen = set(old)
    for b in new:
        if b not in seen:
            seen.add(b)
            out.append(b)
    return sorted(out, key=lambda b: b[0])


def _next_id(repo: MemoryRepo, prefix: str, day: date) -> str:
    folder = {"INV": "investigations", "DEC": "decisions"}[prefix]
    taken = {f.rsplit("/", 1)[1][:-3] for f in repo.files() if f.startswith(f"{folder}/")}
    n = 1
    while f"{prefix}-{day.isoformat()}-{n:02d}" in taken:
        n += 1
    return f"{prefix}-{day.isoformat()}-{n:02d}"


def write_note(repo: MemoryRepo, note: dict, when: datetime) -> dict:
    """The agent's memory write (SPEC 14.10): a timeline bullet, or an investigation or decision note with a timeline
    bullet pointing at it, committed as the agent at `when` (the synthetic clock). Cohort-level text only; a note that
    names a person is refused. Returns the note ID, the files and the commit (None when nothing changed)."""
    kind = note.get("kind")
    if kind not in ("timeline", "investigation", "decision"):
        raise NoteRejected("kind must be timeline, investigation or decision")
    bullets_in = note.get("bullets") or []
    if not isinstance(bullets_in, list) or not 1 <= len(bullets_in) <= 12:
        raise NoteRejected("a note has 1 to 12 bullets")
    day = when.astimezone(UTC).date()
    bullets = [(day, _check_text(str(b))) for b in bullets_in]
    files: dict[str, str] = {}
    daily_rel = f"timeline/daily/{day.isoformat()}.md"
    daily = (
        parse(repo.read(daily_rel))
        if (repo.path / daily_rel).exists()
        else Note(
            {"id": f"TL-{day.isoformat()}", "type": "timeline_daily", "aliases": [], "links": []},
            f"Timeline {day.isoformat()}",
            [],
        )
    )
    note_id = None
    if kind == "timeline":
        daily.bullets = _append(daily.bullets, bullets)
    else:
        prefix = "INV" if kind == "investigation" else "DEC"
        note_id = str(note.get("id") or _next_id(repo, prefix, day))
        if not NOTE_ID.match(note_id) or not note_id.startswith(prefix):
            raise NoteRejected(f"not a {kind} ID: {note_id}")
        title = _check_text(str(note.get("title") or note_id))
        folder = "investigations" if kind == "investigation" else "decisions"
        rel = f"{folder}/{note_id}.md"
        existing = parse(repo.read(rel)) if (repo.path / rel).exists() else None
        given = [str(x) for x in (note.get("links") or [])]
        if len(given) > 8 or any(not LINK.match(x) or ".." in x for x in given):
            raise NoteRejected("links are at most 8 memory paths")
        aliases = [_check_text(str(x)) for x in (note.get("aliases") or [])]
        if len(aliases) > 8 or any(len(x) > 40 for x in aliases):
            raise NoteRejected("aliases are at most 8 short phrases")
        before = existing.meta if existing else {}
        meta = {
            "id": note_id,
            "type": kind,
            "aliases": sorted(set(aliases) | set(before.get("aliases") or [])),
            "links": sorted(set(given) | set(before.get("links") or []) | {f"timeline/daily/{day.isoformat()}"}),
        }
        body = Note(meta, title, _append(existing.bullets if existing else [], bullets))
        files[rel] = render(body)
        daily.bullets = _append(daily.bullets, [(day, f"{note_id}: {title}")])
    files[daily_rel] = render(daily)
    commit = repo.write(files, f"memory: {kind} {note_id or day.isoformat()}", when)
    return {"id": note_id, "files": sorted(files), "commit": short(commit) if commit else None}


def export_fixture(out: Path = FIXTURE) -> dict:
    """The demo memory as a fixture: every file's text and last commit, the alias table, the log, and the Python
    search results for the parity queries (the fixtures client's TypeScript search must return the same)."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        repo = prepare(Path(tmp) / "memory")
        texts = {}
        for rel in repo.files():
            sha, when = repo.last_commit(rel)
            texts[rel] = {"text": repo.read(rel), "commit": short(sha), "date": when}
        doc = {
            "label": "synthetic",
            "note": "The demo memory (seed plus the 2026-10-05 digest) exported for the fixtures mode.",
            "aliases": yaml.safe_load(repo.read("index/aliases.yml")) or {},
            "files": texts,
            "index": files(repo),
            "log": log(repo),
            "parity": [{"query": q, "hits": search_json(repo, q)} for q in PARITY_QUERIES],
        }
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return doc


__all__ = [
    "DIGEST_AT",
    "DIGEST_DAY",
    "FIXTURE",
    "NoteRejected",
    "SEED",
    "SEEDED_AT",
    "export_fixture",
    "file",
    "files",
    "log",
    "prepare",
    "search_json",
    "write_note",
]
