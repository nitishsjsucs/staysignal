"""`staysignal semantic catalog [--check]`: render every governed query shape of the semantic layer with MetricFlow
ahead of time, for DuckDB and BigQuery (SPEC 7.3). Copied from PeopleLens `src/peoplelens/catalog/compiler.py` (MIT),
adapted for StaySignal.

MetricFlow is Python and cannot run inside a Worker, so the Worker (BigQuery in production) and the engine's
warehouse shim (DuckDB locally) execute SQL that MetricFlow generated at build time from the governed semantic
layer; tools only bind parameters to catalog entries. Each dialect compiles in its own subprocess, because
MetricFlow's configuration is process-global:

  1. `dbt parse` into `warehouse/target` with the dialect's profile (DuckDB on a scratch file, or the offline
     BigQuery compile profile, which needs no credentials)
  2. `CLIConfiguration().setup(<profiles dir>, warehouse)` reads `warehouse/target/semantic_manifest.json`
  3. a manifest guard checks the adapter type, so one dialect's manifest is never rendered as the other's
  4. `mf.explain(MetricFlowQueryRequest.create(...)).sql_statement.sql` per shape

No query runs. DuckDB SQL is made database-neutral (the scratch file's database qualifier is removed) so it runs on
the engine's connection whatever the file is called. `--check` compiles again and diffs against the committed files.
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path

from staysignal.lineage.capture import PROJECT_DIR, invoke
from staysignal.paths import REPO_ROOT
from staysignal.semantic import params as P

GENERATED = REPO_ROOT / "src" / "worker" / "generated"
DIALECTS = ("duckdb", "bigquery")
PROFILES = {"duckdb": PROJECT_DIR / "profiles" / "duckdb", "bigquery": PROJECT_DIR / "profiles" / "bigquery_compile"}
ADAPTER = {"duckdb": "duckdb", "bigquery": "bigquery"}
BIGQUERY_PROJECT_PLACEHOLDER = "staysignal-project-id"
SCRATCH_DB = "catalog_scratch"


class CompileError(RuntimeError):
    pass


def output_path(dialect: str) -> Path:
    return GENERATED / f"catalog.{dialect}.json"


def dump_json(obj: object) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=False) + "\n"


def tidy(sql: str, dialect: str) -> str:
    """Drop comment lines; on DuckDB also drop the scratch database qualifier."""
    lines = [ln.rstrip() for ln in sql.splitlines() if ln.strip() and not ln.strip().startswith("--")]
    out = "\n".join(lines) + "\n"
    if dialect == "duckdb":
        out = re.sub(rf'"?{SCRATCH_DB}"?\.', "", out)
    return out


def semantic_sources_sha256() -> str:
    """SHA-256 over the semantic layer's YAML and the published models it reads (machine-independent)."""
    h = hashlib.sha256()
    for path in sorted((PROJECT_DIR / "models" / "semantic").glob("*")) + [
        PROJECT_DIR / "models" / "published" / "rpt_flows_monthly.sql"
    ]:
        h.update(path.name.encode())
        h.update(path.read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------- child process


def compile_dialect(dialect: str) -> dict:
    """Parse, set up MetricFlow, guard and render every shape for one dialect (run in a subprocess)."""
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / f"{SCRATCH_DB}.duckdb"
        ok, _ = invoke(["parse", "--no-partial-parse"], db, PROJECT_DIR / "target", profiles_dir=PROFILES[dialect])
        if not ok:
            raise CompileError(f"dbt parse failed for {dialect}")
        os.environ.pop("DBT_PROFILES_DIR", None)
        from dbt_metricflow.cli.cli_configuration import CLIConfiguration
        from metricflow.engine.metricflow_engine import MetricFlowQueryRequest

        cfg = CLIConfiguration()
        cfg.setup(dbt_profiles_path=PROFILES[dialect], dbt_project_path=PROJECT_DIR, configure_file_logging=False)
        adapter = cfg.dbt_artifacts.adapter.type()
        if adapter != ADAPTER[dialect]:
            raise CompileError(f"manifest guard: adapter {adapter!r} while compiling {dialect}; rerun dbt parse")
        entries: dict[str, dict] = {}
        for bundle, level, grain in P.shapes():
            group_by = P.group_by_names(level, grain)
            request = MetricFlowQueryRequest.create(
                metric_names=P.BUNDLES[bundle],
                group_by_names=group_by or None,
                where_constraints=P.where_filters(dialect),
                order_by_names=group_by or None,
            )
            sql = tidy(cfg.mf.explain(request).sql_statement.sql, dialect)
            key = P.catalog_key(bundle, level, grain)
            entries[key] = {
                "key": key,
                "bundle": bundle,
                "level": level,
                "grain": grain,
                "metrics": P.BUNDLES[bundle],
                "columns": {
                    "dimensions": {d: P.DIMENSIONS[d] for d in P.LEVELS[level]},
                    "time": P.time_name(grain),
                    "values": P.BUNDLES[bundle],
                },
                "params": P.param_contract(dialect),
                "sql": sql,
                "sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
            }
    return {
        "header": {
            "dialect": dialect,
            "label": "synthetic",
            "entries": len(entries),
            "metricflow": version("metricflow"),
            "dbt_metricflow": version("dbt-metricflow"),
            "dbt_core": version("dbt-core"),
            "semantic_sources_sha256": semantic_sources_sha256(),
            "project_placeholder": BIGQUERY_PROJECT_PLACEHOLDER if dialect == "bigquery" else None,
        },
        "entries": entries,
    }


def _child_main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m staysignal.semantic.catalog")
    parser.add_argument("--dialect", required=True, choices=DIALECTS)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    saved = os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)  # never read real credentials
    try:
        catalog = compile_dialect(args.dialect)
    except CompileError as exc:
        print(str(exc), file=sys.stderr)
        return 3
    finally:
        if saved is not None:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = saved
    Path(args.out).write_text(dump_json(catalog), encoding="utf-8")
    return 0


