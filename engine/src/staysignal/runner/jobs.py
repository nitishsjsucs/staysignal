"""Engine jobs the runner executes for the Worker (SPEC 14.7, ADR 0002): each job is computed live from the local
warehouse and the landing store, with the same inputs and outputs as the committed fixtures the fixture runner
replays (`engine/tests/runner/test_jobs_match_fixtures.py` asserts they are equal). Synthetic world only.

Kinds: ingest_source, run_checks, score_forecast, rca_probe, propose_mapping, what_changed, replay.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import duckdb

from staysignal.clock import parse_ts
from staysignal.duck import open_duckdb
from staysignal.features.reference import MAPPINGS, Vintage, features_at
from staysignal.fixtures.export_api import export_run, slug, write_json
from staysignal.forecast.profiles import profiles
from staysignal.forecast.published_tables import write_run
from staysignal.forecast.run import RunInputs, make_run, population
from staysignal.ingest import mappings
from staysignal.ingest.landing import Sources, load_landed_sources
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
from staysignal.lineage.capture import build
from staysignal.model import artifact as artifact_io
from staysignal.quality.mapping_proposal import load_mapping, propose
from staysignal.quality.probes import rca_probe
from staysignal.quality.run_checks import summarize
from staysignal.quality.warehouse_checks import phase1_results

MIGRATION = datetime(2023, 4, 1, 6, tzinfo=UTC)


def iso_z(t: datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class EngineState:
    """Everything a job may touch. One process owns the warehouse connection (ADR 0012); jobs run one at a time."""

    con: duckdb.DuckDBPyConnection
    db_path: Path
    world_dir: Path
    landing: Path
    models_dir: Path
    published_dir: Path
    work_dir: Path
    lock: threading.RLock = field(default_factory=threading.RLock)
    checks: dict[tuple[str, str], list[dict]] = field(default_factory=dict)
    runs: dict[str, dict] = field(default_factory=dict)
    lineage_events: list[dict] = field(default_factory=list)
    memory_dir: Path | None = None

    @classmethod
    def open(cls, repo: Path, var: Path) -> EngineState:
        db = var / "warehouse.duckdb"
        return cls(
            con=open_duckdb(db),
            db_path=db,
            world_dir=var / "world",
            landing=var / "landing",
            models_dir=repo / "models",
            published_dir=var / "engine" / "published",
            work_dir=var / "engine" / "work",
            memory_dir=var / "memory",
        )

    def sources(self, until: datetime | None = None) -> Sources:
        return load_landed_sources(self.con, until)

    def published_doc(self, run_id: str) -> dict:
        return json.loads((self.published_dir / "forecast" / f"{slug(run_id)}.json").read_text())

    def runs_index(self) -> dict:
        return json.loads((self.published_dir / "runs.json").read_text())


def _model(st: EngineState, version: str) -> artifact_io.Model:
    return artifact_io.load(st.models_dir / version / "model.json")


def ingest_source(st: EngineState, params: dict) -> dict:
    """Lands and loads the held-back extracts of a source and period (the simulated arrival of beat 3)."""
    source, period = params["source"], params["period"]
    paths = sorted((st.world_dir / "held").glob(f"{source}_*_{period}.csv"))
    if not paths:
        raise ValueError(f"no held extract for {source} {period}")
    out = ingest(st.con, paths, st.landing, MIGRATION)
    refresh_employee_keys(st.con)
    arrived = st.con.execute(
        "SELECT max(delivered_at) FROM raw._deliveries WHERE file_name IN (SELECT unnest(?))", [[p.name for p in paths]]
    ).fetchone()[0]
    return {
        "landed": [{"file": o["file"], "sha256": o["sha256"], "rows": o["rows"]} for o in out],
        "vintage": iso_z(arrived),
        "label": "synthetic",
    }


def checks_at(st: EngineState, vintage: str, mapping: str) -> list[dict]:
    key = (vintage, mapping)
    if key not in st.checks:
        target = st.work_dir / f"dbt-{vintage.replace(':', '')}-{mapping.replace('@', '_')}"
        res = build(st.db_path, target, {"vintage": vintage, "pay_basis_mapping": mapping})
        if not res.success:
            failed = [n for n, r in res.results_by_name().items() if r["status"] == "error"]
            raise RuntimeError(f"warehouse build failed: {failed}")
        st.lineage_events = res.events
        st.checks[key] = phase1_results(st.con, res, parse_ts(vintage))
    return st.checks[key]


def run_checks(st: EngineState, params: dict) -> dict:
    return summarize(checks_at(st, params["vintage"], params["mapping"]))


def _previous_published(st: EngineState) -> dict | None:
    """The published run a candidate is compared with (population-change counts, SPEC 17.5)."""
    idx = st.runs_index()
    return next((b for b in idx["runs"] if b["run_id"] == idx["published"]), None)


def compute_run(st: EngineState, brief_like: dict, prev: dict | None = None) -> dict:
    run_id = brief_like["run_id"]
    if run_id in st.runs:
        return st.runs[run_id]
    src = st.sources()
    prev_rows = None
    if prev is not None:
        prev_rows = population(
            src, date.fromisoformat(prev["cutoff"]), parse_ts(prev["vintage"]), prev["metric_def"], prev["mapping"]
        )
    run = make_run(
        src,
        RunInputs(
            run_id,
            date.fromisoformat(brief_like["cutoff"]),
            parse_ts(brief_like["vintage"]),
            _model(st, brief_like["model"]),
            brief_like["metric_def"],
            brief_like["mapping"],
        ),
        prev_rows,
    )
    st.runs[run_id] = run
    return run


def score_forecast(st: EngineState, params: dict) -> dict:
    """Scores a candidate run from the landed sources and exports it for the warehouse shim and published tables."""
    prev = _previous_published(st)
    run = compute_run(st, params, prev)
    version = int(params["run_id"].split("#")[1])
    brief = export_run(st.published_dir, run, "candidate", version)
    doc = st.published_doc(params["run_id"])
    write_run(st.con, doc)
    src = st.sources()
    v = parse_ts(params["vintage"])
    vin = Vintage(src, v)
    cutoff = date.fromisoformat(params["cutoff"])
    rows = features_at(vin, cutoff, MAPPINGS[params["mapping"]], params["metric_def"])
    write_json(
        st.published_dir / "profiles" / f"{slug(params['run_id'])}.json",
        profiles(vin, rows, cutoff, v, params["run_id"]),
        compact=True,
    )
    return {"run": brief}


def _probe(st: EngineState, run_id: str) -> dict:
    brief = st.published_doc(run_id)["run"]
    failing = [r for r in checks_at(st, brief["vintage"], brief["mapping"]) if r["status"] == "fail"]
    return rca_probe(st.sources(), parse_ts(brief["vintage"]), failing)


def rca_probe_job(st: EngineState, params: dict) -> dict:
    return _probe(st, params["run_id"])


def propose_mapping(st: EngineState, params: dict) -> dict:
    """The deterministic mapping proposal (SPEC 13.4): generated from evidence, never by an LLM."""
    active = int(params["active"].split("@")[1])
    probe = _probe(st, params["evidence_run"])
    prop = propose(load_mapping(active), probe["probes"])
    vintage = st.published_doc(params["evidence_run"])["run"]["vintage"]
    target = f"{params['source']}@{active + 1}"
    if prop["proposed"] != mappings.versions(params["source"]).get(active + 1):
        raise RuntimeError("the generated mapping differs from the committed next version; nothing to propose")
    return {
        "proposal_id": f"MAP-{vintage[:10]}-01",
        "from": params["active"],
        "to": target,
        "diff": prop["diff"],
        "evidence": prop["evidence"],
        "generated_by": "quality/mapping_proposal.py (deterministic; never an LLM)",
    }


def change_summary(ta: dict[str, dict], tb: dict[str, dict]) -> dict:
    """3-month expected voluntary departures of two runs for the company and each organization, rounded to 1e-6 (the
    business-result precision, SPEC 9.6) so the output is the same on every platform; the routine compares the change
    with its publication tolerance (SPEC 13.4)."""

    def r6(x: float) -> float:
        return round(float(x), 6)

    return {
        "company": {
            "from": r6(ta["company"]["horizons"]["3"]["expected"]),
            "to": r6(tb["company"]["horizons"]["3"]["expected"]),
        },
        "organizations": [
            {
                "cohort_id": cid,
                "from": r6(ta[cid]["horizons"]["3"]["expected"]),
                "to": r6(tb[cid]["horizons"]["3"]["expected"]),
            }
            for cid in sorted(ta)
            if cid.startswith("org:") and cid in tb
        ],
        "label": "synthetic",
    }


def what_changed(st: EngineState, params: dict) -> dict:
    a = compute_run(st, st.published_doc(params["from_run"])["run"])
    b = compute_run(st, st.published_doc(params["to_run"])["run"])
    return change_summary({r["cohort_id"]: r for r in a["cohorts"]}, {r["cohort_id"]: r for r in b["cohorts"]})


def _replay_hash(st: EngineState, brief: dict, mapping: str, files: list[tuple[str, str]]) -> str:
    """Rebuilds the run in a fresh DuckDB file from the content-addressed landed copies (never the live warehouse)."""
    replay_dir = st.work_dir.parent / "replay"
    replay_dir.mkdir(parents=True, exist_ok=True)
    db = replay_dir / f"{slug(brief['run_id'])}-{mapping.replace('@', '_')}.duckdb"
    for p in (db, db.with_suffix(".duckdb.wal")):
        p.unlink(missing_ok=True)
    fresh = open_duckdb(db)
    try:
        with tempfile.TemporaryDirectory(prefix="ss-replay-") as tmp:
            named = []
            for name, landed in files:
                dest = Path(tmp) / name
                shutil.copyfile(landed, dest)
                named.append(dest)
            ingest(fresh, named, Path(tmp) / "landing", MIGRATION)
            src = load_landed_sources(fresh)
        run = make_run(
            src,
            RunInputs(
                brief["run_id"],
                date.fromisoformat(brief["cutoff"]),
                parse_ts(brief["vintage"]),
                _model(st, brief["model"]),
                brief["metric_def"],
                mapping,
            ),
        )
        return run["result_hash"]
    finally:
        fresh.close()


def replay(st: EngineState, params: dict) -> dict:
    t0 = time.perf_counter()
    brief = st.published_doc(params["run_id"])["run"]
    files = st.con.execute(
        "SELECT d.file_name, l.landed_path FROM raw._deliveries AS d JOIN raw._loads AS l USING (file_sha256) "
        "WHERE d.source <> 'audit_attributes' AND d.delivered_at <= ? ORDER BY d.file_name",
        [parse_ts(brief["vintage"])],
    ).fetchall()
    h = _replay_hash(st, brief, brief["mapping"], files)
    duration = int((time.perf_counter() - t0) * 1000)
    neg = _replay_hash(st, brief, "payroll@1", files)
    return {
        "replay_hash": h,
        "equal": h == brief["result_hash"],
        "duration_ms": duration,
        "detail": {
            "warehouse": "fresh load of the content-addressed landed files",
            "files": len(files),
            "negative_check": {"mapping": "payroll@1", "hash_differs": neg != brief["result_hash"]},
        },
    }


JOBS = {
    "ingest_source": ingest_source,
    "run_checks": run_checks,
    "score_forecast": score_forecast,
    "rca_probe": rca_probe_job,
    "propose_mapping": propose_mapping,
    "what_changed": what_changed,
    "replay": replay,
}


def execute(st: EngineState, kind: str, params: dict[str, Any]) -> dict:
    fn = JOBS.get(kind)
    if fn is None:
        raise ValueError(f"unknown job kind {kind}")
    with st.lock:
        return fn(st, params)


__all__ = ["JOBS", "EngineState", "execute"]
