"""The agent's memory writes (SPEC 14.10): a routine adds a timeline bullet or an investigation or decision note,
committed as the agent at the synthetic time; only the runner token may write, and a note naming a person is refused."""

from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from staysignal.memory import store
from staysignal.memory.notes import parse
from staysignal.runner.jobs import EngineState
from staysignal.service.app import create_app

AT = datetime(2026, 10, 12, 6, 30, tzinfo=UTC)


def test_investigation_note_gets_an_id_and_a_timeline_pointer(repo):
    out = store.write_note(
        repo,
        {
            "kind": "investigation",
            "title": "Run held by check S03",
            "bullets": ["Check S03 failed on the HRIS extract; the run was held (synthetic)."],
        },
        AT,
    )
    assert out["id"] == "INV-2026-10-12-01"
    assert out["files"] == ["investigations/INV-2026-10-12-01.md", "timeline/daily/2026-10-12.md"]
    note = parse(repo.read("investigations/INV-2026-10-12-01.md"))
    assert note.meta["type"] == "investigation" and "timeline/daily/2026-10-12" in note.meta["links"]
    assert note.bullets == [(AT.date(), "Check S03 failed on the HRIS extract; the run was held (synthetic).")]
    daily = parse(repo.read("timeline/daily/2026-10-12.md"))
    assert daily.bullets == [(AT.date(), "INV-2026-10-12-01: Run held by check S03")]
    commit = repo.log(1)[0]
    assert commit.message == "memory: investigation INV-2026-10-12-01" and commit.date.startswith("2026-10-12T06:30:00")
    # the next one on the same day takes the next number
    again = store.write_note(repo, {"kind": "investigation", "title": "Second look", "bullets": ["Another note."]}, AT)
    assert again["id"] == "INV-2026-10-12-02"


def test_decision_notes_keep_aliases_for_search(repo):
    out = store.write_note(
        repo,
        {
            "kind": "decision",
            "title": "Payroll mapping payroll@2 activated",
            "bullets": ["A Data engineer approved mapping proposal MAP-0001 (action 9)."],
            "aliases": ["mapping", "approval"],
        },
        AT,
    )
    assert out["id"] == "DEC-2026-10-12-01"
    note = parse(repo.read("decisions/DEC-2026-10-12-01.md"))
    assert note.meta["aliases"] == ["approval", "mapping"]
    assert (
        store.search_json(repo, "what did we decide about the payroll mapping")[0]["path"]
        == "decisions/DEC-2026-10-12-01.md"
    )


def test_appending_to_a_note_merges_bullets_and_is_idempotent(repo):
    first = store.write_note(repo, {"kind": "timeline", "bullets": ["Run published for 2026-10 (synthetic)."]}, AT)
    assert first["id"] is None and first["commit"]
    same = store.write_note(repo, {"kind": "timeline", "bullets": ["Run published for 2026-10 (synthetic)."]}, AT)
    assert same["commit"] is None  # nothing changed, no empty commit
    store.write_note(repo, {"kind": "timeline", "bullets": ["Replay matched the stored hash."]}, AT)
    store.write_note(repo, {"kind": "timeline", "bullets": ["A later bullet."]}, AT)
    # same-day bullets stay in the order they were written, not sorted by text
    assert [t for _, t in parse(repo.read("timeline/daily/2026-10-12.md")).bullets] == [
        "Run published for 2026-10 (synthetic).",
        "Replay matched the stored hash.",
        "A later bullet.",
    ]


@pytest.mark.parametrize(
    "note",
    [
        {"kind": "timeline", "bullets": ["E104233 resigned last week."]},
        {"kind": "timeline", "bullets": ["Ask someone@gmail.com for the extract."]},
        {"kind": "decision", "id": "DEC-2026-10-12-01", "title": "x", "bullets": []},
        {"kind": "decision", "id": "INV-2026-10-12-01", "title": "x", "bullets": ["y"]},
        {"kind": "secret", "bullets": ["y"]},
        {"kind": "timeline", "bullets": ["x" * 401]},
        {"kind": "decision", "title": "x", "bullets": ["y"], "aliases": ["E104233"]},
        {"kind": "decision", "title": "x", "bullets": ["y"], "links": ["../../etc/passwd"]},
    ],
)
def test_bad_notes_are_refused(repo, note):
    with pytest.raises(store.NoteRejected):
        store.write_note(repo, note, AT)


def test_only_the_runner_token_writes(tmp_path):
    store.prepare(tmp_path / "memory")
    st = EngineState(None, tmp_path / "w.duckdb", tmp_path, tmp_path, tmp_path, tmp_path / "pub", tmp_path / "work")  # type: ignore[arg-type]
    c = TestClient(create_app(st, writer_token="t0ken"))
    body = {"kind": "timeline", "at": "2026-10-12T06:30:00Z", "bullets": ["Run published (synthetic)."]}
    assert c.post("/memory/note", json=body).status_code == 401
    assert c.post("/memory/note", json=body, headers={"Authorization": "Bearer nope"}).status_code == 401
    ok = c.post("/memory/note", json=body, headers={"Authorization": "Bearer t0ken"})
    assert ok.status_code == 200 and ok.json()["files"] == ["timeline/daily/2026-10-12.md"]
    assert c.get("/memory/log").json()["commits"][0]["message"] == "memory: timeline 2026-10-12"
    bad = c.post("/memory/note", json={**body, "bullets": ["E104233 left."]}, headers={"Authorization": "Bearer t0ken"})
    assert bad.status_code == 400
    assert (
        c.post("/memory/note", json={**body, "at": "soon"}, headers={"Authorization": "Bearer t0ken"}).status_code
        == 400
    )
    # without a writer token the engine never accepts writes
    ro = TestClient(create_app(st))
    assert ro.post("/memory/note", json=body, headers={"Authorization": "Bearer None"}).status_code == 401
