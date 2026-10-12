"""Conformed snapshots (SPEC 7.1, 17.4): `staysignal snapshot conformed --as-of <vintage>`.

A snapshot is the typed, deduplicated, pseudonymized form of every raw record known at the vintage, with source codes
intact (mappings are applied downstream, so a snapshot replays under any mapping version). It is written as Parquet
under `var/conformed/<snapshot_id>/` with a manifest; the snapshot ID is the SHA-256 of the canonical manifest of
per-table content hashes, so the same records always give the same ID whatever the file bytes. A snapshot is the unit
that lets retention delete raw files without breaking replay.

Employee numbers become `er_` keys (HMAC with per-kind HKDF keys, `privacy/pseudo.py`); the audit-only attribute is
never part of a snapshot (ADR 0013).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from pathlib import Path

import duckdb

from staysignal.canonical import canonical_json
from staysignal.ingest.load_duckdb import ensure_raw, refresh_employee_keys
from staysignal.privacy.pseudo import Pseudonymizer, engine_pseudonymizer

# table: (raw table, typed select list with {er} for the pseudonymized key, knowledge-time column or None, order by)
TABLES: dict[str, tuple[str, str, str | None, str]] = {
    "hris_records": (
        "raw.raw_hris",
        "record_id, {er}(employee_number) AS employee_key, record_type, CAST(effective_date AS DATE) AS effective_date, "
        "CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at, job_code, level, team_id, "
        "{er}(manager_employee_number) AS manager_key, location_code, employment_type, "
        "CAST(contract_end_date AS DATE) AS contract_end_date, termination_reason_code, corrects_record_id, "
        "source_batch_id, CAST(legacy_hire_date AS DATE) AS legacy_hire_date, "
        "CAST(legacy_first_promotion_date AS DATE) AS legacy_first_promotion_date, "
        "CAST(legacy_last_promotion_date AS DATE) AS legacy_last_promotion_date",
        "recorded_at",
        "record_id",
    ),
    "payroll_lines": (
        "raw.raw_payroll",
        "entity_code, {er}(employee_number) AS employee_key, pay_period, "
        "CAST(round(CAST(base_amount AS DECIMAL(18, 2)) * 100) AS BIGINT) AS base_amount_cents, currency, "
        "pay_basis_code, vendor_file_id, CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at",
        "recorded_at",
        "entity_code, employee_key, pay_period, vendor_file_id",
    ),
    "ats_requisitions": (
        "raw.raw_ats_requisitions",
        "requisition_id, team_id, job_code, req_type, status, CAST(event_date AS DATE) AS event_date, "
        "CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at",
        "recorded_at",
        "requisition_id, event_date, status",
    ),
    "ats_offers": (
        "raw.raw_ats_offers",
        "offer_id, requisition_id, CAST(extended_date AS DATE) AS extended_date, decision, "
        "CAST(decision_date AS DATE) AS decision_date, CAST(start_date AS DATE) AS start_date, "
        "CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at",
        "recorded_at",
        "offer_id",
    ),
    "org_teams": (
        "raw.raw_org_teams",
        "team_id, team_name, group_id, group_name, org_id, org_name, CAST(valid_from AS DATE) AS valid_from, "
        "CAST(valid_to AS DATE) AS valid_to, CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at",
        "recorded_at",
        "team_id, valid_from",
    ),
    "org_events": (
        "raw.raw_org_events",
        "event_id, CAST(effective_date AS DATE) AS effective_date, kind, team_id, "
        "CAST(recorded_at AS TIMESTAMPTZ) AS recorded_at",
        "recorded_at",
        "event_id",
    ),
    "ref_bands": (
        "raw.raw_ref_bands",
        "job_family, level, location_code, currency, CAST(band_min AS DECIMAL(18, 2)) AS band_min, "
        "CAST(band_mid AS DECIMAL(18, 2)) AS band_mid, CAST(band_max AS DECIMAL(18, 2)) AS band_max",
        None,
        "job_family, level, location_code",
    ),
}


def _register_keys(con: duckdb.DuckDBPyConnection, pseudo: Pseudonymizer) -> None:
    """Refreshes `raw._employee_keys` and defines a temporary lookup macro over it."""
    refresh_employee_keys(con, pseudo)
    con.execute("CREATE OR REPLACE TEMP MACRO _er(x) AS (SELECT er FROM raw._employee_keys WHERE employee_number = x)")


# HRIS duplicates re-send the same content under a new record ID and batch: staging keeps the first one recorded
HRIS_CONTENT = (
    "employee_number, record_type, effective_date, job_code, level, team_id, manager_employee_number, location_code, "
    "employment_type, contract_end_date, termination_reason_code, corrects_record_id, legacy_hire_date, "
    "legacy_first_promotion_date, legacy_last_promotion_date"
)


def _ts(as_of: datetime) -> str:
    return f"TIMESTAMPTZ '{as_of.strftime('%Y-%m-%d %H:%M:%S')}+00'"


def _query(table: str, as_of: datetime) -> tuple[str, list]:
    raw, select, knowledge, order = TABLES[table]
    cols = select.format(er="_er")
    where = f"WHERE CAST({knowledge} AS TIMESTAMPTZ) <= {_ts(as_of)}" if knowledge else ""
    if table == "hris_records":
        src = (
            f"(SELECT * FROM {raw} {where} QUALIFY row_number() OVER "
            f"(PARTITION BY {HRIS_CONTENT} ORDER BY CAST(recorded_at AS TIMESTAMPTZ), record_id) = 1)"
        )
        return f"SELECT {cols} FROM {src} ORDER BY {order}", []
    # other extracts are full or append-only files: identical rows re-sent in a later file count once
    return f"SELECT DISTINCT {cols} FROM {raw} {where} ORDER BY {order}", []


def content_sha256(con: duckdb.DuckDBPyConnection, sql: str, params: list) -> tuple[str, int]:
    h = hashlib.sha256()
    n = 0
    cur = con.execute(sql, params)
    while True:
        batch = cur.fetchmany(5000)
        if not batch:
            break
        for row in batch:
            h.update(canonical_json([None if v is None else str(v) for v in row]).encode())
            h.update(b"\n")
            n += 1
    return h.hexdigest(), n


def snapshot(con: duckdb.DuckDBPyConnection, as_of: datetime, root: Path, pseudo: Pseudonymizer | None = None) -> dict:
    """Writes (or finds) the conformed snapshot at `as_of`; returns its manifest."""
    ensure_raw(con)
    _register_keys(con, pseudo or engine_pseudonymizer())
    tables: dict[str, dict] = {}
    queries: dict[str, tuple[str, list]] = {}
    for name in TABLES:
        sql, params = _query(name, as_of)
        sha, rows = content_sha256(con, sql, params)
        tables[name] = {"rows": rows, "content_sha256": sha}
        queries[name] = (sql, params)
    body = {"as_of": as_of.strftime("%Y-%m-%dT%H:%M:%SZ"), "format": "conformed@1", "tables": tables}
    sid = hashlib.sha256(canonical_json(body).encode()).hexdigest()
    manifest = {"snapshot_id": sid, "label": "synthetic", **body}
    out = root / sid
    if (out / "manifest.json").exists():
        return json.loads((out / "manifest.json").read_text())
    tmp = root / f".{sid}.tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    for name, (sql, params) in queries.items():
        target = tmp / f"{name}.parquet"
        con.execute(f"COPY ({sql}) TO '{target.as_posix()}' (FORMAT parquet)", params or None)
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    tmp.replace(out)
    return manifest


__all__ = ["TABLES", "content_sha256", "snapshot"]
