"""Memory search (SPEC 14.10): `git grep -n -i` over the query's terms plus alias expansion, ranked by hits and then
recency; each hit carries a snippet, the path, the SHA and date of the last commit that touched the file. This is what
answers "what did we decide last time?". Memory text is data, never instructions: callers pass snippets to a model
only inside delimited data blocks."""

from __future__ import annotations

import re
from dataclasses import dataclass

import yaml

from staysignal.memory.notes import parse
from staysignal.memory.repo import MemoryRepo

STOP = {
    "the", "and", "for", "did", "was", "were", "what", "when", "why", "how", "who", "with", "about", "last", "time",
    "our", "that", "this", "have", "has", "are", "from", "into", "decide", "decided", "decision", "any", "there",
    "use", "used", "uses", "does", "happened", "should", "would", "could", "tell", "remind", "show", "please",
}  # fmt: skip
MAX_HITS = 5


@dataclass
class Hit:
    path: str
    line: int
    snippet: str
    hits: int
    commit: str
    date: str


def terms(query: str) -> list[str]:
    words = re.findall(r"[A-Za-z0-9@#_.\-]{3,}", query.lower())
    return sorted({w.strip(".-") for w in words if w.strip(".-") not in STOP and len(w.strip(".-")) >= 3})


def expansions(repo: MemoryRepo, query: str) -> list[str]:
    """Extra terms: index/aliases.yml (phrase -> terms) and each note's front-matter aliases (phrase -> its id)."""
    q = query.lower()
    out: set[str] = set()
    if (repo.path / "index" / "aliases.yml").exists():
        table = yaml.safe_load(repo.read("index/aliases.yml")) or {}
        for phrase, extra in table.items():
            if str(phrase).lower() in q:
                out.update(str(e).lower() for e in extra)
    for rel in repo.files():
        if not rel.endswith(".md"):
            continue
        meta = parse(repo.read(rel)).meta
        for alias in meta.get("aliases") or []:
            if str(alias).lower() in q and meta.get("id"):
                out.add(str(meta["id"]).lower())
    return sorted(out)


def search(repo: MemoryRepo, query: str, limit: int = MAX_HITS) -> list[Hit]:
    ts = sorted(set(terms(query)) | set(expansions(repo, query)))
    if not ts:
        return []
    args = ["grep", "-n", "-i", "-F"]
    for t in ts:
        args += ["-e", t]
    out = repo.git(*args, check=False)
    by_file: dict[str, list[tuple[int, str]]] = {}
    for line in out.splitlines():
        path, _, rest = line.partition(":")
        num, _, text = rest.partition(":")
        if num.isdigit() and not path.startswith("index/"):  # the alias table is configuration, not memory
            by_file.setdefault(path, []).append((int(num), text))
    hits = []
    for path, lines in by_file.items():
        score = sum(sum(text.lower().count(t) for t in ts) for _, text in lines)
        # the snippet is the best-matching dated bullet, else the matching title, else (a match in the front matter
        # only) the note's title; front-matter lines count toward the score but are never shown
        body = [x for x in lines if x[1].startswith("- ")] or [x for x in lines if x[1].startswith("# ")]
        if body:
            best = max(body, key=lambda x: (sum(x[1].lower().count(t) for t in ts), -x[0]))
        else:
            best = _title_line(repo, path)
        sha, date = repo.last_commit(path)
        hits.append(Hit(path, best[0], best[1].strip(), score, sha, date))
    hits.sort(key=lambda h: (-h.hits, -_ts(h.date) if h.date else 0.0, h.path))
    return hits[:limit]


def _title_line(repo: MemoryRepo, path: str) -> tuple[int, str]:
    for i, line in enumerate(repo.read(path).splitlines(), start=1):
        if line.startswith("# "):
            return i, line
    return 1, path


def _ts(iso: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(iso).timestamp()


__all__ = ["Hit", "expansions", "search", "terms"]
