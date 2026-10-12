"""dbt in process with lineage capture (ADR 0012, SPEC 13.2).

`build` runs dbt through `dbtRunner` against the warehouse file the engine already holds open. The dbt profile passes
`TimeZone=UTC` as a connection option, the same configuration as `duck.open_duckdb`, so DuckDB lets both connections
share one database instance; any other configuration fails with "different configuration". After the build,
OpenLineage events are produced from dbt's `manifest.json` and `run_results.json` by the same artifact processor
`dbt-ol` uses (`DbtLocalArtifactProcessor`), so the events equal `dbt-ol build`'s apart from run IDs and times
(`engine/tests/lineage/test_inprocess_lineage.py` compares them on a toy project; the subprocess path of ADR 0012 is
the fallback if they ever differ).

Anonymous usage statistics are always off: nothing leaves the machine.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from staysignal.paths import REPO_ROOT

PROJECT_DIR = REPO_ROOT / "warehouse"
PROFILES_DIR = PROJECT_DIR / "profiles" / "duckdb"
NAMESPACE = "staysignal"

# one dbt invocation at a time per process; the warehouse shim answers 503 "warehouse busy" while it is held
BUILD_LOCK = threading.Lock()


@dataclass
class BuildResult:
    success: bool
    target_path: Path
    run_results: dict[str, Any]
    manifest: dict[str, Any]
    events: list[dict[str, Any]] = field(default_factory=list)

    def results_by_name(self) -> dict[str, dict[str, Any]]:
        nodes = self.manifest.get("nodes", {})
        out = {}
        for r in self.run_results.get("results", []):
            node = nodes.get(r["unique_id"], {})
            out[node.get("name", r["unique_id"])] = {**r, "node": node}
        return out


def _env(db_path: Path) -> None:
    os.environ["SS_WAREHOUSE"] = str(Path(db_path).resolve())
    os.environ["DBT_SEND_ANONYMOUS_USAGE_STATS"] = "false"
    os.environ["DO_NOT_TRACK"] = "1"


def invoke(
    args: list[str],
    db_path: Path,
    target_path: Path,
    project_dir: Path = PROJECT_DIR,
    profiles_dir: Path = PROFILES_DIR,
    dbt_vars: dict[str, Any] | None = None,
    callbacks: list[Any] | None = None,
) -> tuple[bool, Path]:
    from dbt.cli.main import dbtRunner

    _env(db_path)
    target_path = Path(target_path).resolve()  # dbt resolves relative paths against the project directory
    target_path.mkdir(parents=True, exist_ok=True)
    full = [
        *args,
        "--project-dir",
        str(project_dir),
        "--profiles-dir",
        str(profiles_dir),
        "--target-path",
        str(target_path),
        "--log-path",
        str(target_path / "logs"),
        "--no-send-anonymous-usage-stats",
        "--quiet",
    ]
    if dbt_vars:
        full += ["--vars", json.dumps(dbt_vars, sort_keys=True)]
    with BUILD_LOCK:
        res = dbtRunner(callbacks=callbacks or []).invoke(full)
    if res.exception is not None:
        raise RuntimeError(f"dbt {' '.join(args)} failed to run: {res.exception}")
    return bool(res.success), target_path


def lineage_events(target_path: Path, project_dir: Path = PROJECT_DIR) -> list[dict[str, Any]]:
    """OpenLineage events from the build's artifacts, exactly as dbt-ol's artifact mode produces them."""
    from openlineage.client.serde import Serde
    from openlineage.common.provider.dbt import DbtLocalArtifactProcessor
    from openlineage.common.provider.dbt.utils import PRODUCER

    processor = DbtLocalArtifactProcessor(
        producer=PRODUCER,
        target=None,
        target_path=str(target_path),
        job_namespace=NAMESPACE,
        project_dir=str(project_dir),
        profile_name=None,
        logger=logging.getLogger("staysignal.lineage"),
        models=[],
        selector=None,
    )
    os.environ.setdefault("DBT_PROFILES_DIR", str(PROFILES_DIR))
    return [Serde.to_dict(e) for e in processor.parse().events()]


def build(
    db_path: Path,
    target_path: Path,
    dbt_vars: dict[str, Any] | None = None,
    select: list[str] | None = None,
    project_dir: Path = PROJECT_DIR,
    profiles_dir: Path = PROFILES_DIR,
    capture: bool = True,
    command: str = "build",
) -> BuildResult:
    """`dbt build` (or `run` for models only) with the run's vars; captures lineage unless `capture` is false."""
    args = [command]
    if select:
        args += ["--select", *select]
    ok, tp = invoke(args, db_path, Path(target_path).resolve(), project_dir, profiles_dir, dbt_vars)
    run_results = json.loads((tp / "run_results.json").read_text())
    manifest = json.loads((tp / "manifest.json").read_text())
    events = lineage_events(tp, project_dir) if capture else []
    return BuildResult(ok, tp, run_results, manifest, events)


def column_edges(events: list[dict[str, Any]]) -> list[tuple[str, str]]:
    """(input table.column, output table.column) pairs from the events' column-lineage facets, with dataset names
    reduced to `schema.table` (DuckDB dataset names embed the database file name)."""

    def short(name: str) -> str:
        return ".".join(name.split(".")[-2:])

    out: set[tuple[str, str]] = set()
    for e in events:
        for o in e.get("outputs", []):
            fields = ((o.get("facets") or {}).get("columnLineage") or {}).get("fields") or {}
            for col, spec in fields.items():
                for inp in spec.get("inputFields", []):
                    out.add((f"{short(inp['name'])}.{inp['field']}", f"{short(o['name'])}.{col}"))
    return sorted(out)


__all__ = ["BUILD_LOCK", "BuildResult", "build", "column_edges", "invoke", "lineage_events"]
