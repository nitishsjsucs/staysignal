"""`npm run prod:load` (SPEC 23.2 step 11, path B): the canonical world into production, plan first.

The steps mirror the local pipeline (`staysignal engine prepare`) so production holds what local holds:

1. `land`: every extract of the canonical world is validated and stored content-addressed, then copied to the R2
   bucket `staysignal-landing` under `landing/<source>/<period>/<sha256>.csv` (one `wrangler r2 object put` each).
2. `raw`: the same ingest as local into a scratch DuckDB, pseudonyms from the production `SS_HMAC_MASTER_KEY` (never
   the fixed test key), then each raw table to BigQuery (`raw` to `staysignal_raw`, `audit` to `staysignal_audit`)
   as Parquet load jobs that replace the table.
3. `dbt`: `dbt build` with the BigQuery production profile (application default credentials, 1 GiB
   `maximum_bytes_billed`, the `app=staysignal` label) at the canonical vintage.
4. `publish`: the published documents `staysignal demo build` exported (runs, forecasts, history, quality and the
   rest, keyed by the fixture paths the Worker reads) as rows of `staysignal_published.documents`, replaced.
5. `lab`: the Scenario Lab recordings, when they exist (M4; none yet, so the step is skipped).

By default nothing leaves the machine: the plan is printed. `--execute` is the operator's, on the Mac, after
`setup:prod --phase B`; it refuses without the project ID and the production pseudonym key.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from staysignal.ingest.schemas import kind_of

BUCKET = "staysignal-landing"
VINTAGE = "2026-10-01T06:00:00Z"
RUNNER_MAX_BYTES = 1 << 30
LABELS = {"app": "staysignal", "purpose": "load"}
DATASETS = {"raw": "staysignal_raw", "audit": "staysignal_audit"}
DOCUMENTS_TABLE = "staysignal_published.documents"


@dataclass
class Plan:
    objects: list[dict] = field(default_factory=list)  # R2 puts: key, file, sha256
    documents: list[str] = field(default_factory=list)  # published document keys
    rejected: list[str] = field(default_factory=list)  # files that are not a known extract
    lab: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "steps": ["land", "raw", "dbt", "publish", "lab"],
            "r2": {"bucket": BUCKET, "objects": len(self.objects), "bytes": sum(o["bytes"] for o in self.objects)},
            "raw": {"datasets": sorted(DATASETS.values()), "write": "WRITE_TRUNCATE", "format": "PARQUET"},
            "dbt": {"target": "prod", "vintage": VINTAGE, "maximum_bytes_billed": RUNNER_MAX_BYTES, "labels": LABELS},
            "publish": {"table": DOCUMENTS_TABLE, "documents": len(self.documents), "write": "WRITE_TRUNCATE"},
            "lab": {"recordings": len(self.lab), "skipped": not self.lab},
            "rejected": self.rejected,
        }


def source_files(world: Path) -> list[Path]:
    return sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))


def plan(world: Path, published: Path, lab_dir: Path | None = None) -> Plan:
    """The plan from the files alone: no landing copy, no database, no network."""
    p = Plan()
    for f in source_files(world):
        found = kind_of(f.name)
        if found is None:
            p.rejected.append(f.name)
            continue
        kind, period = found
        data = f.read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        p.objects.append(
            {"key": f"landing/{kind.source}/{period}/{sha}.csv", "file": f.name, "sha256": sha, "bytes": len(data)}
        )
    p.documents = sorted(str(x.relative_to(published)) for x in published.rglob("*.json"))
    if lab_dir is not None and lab_dir.exists():
        p.lab = sorted(str(x.relative_to(lab_dir)) for x in lab_dir.rglob("*.json*"))
    return p


def dataset_for(schema: str) -> str:
    if schema not in DATASETS:
        raise ValueError(f"no production dataset for local schema {schema}")
    return DATASETS[schema]


def document_rows(published: Path, keys: list[str]) -> list[dict]:
    """One row per document: the fixture path as the key and the JSON text as `doc` (what BigQueryWarehouse reads)."""
    rows = []
    for k in keys:
        doc = json.loads((published / k).read_text())
        rows.append({"key": k, "doc": json.dumps(doc, separators=(",", ":"), sort_keys=True)})
    return rows


def preflight(env: dict[str, str], project: str | None) -> list[str]:
    """Why --execute must not start: a missing or malformed project ID, or no production pseudonym key."""
    out = []
    if not project:
        out.append("no project ID: pass --project or set SS_GCP_PROJECT")
    elif not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        out.append("the project ID is malformed")
    if not env.get("SS_HMAC_MASTER_KEY"):
        out.append("SS_HMAC_MASTER_KEY is not set: production pseudonyms must not use the fixed test key")
    return out


def prod_profile(project: str) -> dict:
    """The dbt profile for the production BigQuery target (application default credentials; no key file)."""
    return {
        "staysignal": {
            "target": "prod",
            "outputs": {
                "prod": {
                    "type": "bigquery",
                    "method": "oauth",
                    "project": project,
                    "dataset": "staysignal",
                    "location": "US",
                    "threads": 4,
                    "maximum_bytes_billed": RUNNER_MAX_BYTES,
                    "labels": LABELS,
                    "job_execution_timeout_seconds": 600,
                }
            },
        }
    }


class Deps:
    """The side effects of --execute, injected so tests run them against fakes. `r2_put(key, path)`,
    `load_parquet(path, table)`, `load_documents(rows, table)` and `dbt_build(profiles_dir, vars) -> bool`."""

    def __init__(self, r2_put, load_parquet, load_documents, dbt_build, log=print) -> None:
        self.r2_put = r2_put
        self.load_parquet = load_parquet
        self.load_documents = load_documents
        self.dbt_build = dbt_build
        self.log = log


def execute(p: Plan, world: Path, published: Path, work: Path, project: str, deps: Deps) -> dict:
    """Runs the plan in order and stops at the first failure. `work` is a scratch directory on the runner."""
    from datetime import UTC, datetime

    import yaml

    from staysignal.duck import open_duckdb
    from staysignal.ingest import mappings
    from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys

    done: dict = {"r2": 0, "tables": [], "dbt": None, "documents": 0}
    files = {f.name: f for f in source_files(world)}
    for o in p.objects:
        deps.r2_put(o["key"], files[o["file"]])
        done["r2"] += 1
    deps.log(f"[prod:load] land: {done['r2']} objects in {BUCKET}")

    work.mkdir(parents=True, exist_ok=True)
    db = work / "load.duckdb"  # not raw.duckdb: the catalog name would shadow the raw schema
    db.unlink(missing_ok=True)
    con = open_duckdb(db)
    ingest(con, source_files(world), work / "landing", datetime(2023, 4, 1, 6, tzinfo=UTC))
    mappings.write_raw(con)
    refresh_employee_keys(con)  # engine_pseudonymizer: SS_HMAC_MASTER_KEY, checked by preflight
    tables = con.execute(
        "SELECT table_schema, table_name FROM information_schema.tables "
        "WHERE table_schema IN ('raw', 'audit') ORDER BY 1, 2"
    ).fetchall()
    for schema, table in tables:
        out = work / "parquet" / f"{schema}.{table}.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        con.execute(f"COPY {schema}.\"{table}\" TO '{out}' (FORMAT PARQUET)")
        target = f"{project}.{dataset_for(schema)}.{table}"
        deps.load_parquet(out, target)
        done["tables"].append(target)
    con.close()
    deps.log(f"[prod:load] raw: {len(done['tables'])} tables")

    profiles = work / "profiles"
    profiles.mkdir(parents=True, exist_ok=True)
    (profiles / "profiles.yml").write_text(yaml.safe_dump(prod_profile(project), sort_keys=True))
    ok = deps.dbt_build(profiles, {"vintage": VINTAGE, "pay_basis_mapping": "payroll@1"})
    done["dbt"] = bool(ok)
    if not ok:
        deps.log("[prod:load] dbt build failed; nothing was published")
        return {**done, "ok": False}

    rows = document_rows(published, p.documents)
    deps.load_documents(rows, f"{project}.{DOCUMENTS_TABLE}")
    done["documents"] = len(rows)
    deps.log(f"[prod:load] publish: {len(rows)} documents")
    return {**done, "ok": True}


__all__ = [
    "BUCKET",
    "DATASETS",
    "Deps",
    "execute",
    "DOCUMENTS_TABLE",
    "LABELS",
    "Plan",
    "dataset_for",
    "document_rows",
    "plan",
    "preflight",
    "prod_profile",
    "source_files",
]
