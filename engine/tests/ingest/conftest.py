from datetime import UTC, datetime
from pathlib import Path

import pytest

from staysignal.duck import open_duckdb
from staysignal.ingest import mappings
from staysignal.ingest.load_duckdb import ingest, refresh_employee_keys

MIGRATION = datetime(2023, 4, 1, 6, tzinfo=UTC)


def world_paths(world: Path, held: bool = False) -> list[Path]:
    paths = sorted((world / "sources").glob("*.csv")) + sorted((world / "audit").glob("*.csv"))
    if held:
        paths += sorted((world / "held").glob("*.csv"))
    return paths


@pytest.fixture
def loaded(small, tmp_path):
    con = open_duckdb(tmp_path / "w.duckdb")
    out = ingest(con, world_paths(small), tmp_path / "landing", MIGRATION)
    mappings.write_raw(con)
    refresh_employee_keys(con)
    yield con, out, tmp_path
    con.close()
