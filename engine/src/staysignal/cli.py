"""Command line entry point: `uv run --project engine staysignal ...`."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from staysignal import __version__


def cmd_world_generate(args: argparse.Namespace) -> int:
    from staysignal.world.emit import generate
    from staysignal.world.spec import PROFILES

    profile = PROFILES[args.profile]
    if args.seed is not None and args.seed != profile.seed:
        from dataclasses import replace

        profile = replace(profile, seed=args.seed)
    t0 = time.perf_counter()
    manifest = generate(profile, Path(args.out))
    dt = time.perf_counter() - t0
    print(
        json.dumps(
            {
                "profile": profile.name,
                "seed": profile.seed,
                "world_sha256": manifest["world_sha256"],
                "seconds": round(dt, 2),
                "realized": manifest["realized"],
            },
            indent=2,
        )
    )
    return 0


def cmd_world_verify(args: argparse.Namespace) -> int:
    """Compares a generated world's manifest with the committed pins (SPEC 6: macOS-made pins checked on Linux)."""
    from staysignal.world.pins import compare

    problems = compare(
        json.loads(Path(args.manifest).read_text()), json.loads((Path(args.dir) / "manifest.json").read_text())
    )
    for p in problems:
        print(p)
    print(f"world verify: {'ok' if not problems else f'{len(problems)} difference(s)'} against {args.manifest}")
    return 0 if not problems else 1


def cmd_warehouse_build(args: argparse.Namespace) -> int:
    """dbt build in process on the warehouse at a vintage under a payroll mapping (ADR 0012), with lineage capture."""
    from staysignal.duck import open_duckdb
    from staysignal.forecast.published_tables import ensure
    from staysignal.lineage.capture import build, column_edges

    db = Path(args.db)
    con = open_duckdb(db)
    ensure(con)
    t0 = time.perf_counter()
    res = build(db, Path(args.target), {"vintage": args.vintage, "pay_basis_mapping": args.mapping})
    statuses: dict[str, int] = {}
    for r in res.results_by_name().values():
        statuses[r["status"]] = statuses.get(r["status"], 0) + 1
    (Path(args.target) / "openlineage.json").write_text(json.dumps(res.events, indent=1, default=str) + "\n")
    con.close()
    print(
        json.dumps(
            {
                "success": res.success,
                "seconds": round(time.perf_counter() - t0, 1),
                "results": statuses,
                "lineage_events": len(res.events),
                "column_edges": len(column_edges(res.events)),
            }
        )
    )
    return 0 if res.success else 1


def cmd_warehouse_compile_bigquery(args: argparse.Namespace) -> int:
    """Offline BigQuery compile of every model and test (no credentials, no network), the banned-construct scan and
    a sqlglot parse of the compiled SQL (SPEC 21). Exits non-zero on any finding."""
    from staysignal.prod.dialect import compile_bigquery

    res = compile_bigquery(Path(args.target))
    print(json.dumps({k: v for k, v in res.items() if k != "compiled_dir"}, indent=1))
    return 0 if res["ok"] and not res["banned"] and not res["unparsed"] else 1


def cmd_semantic_catalog(args: argparse.Namespace) -> int:
    """Compile the semantic catalog for DuckDB and BigQuery with MetricFlow (SPEC 7.3); --check diffs."""
    from staysignal.semantic.catalog import build as build_catalog

    return build_catalog(check=args.check)


def cmd_audit_actions(args: argparse.Namespace) -> int:
    """The action audit (SPEC 17.7): recorded in results/ and exported as the API fixture and the engine's copy."""
    from staysignal.audit.action_audit import run
    from staysignal.fixtures.export_api import write_json

    repo, var = _repo_var()
    path, doc = run(Path(args.world), repo / "results")
    for out in (
        repo / "test" / "fixtures" / "api" / "action-audit.json",
        var / "engine" / "published" / "action-audit.json",
    ):
        if out.parent.exists():
            write_json(out, doc, compact=True)
    print(json.dumps({"written": str(path.relative_to(repo)), "units": doc["units"], "reviews": doc["reviews"]}))
    return 0


def cmd_memory_export_fixture(args: argparse.Namespace) -> int:
    """The demo memory as an API fixture for the fixtures mode, with the parity search results."""
    from staysignal.memory.store import FIXTURE, export_fixture

    doc = export_fixture()
    print(json.dumps({"written": str(FIXTURE.relative_to(FIXTURE.parents[3])), "files": len(doc["files"])}))
    return 0


def cmd_semantic_export_fixtures(args: argparse.Namespace) -> int:
    """Export the default semantic-catalog results from a fresh canonical warehouse as API fixtures."""
    from staysignal.semantic.fixtures import OUT, export

    paths = export(Path(args.world), Path(args.out) if args.out else OUT)
    print(json.dumps({"written": len(paths), "dir": str(Path(args.out) if args.out else OUT)}))
    return 0


