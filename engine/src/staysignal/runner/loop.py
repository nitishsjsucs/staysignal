"""The runner's pull loop (ADR 0002): lease a job from the Worker, execute it on the engine, heartbeat while it runs,
and complete it with the result. The Worker never calls the engine; the engine only calls the Worker's internal
runner endpoints, locally with the runner token and in production with the Access service token's headers
(`runner prod`). Results are JSON under the Worker's 256 KiB limit."""

from __future__ import annotations

import contextlib
import json
import threading
import time
from collections.abc import Callable

import httpx

from staysignal.runner.jobs import EngineState, execute

MAX_RESULT = 256 * 1024


Auth = str | dict[str, str]  # the local runner token, or request headers (the production Access service token)


def headers_for(auth: Auth) -> dict[str, str]:
    return {"Authorization": f"Bearer {auth}"} if isinstance(auth, str) else dict(auth)


def access_headers(client_id: str, client_secret: str) -> dict[str, str]:
    """Cloudflare Access service-token headers; Access exchanges them for the JWT the Worker verifies."""
    return {"CF-Access-Client-Id": client_id, "CF-Access-Client-Secret": client_secret}


def _post(client: httpx.Client, base: str, path: str, token: Auth, body: dict) -> httpx.Response:
    return client.post(f"{base}{path}", json=body, headers=headers_for(token), timeout=30)


def run_one(
    st: EngineState, client: httpx.Client, base: str, token: Auth, owner: str, log: Callable[[str], None]
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
        headers={**headers_for(token), "content-type": "application/json"},
        timeout=30,
    )
    log(f"[runner] {job['kind']} {key[:12]} {'completed' if ok else 'failed'} in {time.perf_counter() - t0:.1f} s")
    return 0


def run_forever(
    st: EngineState,
    base: str,
    token: Auth,
    stop: threading.Event,
    owner: str = "engine-runner",
    log=print,
    max_wait_ms: int | None = 2000,
) -> None:
    """Polls until `stop`. Locally waits are capped at 2 s; in production (`max_wait_ms=None`) the Worker's
    `next_poll_ms` is honored in full, which keeps idle polling at one request every 30 s on the Free plan."""
    with httpx.Client() as client:
        while not stop.is_set():
            try:
                wait = run_one(st, client, base, token, owner, log)
            except httpx.HTTPError:
                wait = 1000 if max_wait_ms else 15_000  # the Worker is not up yet, or restarting
            if wait:
                stop.wait((min(wait, max_wait_ms) if max_wait_ms else wait) / 1000)


__all__ = ["Auth", "access_headers", "headers_for", "run_forever", "run_one"]
