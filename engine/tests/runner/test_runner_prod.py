"""runner:prod (SPEC 23.2 step 12): the runner against the production Worker authenticates with the Access service
token's headers, refuses a non-https or local URL and missing credentials, and polls at the Worker's pace (no 2 s
cap) so idle polling stays at one request every 30 s on the Free plan. A mock Worker; no network."""

import json
import threading
from pathlib import Path

import httpx

import staysignal.runner.loop as loop
from staysignal.cli import prod_runner_config, read_env_file

from .test_service_and_loop import state

ENV = {"SS_RUNNER_CLIENT_ID": "abc123.access", "SS_RUNNER_CLIENT_SECRET": "s3cret"}


def test_the_config_needs_an_https_worker_and_the_service_token():
    cfg, problems = prod_runner_config(ENV, "https://staysignal.example.workers.dev/")
    assert problems == [] and cfg["base"] == "https://staysignal.example.workers.dev"
    assert cfg["headers"] == {"CF-Access-Client-Id": "abc123.access", "CF-Access-Client-Secret": "s3cret"}
    for bad in ("http://staysignal.example.workers.dev", "https://localhost:8795", "https://127.0.0.1", ""):
        assert any("https" in p for p in prod_runner_config(ENV, bad)[1])
    assert any("SS_RUNNER_CLIENT_ID" in p for p in prod_runner_config({}, "https://x.example.dev")[1])


def test_the_secrets_file_is_read_without_quotes_or_comments(tmp_path: Path):
    f = tmp_path / "staysignal.env"
    f.write_text("# operator secrets\nSS_RUNNER_CLIENT_ID='abc123.access'\n\nSS_RUNNER_CLIENT_SECRET=\"s3cret\"\n")
    assert read_env_file(f) == ENV
    assert read_env_file(tmp_path / "missing.env") == {}


def test_requests_carry_the_access_headers_not_a_bearer_token(tmp_path):
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.headers))
        return httpx.Response(200, json={"job": None, "next_poll_ms": 30_000})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    headers = loop.access_headers("abc123.access", "s3cret")
    assert loop.run_one(state(tmp_path), client, "https://w", headers, "engine-runner-prod", print) == 30_000
    assert seen[0]["cf-access-client-id"] == "abc123.access" and "authorization" not in seen[0]


def test_production_polling_honours_the_workers_next_poll(tmp_path, monkeypatch):
    waits: list[float] = []
    stop = threading.Event()

    class Stop(threading.Event):
        def wait(self, timeout=None):  # record the wait instead of sleeping, stop after two polls
            waits.append(timeout)
            if len(waits) == 2:
                stop.set()
            return False

        def is_set(self):
            return stop.is_set()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"job": None, "next_poll_ms": 30_000})

    real = httpx.Client
    monkeypatch.setattr(loop.httpx, "Client", lambda: real(transport=httpx.MockTransport(handler)))
    loop.run_forever(state(tmp_path), "https://w", {"CF-Access-Client-Id": "x"}, Stop(), log=print, max_wait_ms=None)
    assert waits == [30.0, 30.0]
    waits.clear()
    stop.clear()
    loop.run_forever(state(tmp_path), "http://w", "tok", Stop(), log=print)  # local: capped at 2 s
    assert waits == [2.0, 2.0]


def test_the_secret_never_reaches_the_log(tmp_path, monkeypatch):
    logs: list[str] = []
    monkeypatch.setattr(loop, "execute", lambda st, kind, params: {"ok": 1})

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/lease"):
            return httpx.Response(200, json={"job": {"job_key": "k" * 64, "kind": "run_checks", "params": {}}})
        return httpx.Response(200, json={"ok": True})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    loop.run_one(state(tmp_path), client, "https://w", loop.access_headers("id", "s3cret"), "o", logs.append)
    assert logs and not any("s3cret" in x for x in logs)
    assert json.dumps(logs)  # plain strings