def _repo_var() -> tuple[Path, Path]:
    from staysignal.paths import REPO_ROOT, VAR

    return REPO_ROOT, VAR


def cmd_engine_prepare(args: argparse.Namespace) -> int:
    """The local engine's starting state (SPEC 22.4): the canonical world landed and loaded (the September payroll held
    back), the warehouse built at the 2026-10-01 vintage, and the published documents and tables of the two published
    runs, which `demo build` computes from the world's extracts with the committed models. --fresh starts from an
    empty warehouse."""
    import shutil
    from datetime import UTC, datetime

    from staysignal.duck import open_duckdb
    from staysignal.forecast.published_tables import ensure, write_run
    from staysignal.ingest import mappings
    from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
    from staysignal.lineage.capture import build
    from staysignal.service.demo import build as demo_build
    from staysignal.world.emit import generate
    from staysignal.world.spec import PROFILES

    repo, var = _repo_var()
    t0 = time.perf_counter()
    if args.fresh:
        for p in (var / "warehouse.duckdb", var / "warehouse.duckdb.wal"):
            p.unlink(missing_ok=True)
        for d in (var / "landing", var / "engine", var / "replay"):
            shutil.rmtree(d, ignore_errors=True)
    world = var / "world"
    if not (world / "manifest.json").exists():
        generate(PROFILES["canonical"], world)
    con = open_duckdb(var / "warehouse.duckdb")
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    out = ingest(con, paths, var / "landing", datetime(2023, 4, 1, 6, tzinfo=UTC))
    mappings.write_raw(con)
    refresh_employee_keys(con)
    ensure(con)
    res = build(
        var / "warehouse.duckdb",
        var / "engine" / "work" / "dbt-prepare",
        {"vintage": "2026-10-01T06:00:00Z", "pay_basis_mapping": "payroll@1"},
    )
    published = var / "engine" / "published"
    precomputed = var / "engine" / "precomputed-jobs"
    demo_build(world, repo / "models", published, jobs_dir=precomputed, cache_dir=var / "cache")
    # keep only the published runs: the routine's candidates are computed live by the runner, never precomputed
    keep = {b["run_id"].replace("#", "-") for b in json.loads((published / "runs.json").read_text())["runs"]}
    for folder in ("forecast", "profiles"):
        for doc in (published / folder).glob("*.json"):
            if doc.stem not in keep:
                doc.unlink()
    shutil.rmtree(precomputed, ignore_errors=True)
    from staysignal.evaluate.report import evaluation_fixture
    from staysignal.fixtures.export_api import write_json

    fx = evaluation_fixture(repo / "results")
    if fx is not None:
        write_json(published / "evaluation.json", fx, compact=True)
    audits = sorted((repo / "results").glob("action-audit-*.json"))
    if audits:  # the recorded action audit, served at /published/action-audit
        write_json(published / "action-audit.json", json.loads(audits[-1].read_text()), compact=True)
    for doc in sorted((published / "forecast").glob("*.json")):
        write_run(con, json.loads(doc.read_text()))
    con.close()
    from staysignal.memory.store import prepare as prepare_memory

    prepare_memory(var / "memory")  # the seed and the demo day's digest (SPEC 22.4)
    print(
        json.dumps(
            {
                "files": len(out),
                "loaded": sum(o["loaded"] for o in out),
                "warehouse_build": res.success,
                "seconds": round(time.perf_counter() - t0, 1),
            }
        )
    )
    return 0 if res.success else 1


def runner_token(repo: Path) -> str | None:
    import os
    import re

    if os.environ.get("SS_RUNNER_TOKEN"):
        return os.environ["SS_RUNNER_TOKEN"]
    dev = repo / ".dev.vars"
    if dev.exists():
        for line in dev.read_text().splitlines():
            m = re.match(r"^SS_RUNNER_TOKEN='(.*)'$", line.strip())
            if m:
                return m.group(1)
    return None


def cmd_serve(args: argparse.Namespace) -> int:
    """The engine process: the warehouse shim on 127.0.0.1:8196 and the runner thread leasing jobs from the Worker.
    One process owns the warehouse connection (ADR 0012)."""
    import threading

    import uvicorn

    from staysignal.runner.jobs import EngineState
    from staysignal.runner.loop import run_forever
    from staysignal.service.app import create_app

    repo, var = _repo_var()
    st = EngineState.open(repo, var)
    if not (st.published_dir / "runs.json").exists():
        print("no published state: run `staysignal engine prepare` first")
        return 1
    stop = threading.Event()
    token = runner_token(repo)
    if args.worker:
        if not token:
            print("SS_RUNNER_TOKEN missing (npm run dev:keys)")
            return 1
        threading.Thread(target=run_forever, args=(st, args.worker, token, stop), daemon=True).start()
    try:
        uvicorn.run(create_app(st, writer_token=token), host=args.host, port=args.port, log_level="warning")
    finally:
        stop.set()
        st.con.close()
    return 0


