"""The memory for the Worker (SPEC 14.10): reads (the files, one file, the commit log, search) over the engine's git
memory repository (`var/memory`), and the agent's writes (`POST /memory/note`, a routine's timeline bullet or an
investigation or decision note), accepted only with the runner token, so only the Worker's agent writes. Snippets are
untrusted data for any model that reads them."""

from __future__ import annotations

import hmac
from datetime import datetime
from pathlib import Path

from fastapi import Body, FastAPI, Header, HTTPException, Query

from staysignal.memory import store
from staysignal.memory.repo import MemoryRepo, MemoryRepoError


def register(app: FastAPI, memory_dir: Path, writer_token: str | None = None) -> None:
    def repo() -> MemoryRepo:
        r = MemoryRepo(memory_dir)
        if not r.exists:
            raise HTTPException(status_code=404, detail="no memory repository; run staysignal engine prepare")
        return r

    @app.get("/memory/files")
    def files() -> dict:
        return {"label": "synthetic", "files": store.files(repo())}

    @app.get("/memory/file")
    def file(path: str = Query(min_length=4, max_length=200)) -> dict:
        r = repo()
        if path not in r.files():
            raise HTTPException(status_code=404, detail="no such memory file")
        try:
            return {"label": "synthetic", **store.file(r, path)}
        except MemoryRepoError:
            raise HTTPException(status_code=404, detail="no such memory file") from None

    @app.get("/memory/log")
    def log(limit: int = Query(default=50, ge=1, le=200)) -> dict:
        return {"label": "synthetic", "commits": store.log(repo(), limit)}

    @app.get("/memory/search")
    def search(q: str = Query(min_length=2, max_length=200)) -> dict:
        return {"label": "synthetic", "query": q, "hits": store.search_json(repo(), q)}

    @app.post("/memory/note")
    def note(body: dict = Body(...), authorization: str | None = Header(default=None)) -> dict:  # noqa: B008
        expected = f"Bearer {writer_token}" if writer_token else None
        if expected is None or not hmac.compare_digest((authorization or "").encode(), expected.encode()):
            raise HTTPException(status_code=401, detail="memory writes need the runner token")
        try:
            when = datetime.fromisoformat(str(body.get("at", "")).replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="at must be an ISO timestamp on the synthetic clock") from None
        try:
            return {"label": "synthetic", **store.write_note(repo(), body, when)}
        except store.NoteRejected as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None


__all__ = ["register"]
