"""Markdown note helpers for the memory (SPEC 14.10): front matter (`id`, `type`, `aliases`, `links`) and dated
bullets (`- YYYY-MM-DD: text`). Bullets keep their own dates through every coarsening, which makes it lossless."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

import yaml

BULLET = re.compile(r"^- (\d{4}-\d{2}-\d{2}): (.+)$")


@dataclass
class Note:
    meta: dict = field(default_factory=dict)
    title: str = ""
    bullets: list[tuple[date, str]] = field(default_factory=list)


def parse(text: str) -> Note:
    meta: dict = {}
    body = text
    if text.startswith("---\n"):
        end = text.index("\n---\n", 4)
        meta = yaml.safe_load(text[4:end]) or {}
        body = text[end + 5 :]
    title = ""
    bullets = []
    for line in body.splitlines():
        if line.startswith("# ") and not title:
            title = line[2:].strip()
        m = BULLET.match(line.strip())
        if m:
            bullets.append((date.fromisoformat(m.group(1)), m.group(2).strip()))
    return Note(meta, title, bullets)


def render(note: Note) -> str:
    meta = yaml.safe_dump(note.meta, sort_keys=True, default_flow_style=None, allow_unicode=True).strip()
    lines = ["---", meta, "---", f"# {note.title}", ""]
    lines += [f"- {d.isoformat()}: {t}" for d, t in note.bullets]
    return "\n".join(lines) + "\n"


def merge_bullets(*groups: list[tuple[date, str]]) -> list[tuple[date, str]]:
    """Union of bullets in date order, exact duplicates once (a coarsening never loses or reorders a fact)."""
    seen: set[tuple[date, str]] = set()
    out = []
    for b in sorted((b for g in groups for b in g), key=lambda x: (x[0], x[1])):
        if b not in seen:
            seen.add(b)
            out.append(b)
    return out


__all__ = ["BULLET", "Note", "merge_bullets", "parse", "render"]
