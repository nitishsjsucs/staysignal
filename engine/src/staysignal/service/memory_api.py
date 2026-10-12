"""Memory reads for the Worker (SPEC 14.10): the files, one file, the commit log and search, over the engine's git
memory repository (`var/memory`). Read-only here; only the agent principal writes memory, through the engine's own
routines. Snippets are untrusted data for any model that reads them."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException, Query

from staysignal.memory import store
from staysignal.memory.repo import MemoryRepo, MemoryRepoError


def register(app: FastAPI, memory_dir: Path) -> None:
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


__all__ = ["register"]