def read_env_file(path: Path) -> dict[str, str]:
    """KEY=value lines of the operator's gitignored secrets file; quotes trimmed, comments and blanks skipped."""
    out: dict[str, str] = {}
    if path.exists():
        for line in path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip("'\"")
    return out


def prod_runner_config(env: dict[str, str], worker: str | None) -> tuple[dict, list[str]]:
    """The production runner's Worker URL and Access service-token headers, or the reasons it cannot start."""
    from urllib.parse import urlparse

    from staysignal.runner.loop import access_headers

    problems = []
    url = worker or env.get("SS_WORKER_URL", "")
    u = urlparse(url)
    if u.scheme != "https" or not u.hostname or u.hostname in ("localhost", "127.0.0.1"):
        problems.append("the production Worker URL must be https and not local (--worker or SS_WORKER_URL)")
    cid, secret = env.get("SS_RUNNER_CLIENT_ID", ""), env.get("SS_RUNNER_CLIENT_SECRET", "")
    if not cid or not secret:
        problems.append(
            "SS_RUNNER_CLIENT_ID and SS_RUNNER_CLIENT_SECRET (the staysignal-runner service token) are missing"
        )
    return {"base": url.rstrip("/"), "headers": access_headers(cid, secret)}, problems


def cmd_runner_prod(args: argparse.Namespace) -> int:
    """runner:prod (SPEC 23.2 step 12): the runner thread alone against the production Worker, authenticated with the
    staysignal-runner Access service token, polling at the Worker's pace. Ctrl-C stops it. The secret is never printed."""
    import os
    import signal
    import threading

    from staysignal.runner.jobs import EngineState
    from staysignal.runner.loop import run_forever

    repo, var = _repo_var()
    env = {**read_env_file(repo / ".secrets" / "staysignal.env"), **os.environ}
    cfg, problems = prod_runner_config(env, args.worker)
    if problems:
        print("\n".join(problems), flush=True)
        return 2
    st = EngineState.open(repo, var)
    if not (st.published_dir / "runs.json").exists():
        print("no published state: run `staysignal engine prepare` first", flush=True)
        return 1
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    print(f"[runner:prod] polling {cfg['base']} as the staysignal-runner service token; Ctrl-C stops", flush=True)
    try:
        run_forever(st, cfg["base"], cfg["headers"], stop, owner="engine-runner-prod", max_wait_ms=None)
    finally:
        st.con.close()
    return 0


def cmd_eval_backtest(args: argparse.Namespace) -> int:
    from staysignal.evaluate.report import run_all

    repo, var = _repo_var()
    paths = run_all(var / "world", var / "cache", repo / "results", args.futures, args.workers)
    print(json.dumps({"written": [str(p.relative_to(repo)) for p in paths]}))
    return 0


def cmd_eval_effects(args: argparse.Namespace) -> int:
    from staysignal.evaluate.report import run_effects

    repo, var = _repo_var()
    p = run_effects(var / "world", repo / "models", repo / "results")
    print(json.dumps({"written": str(p.relative_to(repo))}))
    return 0


def cmd_eval_export(args: argparse.Namespace) -> int:
    """Writes the Trust page's data from the latest recorded results (the API fixture and the engine's copy)."""
    from staysignal.evaluate.report import evaluation_fixture
    from staysignal.fixtures.export_api import write_json

    repo, var = _repo_var()
    fx = evaluation_fixture(repo / "results")
    if fx is None:
        print("no recorded backtest yet: run `staysignal eval backtest`")
        return 1
    for out in (
        repo / "test" / "fixtures" / "api" / "evaluation.json",
        var / "engine" / "published" / "evaluation.json",
    ):
        if out.parent.exists():
            write_json(out, fx, compact=True)
            print(f"wrote {out.relative_to(repo)}")
    return 0


def cmd_policy_compile(args: argparse.Namespace) -> int:
    """SPEC 17.2: policy/access.yaml -> policy/compiled/policy.json and the grant plan infra/gcp/grants.json."""
    from staysignal.prod.policy import build

    stale = build(check=args.check)
    if args.check:
        if stale:
            print(f"stale: {', '.join(stale)}; run `npm run policy:compile`")
            return 1
        print("policy and grant plan are current")
        return 0
    print("wrote policy/compiled/policy.json and infra/gcp/grants.json")
    return 0


