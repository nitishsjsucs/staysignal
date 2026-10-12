"""A canonical-world warehouse built once per session: land and load every extract, then build dbt in process."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from staysignal.duck import open_duckdb
from staysignal.ingest import mappings
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys
from staysignal.lineage.capture import build

MIGRATION = datetime(2023, 4, 1, 6, tzinfo=UTC)
VINTAGE = "2026-10-01T06:00:00Z"


def world_paths(world: Path, held: bool = False) -> list[Path]:
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    if held:
        paths += sorted((world / "held").glob("*.csv"))
    return paths


@pytest.fixture(scope="session")
def warehouse(canonical, tmp_path_factory):
    root = tmp_path_factory.mktemp("warehouse")
    db = root / "warehouse.duckdb"
    con = open_duckdb(db)
    ingest(con, world_paths(canonical), root / "landing", MIGRATION)
    mappings.write_raw(con)
    refresh_employee_keys(con)
    from staysignal.forecast.published_tables import ensure

    ensure(con)
    yield con, db, root
    con.close()


@pytest.fixture(scope="session")
def built(warehouse):
    con, db, root = warehouse
    res = build(db, root / "target", {"vintage": VINTAGE, "pay_basis_mapping": "payroll@1"})
    return con, db, root, res
