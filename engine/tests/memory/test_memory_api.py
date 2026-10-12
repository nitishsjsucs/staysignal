"""The engine serves the memory to the Worker read-only, and the committed fixture equals a fresh export of the demo
memory, so the fixtures mode answers the same reads (its TypeScript search is checked against the parity results)."""

import json
import re

from fastapi.testclient import TestClient

from staysignal.memory import store
from staysignal.runner.jobs import EngineState
from staysignal.service.app import create_app


def client(tmp_path) -> TestClient:
    store.prepare(tmp_path / "memory")
    st = EngineState(None, tmp_path / "w.duckdb", tmp_path, tmp_path, tmp_path, tmp_path / "pub", tmp_path / "work")  # type: ignore[arg-type]
    return TestClient(create_app(st))


def test_memory_reads(tmp_path):
    c = client(tmp_path)
    files = c.get("/memory/files").json()["files"]
    assert {f["path"] for f in files} >= {"decisions/DEC-2026-09-20-01.md", "timeline/monthly/2026-07.md"}
    one = c.get("/memory/file", params={"path": "decisions/DEC-2026-09-20-01.md"}).json()
    assert one["meta"]["id"] == "DEC-2026-09-20-01" and one["bullets"][0]["date"] == "2026-09-20"
    assert c.get("/memory/file", params={"path": "../../etc/passwd.md"}).status_code == 404
    commits = c.get("/memory/log").json()["commits"]
    assert [x["message"] for x in commits] == ["memory: coarsen the timeline as of 2026-10-05", "memory: seed"]
    hits = c.get("/memory/search", params={"q": "what did we decide about fixed-term employees"}).json()["hits"]
    assert hits[0]["path"] == "decisions/DEC-2026-09-20-01.md"
    # commit IDs are shortened: no full git SHA leaves the engine
    assert all(re.fullmatch(r"[0-9a-f]{16}", h["commit"]) for h in hits)


def test_the_committed_fixture_is_a_fresh_export(tmp_path):
    committed = json.loads(store.FIXTURE.read_text())
    fresh = store.export_fixture(tmp_path / "memory.json")
    assert committed == json.loads(json.dumps(fresh))
    assert not re.search(r"\b[0-9a-f]{40}\b", store.FIXTURE.read_text())