def cmd_eval_dq_faults(args: argparse.Namespace) -> int:
    """C53: the data-quality fault benchmark on copies of the small world, recorded in results/."""
    import datetime as dt

    from staysignal.quality.faults import FAULTS, SEEDS, run_seed, summarize

    repo, _ = _repo_var()
    t0 = time.perf_counter()
    rows = [r for s in SEEDS for r in run_seed(s)]
    doc = {
        "kind": "dq-faults",
        "command": "uv run --project engine staysignal eval dq-faults",
        "date": dt.date.today().isoformat(),
        "label": "synthetic",
        "design": (
            "each fault injected into what the sources recorded for copies of the small world (seeds 1 to 5, planted "
            "problems off); detection is an active check (phase 1 and the built phase-2 checks F04, R02 and R04) that "
            "fires and did not on the clean copy, and a failing "
            "error-severity check holds the run; localization is the rank of the true root node in the root-cause "
            "ranking; impact is the company's expected 3-month voluntary departures from the faulty sources over the "
            "clean ones, under a model trained on the clean world, had the run not been held"
        ),
        "faults": list(FAULTS),
        "seeds": list(SEEDS),
        "summary": summarize(rows),
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    out = repo / "results" / f"dq-faults-{doc['date']}.json"
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({"written": str(out.relative_to(repo)), "summary": doc["summary"]}, indent=1))
    return 0


def cmd_eval_challenger(args: argparse.Namespace) -> int:
    """C15: SurvivalBoost and the like-for-like 12,000-row model on the comparison's origins (needs the extra)."""
    import datetime as dt

    from staysignal.baselines import survivalboost as sb

    if not sb.available():
        print("the challenger needs the uv extra: uv sync --project engine --extra challenger")
        return 1
    from staysignal.evaluate.challenger import run_challenger
    from staysignal.evaluate.comparison import COMPARISON_ORIGINS
    from staysignal.evaluate.report import comparison_summary
    from staysignal.ingest.landing import load_world_sources
    from staysignal.world.spec import PROFILES

    repo, var = _repo_var()
    world = var / "world"
    sha = json.loads((world / "manifest.json").read_text())["world_sha256"]
    t0 = time.perf_counter()
    origins = COMPARISON_ORIGINS[: args.origins] if args.origins else COMPARISON_ORIGINS
    out = run_challenger(
        load_world_sources(world), PROFILES["canonical"].start, var / "cache", sha, origins, args.n_iter, args.cap
    )
    flags = "" if args.n_iter == sb.N_ITER else f" --n-iter {args.n_iter}"
    flags += "" if args.cap == sb.ROW_CAP else f" --cap {args.cap}"
    flags += f" --origins {args.origins}" if args.origins else ""
    doc = {
        "kind": "challenger",
        "command": f"uv run --project engine staysignal eval challenger{flags}",
        "date": dt.date.today().isoformat(),
        "label": "synthetic",
        "world_sha256": sha,
        "design": (
            f"challenger: hazardous 0.2.0 SurvivalBoost (n_iter {args.n_iter}, Kaplan-Meier IPCW) on at most "
            f"{args.cap:,} person-landmarks from quarterly landmarks, followed up to 180 days; Poisson-binomial "
            "intervals and a shock-aware variant with the main model's sigma draws; dtcr-mnl-12k is the main model "
            "fitted on the same sampled people (the row cap is a handicap both carry)"
        ),
        "n_iter": args.n_iter,
        "row_cap": args.cap,
        "origins": out["origins"],
        "models": out["models"],
        "fits": out["fits"],
        "summary": comparison_summary(out, out["models"]),
        "seconds": round(time.perf_counter() - t0, 1),
        "entries": out["entries"],
    }
    path = repo / "results" / f"challenger-{doc['date']}.json"
    path.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({"written": str(path.relative_to(repo)), "seconds": doc["seconds"]}))
    return 0


def cmd_eval_recovery(args: argparse.Namespace) -> int:
    """C6: the recovery profile's fit against the generator's truth, recorded in results/ (about a minute)."""
    import datetime as dt

    from staysignal.model import recovery
    from staysignal.world.spec import RECOVERY

    repo, _ = _repo_var()
    report = recovery.check(recovery.simulate())
    doc = {
        "kind": "recovery",
        "command": "uv run --project engine staysignal eval recovery",
        "date": dt.date.today().isoformat(),
        "label": "synthetic",
        "profile": RECOVERY.name,
        "seed": RECOVERY.seed,
        "baseline_headcount": RECOVERY.baseline_headcount,
        "months": RECOVERY.months,
        **report,
    }
    out = repo / "results" / f"recovery-{doc['date']}.json"
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k != "slopes"}, indent=2))
    return 0 if all(report["passed"].values()) else 1


