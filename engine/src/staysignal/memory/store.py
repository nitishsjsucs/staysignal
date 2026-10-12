"""The engine's memory: seeding for the demo state, the read views the Worker uses (files, a file, the commit log,
search), and the fixture export that lets the fixtures mode (CI, e2e, the fixtures deployment) answer the same reads
without git. Commit IDs are shown as their first 16 hex characters: they are SHAs of the memory repository, never of
this code repository, and no committed file holds a full git SHA (ADR 0017)."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from pathlib import Path

import yaml

from staysignal.memory.coarsen import coarsen
from staysignal.memory.notes import parse
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
    "SEED",
    "SEEDED_AT",
    "export_fixture",
    "file",
    "files",
    "log",
    "prepare",
    "search_json",
]
