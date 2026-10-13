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
    oc = esub.add_parser("oracle-coverage", help="C5: oracle 90% intervals against realized counts")
    oc.add_argument("--profile", default="canonical", choices=["canonical", "small"])
    oc.add_argument("--futures", type=int, default=2000)
    oc.add_argument("--workers", type=int, default=None)
    oc.add_argument("--out", default=None)
    oc.set_defaults(func=cmd_eval_oracle_coverage)
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
