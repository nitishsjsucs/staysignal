"""Catalog fixtures (SPEC 7.3, 21): the results of the semantic-catalog requests the tools make by default, exported
from a fresh canonical warehouse so the fixtures mode (CI, e2e, the fixtures deployment) answers them without a
warehouse. Each file is named by 16 hex characters of SHA-256 over the canonical JSON of {key, request}, exactly as
`src/worker/warehouse/fixtures.ts` names them; any other request is unavailable in fixtures mode.

Requests: the 12 months before the published run's cutoff (2025-10 to 2026-09), every cohort level, unscoped and
scoped to each local People Partner's organizations (the company level is never scoped: People Partners cannot read
it). `engine/tests/warehouse/test_catalog_parity.py` checks that every committed file equals a fresh execution.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from staysignal.canonical import canonical_json
from staysignal.duck import open_duckdb
from staysignal.paths import REPO_ROOT
from staysignal.semantic import params as P
from staysignal.service import warehouse_shim as shim

VINTAGE = "2026-10-01T06:00:00Z"
WINDOW = ("2025-10", "2026-09")
OUT = REPO_ROOT / "test" / "fixtures" / "api" / "catalog"


def fixture_id(key: str, request: dict) -> str:
    return hashlib.sha256(canonical_json({"key": key, "request": request}).encode("utf-8")).hexdigest()[:16]


def scopes() -> list[list[str] | None]:
    principals = json.loads((REPO_ROOT / "policy" / "principals.local.json").read_text())["principals"]
    scoped = sorted({tuple(sorted(p["assigned_orgs"])) for p in principals if p.get("assigned_orgs")})
    return [None, *[list(s) for s in scoped]]


def requests() -> list[tuple[str, dict]]:
    out = []
    for level in P.LEVELS:
        for scope in scopes():
            if level == "company" and scope is not None:
                continue
            request = {"start_month": WINDOW[0], "end_month": WINDOW[1]}
            if scope is not None:
                request["scope"] = scope
            out.append((P.catalog_key("workforce_flows", level, "none"), request))
    return out


def build_warehouse(world: Path, root: Path):
    """A fresh canonical warehouse at the published run's vintage (payroll@1), as the tests build it."""
    from staysignal.forecast.published_tables import ensure
    from staysignal.ingest import mappings
    from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
    from staysignal.lineage.capture import build

    db = root / "warehouse.duckdb"
    con = open_duckdb(db)
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    ingest(con, paths, root / "landing", datetime(2023, 4, 1, 6, tzinfo=UTC))
    mappings.write_raw(con)
    refresh_employee_keys(con)
    ensure(con)
    res = build(db, root / "target", {"vintage": VINTAGE, "pay_basis_mapping": "payroll@1"}, capture=False)
    if not res.success:
        raise RuntimeError("dbt build failed while exporting catalog fixtures")
    return con


def execute(con, key: str, request: dict) -> dict:
    res = shim.run_entry(con, key, shim.bind(request))
    return {"key": key, "request": request, **res.as_json()}


def export(world: Path, out_dir: Path = OUT) -> list[Path]:
    with tempfile.TemporaryDirectory() as tmp:
        con = build_warehouse(world, Path(tmp))
        try:
            docs = [(fixture_id(k, r), execute(con, k, r)) for k, r in requests()]
        finally:
            con.close()
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()
    paths = []
    for fid, doc in docs:
        p = out_dir / f"{fid}.json"
        p.write_text(json.dumps(doc, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
        paths.append(p)
    return paths


__all__ = ["OUT", "WINDOW", "execute", "export", "fixture_id", "requests"]
