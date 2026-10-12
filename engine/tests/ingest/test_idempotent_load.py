"""Loads are idempotent by file hash; every delivery is recorded; landed files are content-addressed and read-only."""

import shutil

from staysignal.ingest.load_duckdb import ingest

from .conftest import MIGRATION, world_paths


def counts(con):
    return {
        t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        for t in ("raw.raw_hris", "raw.raw_payroll", "raw.raw_org_teams", "audit.raw_audit_attributes")
    }


def test_reloading_the_same_files_appends_nothing(loaded, small):
    con, first, tmp = loaded
    before = counts(con)
    again = ingest(con, world_paths(small), tmp / "landing", MIGRATION)
    assert not any(o["loaded"] for o in again)
    assert counts(con) == before
    assert before["raw.raw_hris"] > 0 and before["raw.raw_payroll"] > 0


def test_redelivery_under_another_name_is_a_new_delivery_but_not_new_rows(loaded, small, tmp_path):
    con, _, tmp = loaded
    src = sorted((small / "sources").glob("hris_delta_*.csv"))[-1]
    later = tmp_path / "redelivered"
    later.mkdir()
    copy = later / "hris_delta_2099-01-01.csv"
    shutil.copy(src, copy)
    before = counts(con)
    out = ingest(con, [copy], tmp / "landing", MIGRATION)
    assert out[0]["loaded"] is False
    assert counts(con) == before
    names = {r[0] for r in con.execute("SELECT file_name FROM raw._deliveries").fetchall()}
    assert "hris_delta_2099-01-01.csv" in names


def test_landed_files_are_content_addressed_and_read_only(loaded):
    con, out, tmp = loaded
    for o in out[:5]:
        path = tmp / "landing" / o["source"] / o["period"] / f"{o['sha256']}.csv"
        assert path.exists()
        assert not path.stat().st_mode & 0o222


def test_audit_attribute_lands_only_in_the_audit_schema(loaded):
    con, _, _ = loaded
    raw_tables = {
        r[0]
        for r in con.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'raw'").fetchall()
    }
    assert not any("audit" in t for t in raw_tables)
    assert con.execute("SELECT count(*) FROM audit.raw_audit_attributes").fetchone()[0] > 0
