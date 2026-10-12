"""The engine service serves the published documents by run ID, and the runner loop leases, executes and completes a
job against the Worker's internal endpoints with the runner token (a mock Worker here)."""

import json
import shutil
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

import staysignal.runner.loop as loop
from staysignal.runner.jobs import EngineState
from staysignal.service.app import create_app

API = Path(__file__).resolve().parents[3] / "test" / "fixtures" / "api"


def state(tmp_path) -> EngineState:
    pub = tmp_path / "published"
    shutil.copytree(API, pub, dirs_exist_ok=True)
    return EngineState(None, tmp_path / "w.duckdb", tmp_path, tmp_path, tmp_path, pub, tmp_path / "work")  # type: ignore[arg-type]


def test_service_serves_published_documents(tmp_path):
    client = TestClient(create_app(state(tmp_path)))
    assert client.get("/health").json()["ok"] is True
    r = client.get("/published/forecast/R-2026-10-01%231")
    assert r.status_code == 200 and r.json()["run"]["run_id"] == "R-2026-10-01#1"
    assert client.get("/published/runs").json()["published"] == "R-2026-10-01#1"
    assert client.get("/published/changes/R-2026-09-01%231/R-2026-10-01%231").status_code == 200
    assert client.get("/published/forecast/R-2099-01-01%231").status_code == 404


def test_runner_leases_executes_and_completes(tmp_path, monkeypatch):
    calls: list[tuple[str, dict, str]] = []
    jobs = [{"job_key": "k" * 64, "kind": "what_changed", "params": {"a": 1}, "attempt": 1}]

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        calls.append((request.url.path, body, request.headers.get("authorization", "")))
        if request.url.path == "/internal/runner/lease":
            job = jobs.pop() if jobs else None
            return httpx.Response(200, json={"job": job, "next_poll_ms": 500})
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(loop, "execute", lambda st, kind, params: {"kind": kind, "params": params})
    client = httpx.Client(transport=httpx.MockTransport(handler))
    logs: list[str] = []
    assert loop.run_one(state(tmp_path), client, "http://worker", "tok", "engine-runner", logs.append) == 0
    assert loop.run_one(state(tmp_path), client, "http://worker", "tok", "engine-runner", logs.append) == 500
    paths = [c[0] for c in calls]
    assert paths == ["/internal/runner/lease", "/internal/runner/complete", "/internal/runner/lease"]
    assert all(c[2] == "Bearer tok" for c in calls)
    complete = calls[1][1]
    assert complete == {"job_key": "k" * 64, "result": {"kind": "what_changed", "params": {"a": 1}}, "ok": True}
    assert "completed" in logs[0]


def test_a_failing_job_is_reported_not_raised(tmp_path, monkeypatch):
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/internal/runner/lease":
            return httpx.Response(
                200,
                json={"job": {"job_key": "x" * 64, "kind": "replay", "params": {}, "attempt": 1}, "next_poll_ms": 500},
            )
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    def boom(st, kind, params):
        raise RuntimeError("no such run")

    monkeypatch.setattr(loop, "execute", boom)
    client = httpx.Client(transport=httpx.MockTransport(handler))
    loop.run_one(state(tmp_path), client, "http://worker", "tok", "engine-runner", lambda m: None)
    assert sent[0]["ok"] is False and "no such run" in sent[0]["result"]["error"]
