"""`staysignal demo build`: the canonical demo state and the committed API and job fixtures (SPEC 22.4, 14.7).

1. Load the landed canonical extracts (the September 2026 payroll stays held back) and the committed models.
2. Score the published runs R-2026-09-01#1 and R-2026-10-01#1; export forecasts, profiles and runs.json.
3. Quarterly pseudo-real-time backtests (history.json) and the trust summary.
4. The five-factor change decomposition between the two published runs.
5. Phase-1 check results for the last 30 days (quality.json) and the declared lineage (lineage.json).
6. The demo routine's engine jobs, keyed exactly as the Worker enqueues them: ingest of the held payroll, checks under
   payroll@1 (C01 to C03 fail, C04 warns), the held candidate R-2026-10-01#2, the probe and ranking, the deterministic
   mapping proposal, the repaired R-2026-10-01#3 under payroll@2, its checks, the change summary and the replay.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from staysignal.canonical import canonical_json
from staysignal.clock import parse_ts
from staysignal.evaluate.backtest import add_published, quarterly_backtests, trust_summary
from staysignal.features.reference import MAPPINGS, Vintage, features_at
from staysignal.fixtures.export_api import export_run, slug, write_json
from staysignal.forecast.decompose import RunSpec, decompose
from staysignal.forecast.profiles import profiles
from staysignal.forecast.replay import replay
from staysignal.forecast.run import RunInputs, make_run, population
from staysignal.ingest.landing import load_world_sources
from staysignal.lineage.graph import declared
from staysignal.model import artifact as artifact_io
from staysignal.model.train import train
from staysignal.quality.mapping_proposal import load_mapping, propose
from staysignal.quality.probes import rca_probe
from staysignal.quality.run_checks import registry, run_checks, summarize
from staysignal.runner.jobs import change_summary

START = date(2023, 4, 1)
MODELS = {
    "m2026.08": (date(2026, 9, 1), datetime(2026, 9, 1, 6, tzinfo=UTC)),
    "m2026.09": (date(2026, 10, 1), datetime(2026, 10, 1, 6, tzinfo=UTC)),
}
P = RunSpec(
    "R-2026-09-01#1",
    date(2026, 9, 1),
    datetime(2026, 9, 1, 6, tzinfo=UTC),
    "m2026.08",
    "voluntary_departures@1",
    "payroll@1",
)
Q = RunSpec(
    "R-2026-10-01#1",
    date(2026, 10, 1),
    datetime(2026, 10, 1, 6, tzinfo=UTC),
    "m2026.09",
    "voluntary_departures@2",
    "payroll@1",
)
CANDIDATE_VINTAGE = datetime(2026, 10, 5, 14, 5, tzinfo=UTC)
ARRIVED_AT = "2026-10-05T14:00:00Z"
PROPOSAL_ID = "MAP-2026-10-05-01"


def log(msg: str) -> None:
    print(f"[demo build] {msg}", flush=True)


def job_key(kind: str, params: dict) -> str:
    return hashlib.sha256(canonical_json({"kind": kind, "params": params}).encode("ascii")).hexdigest()


def ensure_models(src, models_dir: Path, retrain: bool) -> dict[str, artifact_io.Model]:
    out = {}
    for version, (T, vintage) in MODELS.items():
        path = models_dir / version / "model.json"
        if retrain or not path.exists():
            t0 = time.perf_counter()
            art = train(src, START, T, vintage, version)
            artifact_io.write(art, models_dir)
            log(f"trained {version} in {time.perf_counter() - t0:.1f} s ({art['fit']['rows']} rows)")
        out[version] = artifact_io.load(path)
    return out


def table(run: dict) -> dict[str, dict]:
    return {r["cohort_id"]: r for r in run["cohorts"]}


def score_spec(src, spec: RunSpec, models, prev_rows=None) -> dict:
    return make_run(
        src,
        RunInputs(spec.run_id, spec.cutoff, spec.vintage, models[spec.model], spec.metric_def, spec.mapping),
        prev_rows,
    )


def build(
    world_dir: Path,
    models_dir: Path,
    out_dir: Path,
    retrain: bool = False,
    jobs_dir: Path | None = None,
    cache_dir: Path | None = None,
) -> dict:
    jobs_dir = jobs_dir or out_dir.parent / "jobs"
    cache_dir = cache_dir or Path("var") / "cache"
    world_sha = json.loads((world_dir / "manifest.json").read_text())["world_sha256"]
    src = load_world_sources(world_dir)
    models = ensure_models(src, models_dir, retrain)

    # Published runs
    t0 = time.perf_counter()
    run_p = score_spec(src, P, models)
    prev_rows = population(src, P.cutoff, P.vintage, P.metric_def, P.mapping)
    run_q = score_spec(src, Q, models, prev_rows)
    briefs = [export_run(out_dir, run_p, "superseded", 1), export_run(out_dir, run_q, "published", 1)]
    write_json(out_dir / "runs.json", {"label": "synthetic", "published": Q.run_id, "runs": briefs})
    for spec in (P, Q):
        vin = Vintage(src, spec.vintage)
        rows = features_at(vin, spec.cutoff, MAPPINGS[spec.mapping], spec.metric_def)
        write_json(
            out_dir / "profiles" / f"{slug(spec.run_id)}.json",
            profiles(vin, rows, spec.cutoff, spec.vintage, spec.run_id),
            compact=True,
        )
    log(f"published runs, profiles: {time.perf_counter() - t0:.1f} s")

    # Change decomposition between the published runs
    t0 = time.perf_counter()
    ch = decompose(src, P, Q, models, table(run_q), table(run_p))
    exact = {e["cohort_id"]: e.pop("_exact") for e in ch["entries"]}
    assert ch["max_endpoint_error"] < 1e-6, (
        f"decomposition endpoints differ from the runs by {ch['max_endpoint_error']}"
    )
    assert all(abs(x["delta"] - x["phi_sum"]) < 1e-9 for x in exact.values())
    write_json(out_dir / "changes" / f"{slug(P.run_id)}__{slug(Q.run_id)}.json", ch, compact=True)
    log(
        f"change decomposition: {len(ch['entries'])} entries, endpoint error {ch['max_endpoint_error']:.2e}, {time.perf_counter() - t0:.1f} s"
    )

    # Backtests and trust summary
    t0 = time.perf_counter()
    history = quarterly_backtests(src, START, cache_dir, world_sha, log=log)
    add_published(history, [run_p, run_q])
    history["trust"] = trust_summary(history)
    write_json(out_dir / "history.json", history, compact=True)
    log(f"backtests: {time.perf_counter() - t0:.1f} s")

    # Quality: phase-1 checks at 06:00Z on each of the last 30 days, and the declared lineage
    t0 = time.perf_counter()
    results = []
    for k in range(30):
        day = date(2026, 9, 6) + timedelta(days=k)
        results += run_checks(src, datetime(day.year, day.month, day.day, 6, tzinfo=UTC), "payroll@1")
    reg = [
        {
            "check_id": c["id"],
            "name": c["name"],
            "severity": c["severity"],
            "node": c["node"],
            "columns": c["columns"],
            "source": c["sources"][0],
            "phase": c["phase"],
            "category": c["category"],
        }
        for c in registry()
    ]
    write_json(out_dir / "quality.json", {"label": "synthetic", "checks": reg, "results": results}, compact=True)
    log(f"quality history: {len(results)} results, {time.perf_counter() - t0:.1f} s")

    # The demo routine's engine jobs
    t0 = time.perf_counter()
    held = load_world_sources(world_dir, include_held=True)
    jobs: dict[str, object] = {}
    held_files = sorted((world_dir / "held").glob("*.csv"))
    jobs[job_key("ingest_source", {"source": "payroll", "period": "2026-09"})] = {
        "landed": [
            {
                "file": p.name,
                "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                "rows": p.read_text().count("\n") - 1,
            }
            for p in held_files
        ],
        "vintage": ARRIVED_AT,
        "label": "synthetic",
    }
    cand_v = CANDIDATE_VINTAGE.strftime("%Y-%m-%dT%H:%M:%SZ")
    checks_v1 = summarize(run_checks(held, CANDIDATE_VINTAGE, "payroll@1"))
    jobs[job_key("run_checks", {"vintage": cand_v, "mapping": "payroll@1"})] = checks_v1
    cand = make_run(
        held,
        RunInputs("R-2026-10-01#2", Q.cutoff, CANDIDATE_VINTAGE, models["m2026.09"], Q.metric_def, "payroll@1"),
        population(src, Q.cutoff, Q.vintage, Q.metric_def, Q.mapping),
    )
    brief2 = export_run(out_dir, cand, "candidate", 2)
    jobs[
        job_key(
            "score_forecast",
            {
                "run_id": "R-2026-10-01#2",
                "cutoff": "2026-10-01",
                "vintage": cand_v,
                "model": "m2026.09",
                "metric_def": Q.metric_def,
                "mapping": "payroll@1",
            },
        )
    ] = {"run": brief2}
    failing = [r for r in checks_v1["results"] if r["status"] == "fail"]
    probe = rca_probe(held, CANDIDATE_VINTAGE, failing)
    jobs[job_key("rca_probe", {"run_id": "R-2026-10-01#2", "failing": sorted(checks_v1["failing"])})] = probe
    prop = propose(load_mapping(1), probe["probes"])
    assert prop["proposed"] == load_mapping(2), "the generated mapping must equal sources/mappings/payroll.v2.yaml"
    jobs[job_key("propose_mapping", {"source": "payroll", "active": "payroll@1", "evidence_run": "R-2026-10-01#2"})] = {
        "proposal_id": PROPOSAL_ID,
        "from": "payroll@1",
        "to": "payroll@2",
        "diff": prop["diff"],
        "evidence": prop["evidence"],
        "generated_by": "quality/mapping_proposal.py (deterministic; never an LLM)",
    }
    repaired = make_run(
        held,
        RunInputs("R-2026-10-01#3", Q.cutoff, CANDIDATE_VINTAGE, models["m2026.09"], Q.metric_def, "payroll@2"),
        population(src, Q.cutoff, Q.vintage, Q.metric_def, Q.mapping),
    )
    brief3 = export_run(out_dir, repaired, "candidate", 3)
    vin_h = Vintage(held, CANDIDATE_VINTAGE)
    rows3 = features_at(vin_h, Q.cutoff, MAPPINGS["payroll@2"], Q.metric_def)
    write_json(
        out_dir / "profiles" / f"{slug('R-2026-10-01#3')}.json",
        profiles(vin_h, rows3, Q.cutoff, CANDIDATE_VINTAGE, "R-2026-10-01#3"),
        compact=True,
    )
    jobs[
        job_key(
            "score_forecast",
            {
                "run_id": "R-2026-10-01#3",
                "cutoff": "2026-10-01",
                "vintage": cand_v,
                "model": "m2026.09",
                "metric_def": Q.metric_def,
                "mapping": "payroll@2",
            },
        )
    ] = {"run": brief3}
    jobs[job_key("run_checks", {"vintage": cand_v, "mapping": "payroll@2"})] = summarize(
        run_checks(held, CANDIDATE_VINTAGE, "payroll@2")
    )
    tq, t3 = table(run_q), table(repaired)
    jobs[job_key("what_changed", {"from_run": Q.run_id, "to_run": "R-2026-10-01#3"})] = change_summary(tq, t3)
    landed = sorted((world_dir / "sources").glob("*.csv")) + held_files
    rp = replay(brief3, landed, models_dir)
    neg = replay(brief3, landed, models_dir, force_mapping="payroll@1")
    jobs[job_key("replay", {"run_id": "R-2026-10-01#3"})] = {
        "replay_hash": rp["replay_hash"],
        "equal": rp["equal"],
        "duration_ms": rp["duration_ms"],
        "detail": {
            "warehouse": "fresh load of the content-addressed landed files",
            "files": rp["files"],
            "negative_check": {"mapping": "payroll@1", "hash_differs": neg["replay_hash"] != brief3["result_hash"]},
        },
    }
    assert rp["equal"] and neg["replay_hash"] != brief3["result_hash"]
    jobs_dir.mkdir(parents=True, exist_ok=True)
    for old in jobs_dir.glob("*.json"):
        old.unlink()
    for key, out in jobs.items():
        write_json(jobs_dir / f"{key}.json", out, compact=True)
    log(f"demo routine jobs: {len(jobs)}, replay equal {rp['equal']}, {time.perf_counter() - t0:.1f} s")

    lin = declared()
    write_json(
        out_dir / "lineage.json",
        {
            "label": "synthetic",
            "nodes": lin["nodes"],
            "edges": [{"from": e["from"], "to": e["to"], "columns": e.get("columns", [])} for e in lin["edges"]],
            "failing": {c["check_id"]: {"path": probe["path"], "ranking": probe["ranking"]} for c in failing},
        },
    )
    return {"runs": briefs, "jobs": len(jobs)}


__all__ = ["build", "job_key", "parse_ts"]
