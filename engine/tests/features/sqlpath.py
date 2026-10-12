"""The SQL path for micro-worlds: a micro-world's `Sources` are written straight into the raw tables of a fresh DuckDB
file (micro-worlds use short IDs that the extract schemas would reject, so landing is bypassed), the dbt models are run
at the vintage and mapping, and `pit.sql` computes the features. Keys are mapped back to employee numbers so the
named tests read the same rows from both implementations."""

from __future__ import annotations

import tempfile
from datetime import date, datetime
from pathlib import Path

from staysignal.duck import open_duckdb
from staysignal.features.pit import features_sql
from staysignal.features.reference import FeatureRow
from staysignal.ingest import mappings
from staysignal.ingest.landing import Sources
from staysignal.ingest.load_duckdb import ensure_raw, refresh_employee_keys
from staysignal.lineage.capture import build

META = ("micro", "micro", "micro", datetime(2020, 1, 1))


def _s(v) -> str | None:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%dT%H:%M:%SZ")
    return v.isoformat() if isinstance(v, date) else str(v)


def write_raw(con, src: Sources) -> None:
    ensure_raw(con)
    con.executemany(
        "INSERT INTO raw.raw_hris VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                r.record_id,
                r.employee_number,
                r.record_type,
                _s(r.effective_date),
                _s(r.recorded_at),
                r.job_code,
                r.level,
                r.team_id,
                r.manager,
                r.location,
                r.employment_type,
                _s(r.contract_end),
                r.reason,
                r.corrects,
                r.batch,
                _s(r.legacy_hire),
                _s(r.legacy_first_promo),
                _s(r.legacy_last_promo),
                *META,
            )
            for r in src.hris
        ],
    )
    if src.payroll:
        con.executemany(
            "INSERT INTO raw.raw_payroll VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                (
                    p.entity,
                    p.employee_number,
                    p.period,
                    f"{p.base_amount_cents // 100}.{p.base_amount_cents % 100:02d}",
                    p.currency,
                    p.pay_basis_code,
                    p.vendor_file_id,
                    _s(p.recorded_at),
                    *META,
                )
                for p in src.payroll
            ],
        )
    con.executemany(
        "INSERT INTO raw.raw_org_teams VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                t.team_id,
                t.team_name,
                t.group_id,
                t.group_name,
                t.org_id,
                t.org_name,
                _s(t.valid_from),
                _s(t.valid_to),
                _s(t.recorded_at),
                *META,
            )
            for t in src.teams
        ],
    )
    if src.org_events:
        con.executemany(
            "INSERT INTO raw.raw_org_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(e.event_id, _s(e.effective_date), e.kind, e.team_id, _s(e.recorded_at), *META) for e in src.org_events],
        )
    con.executemany(
        "INSERT INTO raw.raw_ref_bands VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                b.job_family,
                b.level,
                b.location,
                b.currency,
                f"{b.band_min:.2f}",
                f"{b.band_mid:.2f}",
                f"{b.band_max:.2f}",
                *META,
            )
            for b in src.bands.values()
        ],
    )
    mappings.write_raw(con)
    refresh_employee_keys(con)


def sql_rows(src: Sources, c: date, v: datetime, mapping: str, metric_def: str, clock: date | None) -> list[FeatureRow]:
    with tempfile.TemporaryDirectory(prefix="ss-micro-") as tmp:
        db = Path(tmp) / "micro.duckdb"
        con = open_duckdb(db)
        try:
            write_raw(con, src)
            res = build(
                db,
                Path(tmp) / "target",
                {"vintage": v.strftime("%Y-%m-%dT%H:%M:%SZ"), "pay_basis_mapping": mapping},
                capture=False,
                command="run",
            )
            assert res.success, "dbt run failed on a micro-world"
            back = {er: en for en, er in con.execute("SELECT employee_number, er FROM raw._employee_keys").fetchall()}
            rows = features_sql(con, c, metric_def, clock)
        finally:
            con.close()
    out = [FeatureRow(**{**r.__dict__, "employee_number": back[r.employee_number]}) for r in rows]
    return sorted(out, key=lambda r: r.employee_number)
