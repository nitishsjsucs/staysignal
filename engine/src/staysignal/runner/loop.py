"""The runner's pull loop (ADR 0002): lease a job from the Worker, execute it on the engine, heartbeat while it runs,
and complete it with the result. The Worker never calls the engine; the engine only calls the Worker's internal
runner endpoints with the runner token. Results are JSON under the Worker's 256 KiB limit."""

from __future__ import annotations

import contextlib
import json
import threading
import time
from collections.abc import Callable

import httpx

from staysignal.runner.jobs import EngineState, execute

MAX_RESULT = 256 * 1024


def _post(client: httpx.Client, base: str, path: str, token: str, body: dict) -> httpx.Response:
    return client.post(f"{base}{path}", json=body, headers={"Authorization": f"Bearer {token}"}, timeout=30)


def run_one(
    st: EngineState, client: httpx.Client, base: str, token: str, owner: str, log: Callable[[str], None]
) -> int:
    """Leases and completes at most one job; returns the suggested wait before the next poll in milliseconds."""
    lease = _post(client, base, "/internal/runner/lease", token, {"owner": owner}).json()
    job = lease.get("job")
    if not job:
        return int(lease.get("next_poll_ms", 1000))
    key = job["job_key"]
    done = threading.Event()

    def beat() -> None:
        while not done.wait(30):
            with contextlib.suppress(httpx.HTTPError):
                _post(client, base, "/internal/runner/heartbeat", token, {"job_key": key, "owner": owner})

    hb = threading.Thread(target=beat, daemon=True)
    hb.start()
    t0 = time.perf_counter()
    try:
        result, ok = execute(st, job["kind"], job["params"]), True
    except Exception as e:  # the failure is reported to the Worker, which records it on the routine
        result, ok = {"error": f"{type(e).__name__}: {e}"}, False
    finally:
        done.set()
    body = json.dumps({"job_key": key, "result": result, "ok": ok}, default=str)
    if len(body) > MAX_RESULT:
        body = json.dumps({"job_key": key, "result": {"error": "result over 256 KiB"}, "ok": False})
    client.post(
        f"{base}/internal/runner/complete",
        content=body,
        headers={"Authorization": f"Bearer {token}", "content-type": "application/json"},
        timeout=30,
    )
    log(f"[runner] {job['kind']} {key[:12]} {'completed' if ok else 'failed'} in {time.perf_counter() - t0:.1f} s")
    return 0


def run_forever(
    st: EngineState, base: str, token: str, stop: threading.Event, owner: str = "engine-runner", log=print
) -> None:
    with httpx.Client() as client:
        while not stop.is_set():
            try:
                wait = run_one(st, client, base, token, owner, log)
            except httpx.HTTPError:
                wait = 1000  # the Worker is not up yet, or restarting
            if wait:
                stop.wait(min(wait, 2000) / 1000)


__all__ = ["run_forever", "run_one"]
