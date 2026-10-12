"""The engine service on 127.0.0.1:8196 (SPEC 22.3): the warehouse shim the Worker reads in engine mode, plus a health
endpoint. It serves the published layer two ways: compiled semantic-catalog entries executed on the engine's DuckDB
connection (`POST /catalog/{key}`, service/warehouse_shim.py: the Worker sends an entry key and parameter values,
never SQL), and the documents the engine exports (`var/engine/published`, the same contract as the committed API
fixtures; the runner thread rewrites them as routine jobs score new runs). Only cohort-level, suppressed and rounded
values are ever served. Synthetic world only."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from staysignal.fixtures.export_api import slug
from staysignal.runner.jobs import EngineState
from staysignal.service import memory_api, warehouse_shim


def create_app(st: EngineState) -> FastAPI:
    app = FastAPI(title="StaySignal engine (synthetic)", docs_url=None, redoc_url=None, openapi_url=None)

    def doc(*parts: str) -> JSONResponse:
        path = st.published_dir.joinpath(*parts)
        if not path.is_file():
            raise HTTPException(status_code=404, detail="not found")
        return JSONResponse(json.loads(path.read_text(encoding="utf-8")))

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "label": "synthetic", "published": (st.published_dir / "runs.json").exists()}

    @app.get("/published/runs")
    def runs() -> JSONResponse:
        return doc("runs.json")

    @app.get("/published/forecast/{run_id}")
    def forecast(run_id: str) -> JSONResponse:
        return doc("forecast", f"{slug(run_id)}.json")

    @app.get("/published/profiles/{run_id}")
    def profiles(run_id: str) -> JSONResponse:
        return doc("profiles", f"{slug(run_id)}.json")

    @app.get("/published/history")
    def history() -> JSONResponse:
        return doc("history.json")

    @app.get("/published/changes/{from_run}/{to_run}")
    def changes(from_run: str, to_run: str) -> JSONResponse:
        return doc("changes", f"{slug(from_run)}__{slug(to_run)}.json")

    @app.get("/published/quality")
    def quality() -> JSONResponse:
        return doc("quality.json")

    @app.get("/published/evaluation")
    def evaluation() -> JSONResponse:
        return doc("evaluation.json")

    @app.get("/published/action-audit")
    def action_audit() -> JSONResponse:
        return doc("action-audit.json")

    @app.get("/published/lineage")
    def lineage() -> JSONResponse:
        return doc("lineage.json")

    memory_api.register(app, st.memory_dir or st.db_path.parent / "memory")

    @app.post("/catalog/{key}")
    def catalog(key: str, body: dict = Body(default_factory=dict)) -> JSONResponse:  # noqa: B008
        try:
            values = warehouse_shim.bind(body)
            res = warehouse_shim.run_entry(st.con, key, values)
        except KeyError:
            raise HTTPException(status_code=404, detail="no such catalog entry") from None
        except warehouse_shim.BadParams as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from None
        except warehouse_shim.WarehouseBusy:
            raise HTTPException(status_code=503, detail="warehouse busy") from None
        return JSONResponse(res.as_json())

    return app


__all__ = ["create_app", "Path"]