# ---------------------------------------------------------------- parent process


def compile_all() -> dict[str, str]:
    """{dialect: JSON text}, each compiled in its own subprocess."""
    out: dict[str, str] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for dialect in DIALECTS:
            target = Path(tmp) / f"{dialect}.json"
            res = subprocess.run(
                [sys.executable, "-m", "staysignal.semantic.catalog", "--dialect", dialect, "--out", str(target)],
                capture_output=True,
                text=True,
                cwd=REPO_ROOT,
                env={**os.environ, "DBT_SEND_ANONYMOUS_USAGE_STATS": "false", "DO_NOT_TRACK": "1"},
            )
            if res.returncode != 0:
                raise CompileError(f"catalog compile failed for {dialect}:\n{res.stdout[-2000:]}\n{res.stderr[-4000:]}")
            out[dialect] = target.read_text(encoding="utf-8")
    return out


def build(check: bool = False) -> int:
    compiled = compile_all()
    stale = []
    for dialect, text in compiled.items():
        path = output_path(dialect)
        if check:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if current != text:
                stale.append(dialect)
                diff = difflib.unified_diff(current.splitlines(), text.splitlines(), str(path), "compiled", lineterm="")
                print("\n".join(list(diff)[:60]))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"wrote {path.relative_to(REPO_ROOT)} ({json.loads(text)['header']['entries']} entries)")
    if stale:
        print(f"stale catalogs: {', '.join(stale)}; run `uv run --project engine staysignal semantic catalog`")
        return 1
    if check:
        print("semantic catalogs are current")
    return 0


def load(dialect: str = "duckdb") -> dict:
    return json.loads(output_path(dialect).read_text(encoding="utf-8"))


if __name__ == "__main__":
    raise SystemExit(_child_main(sys.argv[1:]))
