"""`npm run prod:validate` (SPEC 23.2 step 11, 21): BigQuery validity of every compiled model and test, by free dry runs.

The offline compile (`prod/dialect.py`, no credentials) renders every model and test in the BigQuery dialect; this
module turns each compiled file into a dry-run query job: `dryRun` true, the query cache off, `maximumBytesBilled` at
the runner's cap and the `app=staysignal` label (SPEC 17.2). A dry run is free and runs nothing. By default the plan
is only printed; `--execute` (the operator, on the Mac, with application default credentials) sends the dry runs.

A dry run resolves every table it reads, so before `prod:load` a model whose inputs do not exist yet reports
"Not found". Such a result is `needs_upstream`, not a failure: the dialect and the SQL were accepted as far as BigQuery
could check them. After `prod:load`, rerun with `--execute --strict` and every file must pass. Any other error, a
referenced dataset outside `staysignal_*`, or bytes above the cap fails the validation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

PLACEHOLDER_PROJECT = "staysignal-project-id"  # the offline compile profile's project (profiles/bigquery_compile)
RUNNER_MAX_BYTES = 1 << 30  # 1 GiB per runner job (SPEC 17.2)
LABELS = {"app": "staysignal", "purpose": "validate"}
DATASET_RE = re.compile(r"`([a-z0-9-]+)`\.`([A-Za-z0-9_]+)`")


@dataclass(frozen=True)
class DryRun:
    name: str  # the compiled file, relative to the compiled project directory
    kind: str  # model or test
    sql: str
    datasets: tuple[str, ...]


def plan(compiled_dir: Path) -> list[DryRun]:
    """One dry run per compiled file, in a stable order. The SQL keeps the placeholder project until `bind`."""
    out = []
    for path in sorted(compiled_dir.rglob("*.sql")):
        rel = str(path.relative_to(compiled_dir))
        sql = path.read_text()
        datasets = tuple(sorted({d for _, d in DATASET_RE.findall(sql)}))
        out.append(DryRun(rel, "test" if rel.startswith("tests/") or "/_" in rel else "model", sql, datasets))
    return out


def problems(runs: list[DryRun]) -> list[str]:
    """Plan-level findings that need no BigQuery: a dataset outside the repo's prefix, or another project."""
    found = []
    for r in runs:
        for d in r.datasets:
            if not d.startswith("staysignal_"):
                found.append(f"{r.name}: dataset {d} is not a staysignal_ dataset")
        for p, _ in DATASET_RE.findall(r.sql):
            if p != PLACEHOLDER_PROJECT:
                found.append(f"{r.name}: project {p} is not the compile placeholder")
    return found


def bind(sql: str, project: str) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise ValueError("not a Google Cloud project ID")
    return sql.replace(f"`{PLACEHOLDER_PROJECT}`", f"`{project}`")


class QueryClient(Protocol):  # the slice of google.cloud.bigquery.Client this module uses
    def query(self, sql: str, job_config: object) -> object: ...


def execute(runs: list[DryRun], client: QueryClient, project: str, job_config_factory) -> list[dict]:
    """Sends each dry run; returns one result per file: passed, needs_upstream or failed, with bytes processed."""
    results = []
    for r in runs:
        cfg = job_config_factory(
            dry_run=True, use_query_cache=False, maximum_bytes_billed=RUNNER_MAX_BYTES, labels=LABELS
        )
        try:
            job = client.query(bind(r.sql, project), job_config=cfg)
            processed = int(getattr(job, "total_bytes_processed", 0) or 0)
            status = "failed" if processed > RUNNER_MAX_BYTES else "passed"
            results.append({"name": r.name, "status": status, "bytes_processed": processed, "error": None})
        except Exception as e:  # BigQuery reports invalid SQL as an exception on the dry run
            msg = str(e).splitlines()[0][:300]
            status = "needs_upstream" if re.search(r"Not found: (Table|Dataset)", msg) else "failed"
            results.append({"name": r.name, "status": status, "bytes_processed": None, "error": msg})
    return results


def summarize(runs: list[DryRun], results: list[dict] | None, strict: bool = False) -> dict:
    found = problems(runs)
    doc: dict = {
        "files": len(runs),
        "models": sum(1 for r in runs if r.kind == "model"),
        "tests": sum(1 for r in runs if r.kind == "test"),
        "datasets": sorted({d for r in runs for d in r.datasets}),
        "max_bytes_billed": RUNNER_MAX_BYTES,
        "labels": LABELS,
        "problems": found,
        "executed": results is not None,
    }
    if results is None:
        doc["ok"] = not found
        return doc
    counts = {s: sum(1 for x in results if x["status"] == s) for s in ("passed", "needs_upstream", "failed")}
    doc["counts"] = counts
    doc["failed"] = [x for x in results if x["status"] == "failed"]
    doc["needs_upstream"] = [x["name"] for x in results if x["status"] == "needs_upstream"]
    doc["ok"] = not found and counts["failed"] == 0 and (not strict or counts["needs_upstream"] == 0)
    return doc


__all__ = [
    "LABELS",
    "PLACEHOLDER_PROJECT",
    "RUNNER_MAX_BYTES",
    "DryRun",
    "bind",
    "execute",
    "plan",
    "problems",
    "summarize",
]