def cmd_lab_cells(args: argparse.Namespace) -> int:
    """The Scenario Lab's cohort cells (SPEC 15.2) from the canonical world at the published run's cutoff, written to
    lab/cohort_cells.json: cells of at least 10 people with rounded cohort facts, nothing individual."""
    from datetime import date

    from staysignal.clock import as_cutoff_datetime
    from staysignal.features.reference import Vintage, features_at
    from staysignal.ingest.landing import load_world_sources
    from staysignal.lab.cells import export

    repo, _ = _repo_var()
    cutoff = date.fromisoformat(args.cutoff)
    src = load_world_sources(Path(args.world))
    doc = export(features_at(Vintage(src, as_cutoff_datetime(cutoff)), cutoff), args.run, cutoff)
    out = repo / "lab" / "cohort_cells.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(doc, indent=1, sort_keys=True) + "\n"
    if args.check:
        same = out.exists() and out.read_text() == text
        print(
            "lab/cohort_cells.json is current" if same else "lab/cohort_cells.json is stale: run `staysignal lab cells`"
        )
        return 0 if same else 1
    out.write_text(text)
    print(json.dumps({"written": "lab/cohort_cells.json", "cells": len(doc["cells"]), "withheld": doc["withheld"]}))
    return 0


def cmd_prod_validate(args: argparse.Namespace) -> int:
    """prod:validate (SPEC 23.2): the offline BigQuery compile, then one free dry run per compiled file. Prints the plan
    unless --execute; --execute needs the project ID and application default credentials (the operator's Mac)."""
    import os

    from staysignal.prod import validate
    from staysignal.prod.dialect import compile_bigquery

    res = compile_bigquery(Path(args.target))
    if not res["ok"] or res["banned"] or res["unparsed"]:
        print(json.dumps({k: v for k, v in res.items() if k != "compiled_dir"}, indent=1))
        return 1
    runs = validate.plan(Path(res["compiled_dir"]))
    results = None
    if args.execute:
        project = args.project or os.environ.get("SS_GCP_PROJECT")
        if not project:
            print("--execute needs --project or SS_GCP_PROJECT", flush=True)
            return 2
        from google.cloud import bigquery  # only here: plan mode never builds a client

        client = bigquery.Client(project=project)
        results = validate.execute(runs, client, project, bigquery.QueryJobConfig)
    doc = validate.summarize(runs, results, strict=args.strict)
    print(json.dumps(doc, indent=1))
    if not args.execute:
        print("plan only: nothing was sent; rerun with --execute --project <id> on the operator's machine", flush=True)
    return 0 if doc["ok"] else 1


def cmd_prod_load(args: argparse.Namespace) -> int:
    """prod:load (SPEC 23.2, path B): the canonical world to R2 and BigQuery, dbt build, the published documents.
    Prints the plan unless --execute, which needs the project, the production pseudonym key and the Mac's logins."""
    import os
    import subprocess

    from staysignal.prod import load

    repo, var = _repo_var()
    world, published = Path(args.world), Path(args.published)
    if not (world / "manifest.json").exists() or not (published / "runs.json").exists():
        print(f"needs the canonical world in {world} and the published documents in {published}", flush=True)
        return 2
    p = load.plan(world, published, repo / "demo" / "lab")
    print(json.dumps(p.summary(), indent=1))
    if not args.execute:
        print("plan only: nothing was sent; rerun with --execute --project <id> on the operator's machine", flush=True)
        return 0 if not p.rejected else 1
    project = args.project or os.environ.get("SS_GCP_PROJECT")
    blocked = load.preflight(dict(os.environ), project)
    if blocked or p.rejected:
        print("\n".join(blocked + [f"not a known extract: {x}" for x in p.rejected]), flush=True)
        return 2
    from google.cloud import bigquery

    from staysignal.lineage.capture import invoke

    client = bigquery.Client(project=project)

    def r2_put(key: str, path: Path) -> None:
        subprocess.run(
            ["npx", "wrangler", "r2", "object", "put", f"{load.BUCKET}/{key}", "--file", str(path), "--remote"],
            check=True,
            capture_output=True,
        )

    def load_parquet(path: Path, table: str) -> None:
        cfg = bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            labels=load.LABELS,
        )
        with path.open("rb") as fh:
            client.load_table_from_file(fh, table, job_config=cfg).result()

    def load_documents(rows: list[dict], table: str) -> None:
        cfg = bigquery.LoadJobConfig(
            schema=[
                bigquery.SchemaField("key", "STRING", "REQUIRED"),
                bigquery.SchemaField("doc", "STRING", "REQUIRED"),
            ],
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            labels=load.LABELS,
        )
        client.load_table_from_json(rows, table, job_config=cfg).result()

    def dbt_build(profiles: Path, dbt_vars: dict) -> bool:
        ok, _ = invoke(
            ["build"], var / "prod" / "unused.duckdb", var / "prod" / "dbt", profiles_dir=profiles, dbt_vars=dbt_vars
        )
        return ok

    res = load.execute(
        p, world, published, var / "prod" / "load", project, load.Deps(r2_put, load_parquet, load_documents, dbt_build)
    )
    print(json.dumps(res, indent=1))
    return 0 if res["ok"] else 1


