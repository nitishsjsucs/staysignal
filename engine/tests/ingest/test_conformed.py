"""Conformed snapshots: deterministic, pseudonymized, filtered to the vintage, deduplicated, source codes intact."""

import re
from datetime import UTC, datetime

import duckdb

from staysignal.ingest.conformed import snapshot


def test_snapshot_is_content_addressed_and_repeatable(loaded):
    con, _, tmp = loaded
    as_of = datetime(2026, 1, 1, 6, tzinfo=UTC)
    a = snapshot(con, as_of, tmp / "conformed")
    b = snapshot(con, as_of, tmp / "conformed")
    assert a["snapshot_id"] == b["snapshot_id"]
    later = snapshot(con, datetime(2026, 4, 1, 6, tzinfo=UTC), tmp / "conformed")
    assert later["snapshot_id"] != a["snapshot_id"]
    assert later["tables"]["hris_records"]["rows"] >= a["tables"]["hris_records"]["rows"]


def test_snapshot_never_holds_an_employee_number_or_the_audit_attribute(loaded):
    con, _, tmp = loaded
    m = snapshot(con, datetime(2026, 1, 1, 6, tzinfo=UTC), tmp / "conformed")
    folder = tmp / "conformed" / m["snapshot_id"]
    assert not (folder / "audit_attributes.parquet").exists()
    q = duckdb.connect()
    for name in ("hris_records", "payroll_lines"):
        rows = q.execute(f"SELECT * FROM read_parquet('{(folder / (name + '.parquet')).as_posix()}')").fetchall()
        text = repr(rows)
        assert not re.search(r"\bE\d{6}\b", text)
        assert re.search(r"er_[a-z2-7]{26}", text)


def test_snapshot_respects_the_vintage_and_removes_content_duplicates(loaded):
    con, _, tmp = loaded
    as_of = datetime(2026, 1, 1, 6, tzinfo=UTC)
    m = snapshot(con, as_of, tmp / "conformed")
    q = duckdb.connect()
    path = (tmp / "conformed" / m["snapshot_id"] / "hris_records.parquet").as_posix()
    assert q.execute(f"SELECT max(recorded_at) FROM read_parquet('{path}')").fetchone()[0] <= as_of
    dupes = q.execute(
        f"SELECT count(*) - count(DISTINCT (employee_key, record_type, effective_date, job_code, level, team_id, "
        f"manager_key, location_code, employment_type, contract_end_date, termination_reason_code, corrects_record_id)) "
        f"FROM read_parquet('{path}')"
    ).fetchone()[0]
    assert dupes == 0


def test_pay_basis_codes_are_kept_as_delivered(loaded):
    con, _, tmp = loaded
    m = snapshot(con, datetime(2026, 1, 1, 6, tzinfo=UTC), tmp / "conformed")
    path = (tmp / "conformed" / m["snapshot_id"] / "payroll_lines.parquet").as_posix()
    codes = {
        r[0] for r in duckdb.connect().execute(f"SELECT DISTINCT pay_basis_code FROM read_parquet('{path}')").fetchall()
    }
    assert codes == {"M"}
