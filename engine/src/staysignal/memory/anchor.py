"""Daily anchors of the audit chains (SPEC 14.5): the head of each hash chain written outside the Durable Object, as
a Markdown note committed to the memory repository. A rewritten chain shows up as a mismatch with its anchor."""

from __future__ import annotations

from datetime import date, datetime

from staysignal.memory.notes import Note, render
from staysignal.memory.repo import MemoryRepo


def anchor(repo: MemoryRepo, day: date, heads: dict[str, dict], when: datetime) -> str | None:
    """`heads`: {chain name: {"seq": int, "hash": hex}} for the action log and the approval audit."""
    bullets = [(day, f"{chain} head at sequence {h['seq']}: {h['hash']}") for chain, h in sorted(heads.items())]
    note = Note(
        {"id": f"ANC-{day.isoformat()}", "type": "anchor", "aliases": [], "links": []}, f"Audit anchors {day}", bullets
    )
    return repo.write(
        {f"anchors/{day.isoformat()}.md": render(note)}, f"memory: anchor the audit chains for {day}", when
    )


__all__ = ["anchor"]