def cmd_eval_recovery_shock(args: argparse.Namespace) -> int:
    """C6, shock-world variant (SPEC 9.1): with --targets, fit the 200,200-person shock world once and cache the
    marginal targets in results/recovery-shock-targets.json (several minutes, about 8 GB); without, fit a separate
    40,040-person shock world against the cached targets and record the checks in results/."""
    import datetime as dt

    from staysignal.model import recovery
    from staysignal.world.spec import TARGETS_FACTOR, recovery_shock_profile

    repo, _ = _repo_var()
    cache = repo / "results" / "recovery-shock-targets.json"
    if args.targets:
        profile = recovery_shock_profile(TARGETS_FACTOR, seed=1012)
        doc = {
            "kind": "recovery-shock-targets",
            "command": "uv run --project engine staysignal eval recovery-shock --targets",
            "date": dt.date.today().isoformat(),
            "label": "synthetic",
            "profile": profile.name,
            "seed": profile.seed,
            "sigma_team": profile.sigma_team,
            "baseline_headcount": profile.baseline_headcount,
            "months": profile.months,
            **recovery.marginal_targets(recovery.simulate(profile)),
        }
        cache.write_text(json.dumps(doc, indent=1) + "\n")
        print(json.dumps({k: v for k, v in doc.items() if k not in ("theta", "cov", "params")}, indent=2))
        return 0
    targets = json.loads(cache.read_text())
    profile = recovery_shock_profile()
    report = recovery.check(recovery.simulate(profile), targets)
    doc = {
        "kind": "recovery-shock",
        "command": "uv run --project engine staysignal eval recovery-shock",
        "date": dt.date.today().isoformat(),
        "label": "synthetic",
        "profile": profile.name,
        "seed": profile.seed,
        "sigma_team": profile.sigma_team,
        "baseline_headcount": profile.baseline_headcount,
        "months": profile.months,
        "targets": {
            "file": "results/recovery-shock-targets.json",
            "seed": targets["seed"],
            "baseline_headcount": targets["baseline_headcount"],
            "rows": targets["rows"],
        },
        **report,
    }
    out = repo / "results" / f"recovery-shock-{doc['date']}.json"
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(json.dumps({k: v for k, v in doc.items() if k != "slopes"}, indent=2))
    return 0 if all(report["passed"].values()) else 1


def cmd_eval_oracle_coverage(args: argparse.Namespace) -> int:
    import datetime as dt

    from staysignal.evaluate.oracle_coverage import coverage
    from staysignal.world.spec import PROFILES

    report = coverage(PROFILES[args.profile], n_futures=args.futures, workers=args.workers)
    report = {
        "command": f"uv run --project engine staysignal eval oracle-coverage --futures {args.futures}",
        "date": dt.date.today().isoformat(),
        **report,
    }
    out = Path(args.out or f"results/oracle-coverage-{report['date']}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1, sort_keys=False) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "detail"}, indent=2))
    return 0 if report["within_band"] else 1


def cmd_ingest_land(args: argparse.Namespace) -> int:
    """Lands and loads a world's extracts into the local warehouse (idempotent by file hash)."""
    from datetime import UTC, datetime

    from staysignal.duck import open_duckdb
    from staysignal.ingest import mappings
    from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys

    world = Path(args.world)
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    if args.held:
        paths += sorted((world / "held").glob("*.csv"))
    con = open_duckdb(args.db)
    out = ingest(con, paths, Path(args.landing), datetime(2023, 4, 1, 6, tzinfo=UTC))
    n_maps = mappings.write_raw(con)
    refresh_employee_keys(con)
    con.close()
    new = sum(1 for o in out if o["loaded"])
    print(json.dumps({"files": len(out), "loaded": new, "already_loaded": len(out) - new, "mapping_rows": n_maps}))
    return 0


def cmd_snapshot_conformed(args: argparse.Namespace) -> int:
    from staysignal.clock import parse_ts
    from staysignal.duck import open_duckdb
    from staysignal.ingest.conformed import snapshot

    con = open_duckdb(args.db)
    manifest = snapshot(con, parse_ts(args.as_of), Path(args.out))
    con.close()
    print(json.dumps(manifest, indent=2))
    return 0


def cmd_demo_build(args: argparse.Namespace) -> int:
    from staysignal.service.demo import build

    build(Path(args.world), Path(args.models), Path(args.out), retrain=args.retrain)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="staysignal", description="StaySignal engine (synthetic data only)")
    parser.add_argument("--version", action="version", version=f"staysignal {__version__}")
    sub = parser.add_subparsers(dest="command")
    world = sub.add_parser("world", help="synthetic world")
    wsub = world.add_subparsers(dest="world_command", required=True)
    gen = wsub.add_parser("generate", help="generate a world profile")
    gen.add_argument("--profile", default="canonical", choices=["canonical", "small"])
    gen.add_argument("--seed", type=int, default=None)
    gen.add_argument("--out", default="var/world")
    gen.set_defaults(func=cmd_world_generate)
    ver = wsub.add_parser("verify", help="compare a generated world with the committed pins")
    ver.add_argument("--manifest", default="data/world/manifest.json")
    ver.add_argument("--dir", default="var/world")
    ver.set_defaults(func=cmd_world_verify)
    ing = sub.add_parser("ingest", help="landing and raw loads")
    isub = ing.add_subparsers(dest="ingest_command", required=True)
    land = isub.add_parser("land", help="land and load a world's extracts (idempotent by file hash)")
    land.add_argument("--world", default="var/world")
    land.add_argument("--held", action="store_true", help="include the held-back September payroll files")
    land.add_argument("--db", default="var/warehouse.duckdb")
    land.add_argument("--landing", default="var/landing")
    land.set_defaults(func=cmd_ingest_land)
    snap = sub.add_parser("snapshot", help="conformed snapshots")
    ssub = snap.add_subparsers(dest="snapshot_command", required=True)
    conf = ssub.add_parser("conformed", help="typed, deduplicated, pseudonymized records known at a vintage")
    conf.add_argument("--as-of", required=True, help="vintage, for example 2026-10-01T06:00:00Z")
    conf.add_argument("--db", default="var/warehouse.duckdb")
    conf.add_argument("--out", default="var/conformed")
    conf.set_defaults(func=cmd_snapshot_conformed)
    wh = sub.add_parser("warehouse", help="dbt on the local DuckDB warehouse")
    whsub = wh.add_subparsers(dest="warehouse_command", required=True)
    whb = whsub.add_parser("build", help="dbt build in process at a vintage, with lineage capture")
    whb.add_argument("--vintage", default="2026-10-01T06:00:00Z")
    whb.add_argument("--mapping", default="payroll@1")
    whb.add_argument("--db", default="var/warehouse.duckdb")
    whb.add_argument("--target", default="var/dbt/target")
    whb.set_defaults(func=cmd_warehouse_build)
    whc = whsub.add_parser(
        "compile-bigquery", help="offline BigQuery compile with the banned-construct scan (no credentials)"
    )
    whc.add_argument("--target", default="var/dbt/bigquery-target")
    whc.set_defaults(func=cmd_warehouse_compile_bigquery)
    sem = sub.add_parser("semantic", help="the governed semantic layer")
    semsub = sem.add_subparsers(dest="semantic_command", required=True)
    cat = semsub.add_parser("catalog", help="compile every governed query shape for DuckDB and BigQuery")
    cat.add_argument("--check", action="store_true", help="fail if the committed catalogs are stale")
    cat.set_defaults(func=cmd_semantic_catalog)
    exf = semsub.add_parser("export-fixtures", help="the default catalog results as API fixtures (fixtures mode)")
    exf.add_argument("--world", default="var/world")
    exf.add_argument("--out", default=None)
    exf.set_defaults(func=cmd_semantic_export_fixtures)
    aud = sub.add_parser("audit", help="the action audit (adverse-impact screen of approved reviews)")
    audsub = aud.add_subparsers(dest="audit_command", required=True)
    aac = audsub.add_parser("actions", help="screen the approved reviews by tenure band, location and the age flag")
    aac.add_argument("--world", default="var/world")
    aac.set_defaults(func=cmd_audit_actions)
    mem = sub.add_parser("memory", help="the git-backed Markdown memory")
    memsub = mem.add_subparsers(dest="memory_command", required=True)
    mex = memsub.add_parser("export-fixture", help="the demo memory as an API fixture (fixtures mode)")
    mex.set_defaults(func=cmd_memory_export_fixture)
    eng = sub.add_parser("engine", help="the local engine's state")
    esub0 = eng.add_subparsers(dest="engine_command", required=True)
    prep = esub0.add_parser("prepare", help="land the world, build the warehouse, publish the two published runs")
    prep.add_argument("--fresh", action="store_true", help="start from an empty warehouse and landing store")
    prep.set_defaults(func=cmd_engine_prepare)
    srv = sub.add_parser("serve", help="the warehouse shim on 8196 and the runner thread")
    srv.add_argument("--host", default="127.0.0.1")
    srv.add_argument("--port", type=int, default=8196)
    srv.add_argument("--worker", default=None, help="the Worker to lease jobs from, for example http://127.0.0.1:8795")
    srv.set_defaults(func=cmd_serve)
    ev = sub.add_parser("eval", help="recorded evaluations (synthetic world)")
    esub = ev.add_subparsers(dest="eval_command", required=True)
    bt = esub.add_parser("backtest", help="monthly backtests, calibration and the model comparison (results/)")
    bt.add_argument("--futures", type=int, default=2000)
    bt.add_argument("--workers", type=int, default=None)
    bt.set_defaults(func=cmd_eval_backtest)
    ef = esub.add_parser(
        "effects", help="feature effects (partial dependence) for the published model, recorded in results/"
    )
    ef.set_defaults(func=cmd_eval_effects)
    ex = esub.add_parser("export", help="the Trust page's data from the latest recorded results")
    ex.set_defaults(func=cmd_eval_export)
    dq = esub.add_parser("dq-faults", help="C53: the data-quality fault benchmark on the small world")
    dq.set_defaults(func=cmd_eval_dq_faults)
    ch = esub.add_parser("challenger", help="C15: SurvivalBoost and a like-for-like model on the comparison origins")
    ch.add_argument("--n-iter", type=int, default=100)
    ch.add_argument("--cap", type=int, default=12_000)
    ch.add_argument("--origins", type=int, default=None, help="only the first N comparison origins")
    ch.set_defaults(func=cmd_eval_challenger)
    rc = esub.add_parser("recovery", help="C6: the fit on the recovery world against the generator's truth")
    rc.set_defaults(func=cmd_eval_recovery)
    lab = sub.add_parser("lab", help="Scenario Lab inputs (hypothesis generation with synthetic personas)")
    labsub = lab.add_subparsers(dest="lab_command", required=True)
    lc = labsub.add_parser("cells", help="cohort cells of at least 10 people for the personas")
    lc.add_argument("--world", default="var/world")
    lc.add_argument("--run", default="R-2026-10-01#1")
    lc.add_argument("--cutoff", default="2026-10-01")
    lc.add_argument("--check", action="store_true", help="fail when the committed file differs")
    lc.set_defaults(func=cmd_lab_cells)
    prod = sub.add_parser("prod", help="the production path (operator only; plan-only unless --execute)")
    psub = prod.add_subparsers(dest="prod_command", required=True)
    pv = psub.add_parser("validate", help="BigQuery dry runs of every compiled model and test (free)")
    pv.add_argument("--execute", action="store_true", help="send the dry runs (application default credentials)")
    pv.add_argument("--strict", action="store_true", help="after prod:load: every file must pass")
    pv.add_argument("--project", default=None, help="Google Cloud project ID (or SS_GCP_PROJECT)")
    pv.add_argument("--target", default="var/dbt-bigquery-validate", help="dbt target path for the compile")
    pv.set_defaults(func=cmd_prod_validate)
    rp = sub.add_parser("runner", help="the runner against the production Worker (operator only)")
    rpsub = rp.add_subparsers(dest="runner_command", required=True)
    rpp = rpsub.add_parser("prod", help="lease jobs from the production Worker with the runner service token")
    rpp.add_argument("--worker", default=None, help="the production Worker's https URL (or SS_WORKER_URL)")
    rpp.set_defaults(func=cmd_runner_prod)
    pl = psub.add_parser("load", help="the canonical world to R2 and BigQuery, dbt build, published documents")
    pl.add_argument("--execute", action="store_true", help="run the plan (the operator's Mac, after setup:prod B)")
    pl.add_argument("--project", default=None, help="Google Cloud project ID (or SS_GCP_PROJECT)")
    pl.add_argument("--world", default="var/world")
    pl.add_argument("--published", default="test/fixtures/api", help="the published documents (demo build output)")
    pl.set_defaults(func=cmd_prod_load)
    rs = esub.add_parser("recovery-shock", help="C6 shock-world variant: the fit against simulated marginal targets")
    rs.add_argument("--targets", action="store_true", help="fit the 200,200-person world and cache the targets")
    rs.set_defaults(func=cmd_eval_recovery_shock)
    oc = esub.add_parser("oracle-coverage", help="C5: oracle 90% intervals against realized counts")
    oc.add_argument("--profile", default="canonical", choices=["canonical", "small"])
    oc.add_argument("--futures", type=int, default=2000)
    oc.add_argument("--workers", type=int, default=None)
    oc.add_argument("--out", default=None)
    oc.set_defaults(func=cmd_eval_oracle_coverage)
    pol = sub.add_parser("policy", help="purpose-scoped data access for the production path")
    psub = pol.add_subparsers(dest="policy_command", required=True)
    pc = psub.add_parser("compile", help="compile policy/access.yaml into the compiled policy and the grant plan")
    pc.add_argument("--check", action="store_true", help="fail when a generated file drifts")
    pc.set_defaults(func=cmd_policy_compile)
    demo = sub.add_parser("demo", help="demo state")
    dsub = demo.add_subparsers(dest="demo_command", required=True)
    db = dsub.add_parser("build", help="train or load models, score the published runs, export API fixtures")
    db.add_argument("--world", default="var/world")
    db.add_argument("--models", default="models")
    db.add_argument("--out", default="test/fixtures/api")
    db.add_argument("--retrain", action="store_true")
    db.set_defaults(func=cmd_demo_build)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
