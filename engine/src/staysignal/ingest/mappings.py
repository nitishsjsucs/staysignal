"""Versioned, hashed source mappings (`sources/mappings/<source>.v<n>.yaml`, SPEC 7.1, 13.4).

Mappings are applied downstream of staging, so raw and conformed data keep their source codes and replay under any
mapping version. Every version is compiled into `raw.map_pay_basis` (one row per version and code, plus the version's
rule for unknown codes); the dbt model `stg_map__pay_basis` selects the active version, which is a run parameter
recorded in every run manifest. A mapping's identity is the SHA-256 of its canonical JSON.
"""

from __future__ import annotations

import hashlib
import re
from functools import cache

import duckdb
import yaml

from staysignal.canonical import canonical_json
from staysignal.paths import MAPPINGS

FILE = re.compile(r"^(?P<source>[a-z_]+)\.v(?P<version>\d+)\.yaml$")
UNKNOWN_MULTIPLIER = {"monthly": 12, "reject": None}


@cache
def versions(source: str = "payroll") -> dict[int, dict]:
    out: dict[int, dict] = {}
    for p in sorted(MAPPINGS.glob(f"{source}.v*.yaml")):
        m = FILE.match(p.name)
        if m:
            out[int(m["version"])] = yaml.safe_load(p.read_text(encoding="utf-8"))
    return out


def label(source: str, version: int) -> str:
    return f"{source}@{version}"


def mapping_sha256(mapping: dict) -> str:
    return hashlib.sha256(canonical_json(mapping).encode()).hexdigest()


def pay_basis_rows() -> list[tuple]:
    """(mapping_version, code, annual_multiplier, meaning, unknown_codes, mapping_sha256); code `*` is the unknown
    rule, with a null multiplier when unknown codes are rejected."""
    rows: list[tuple] = []
    for v, m in versions("payroll").items():
        sha = mapping_sha256(m)
        lab = label("payroll", v)
        for code, spec in sorted(m["codes"].items()):
            rows.append((lab, code, int(spec["multiplier"]), spec["meaning"], m["unknown_codes"], sha))
        rows.append(
            (
                lab,
                "*",
                UNKNOWN_MULTIPLIER[m["unknown_codes"]],
                f"unknown codes: {m['unknown_codes']}",
                m["unknown_codes"],
                sha,
            )
        )
    return rows


def write_raw(con: duckdb.DuckDBPyConnection) -> int:
    con.execute("CREATE SCHEMA IF NOT EXISTS raw")
    con.execute(
        "CREATE OR REPLACE TABLE raw.map_pay_basis (mapping_version VARCHAR NOT NULL, code VARCHAR NOT NULL, "
        "annual_multiplier INTEGER, meaning VARCHAR NOT NULL, unknown_codes VARCHAR NOT NULL, "
        "mapping_sha256 VARCHAR NOT NULL, PRIMARY KEY (mapping_version, code))"
    )
    rows = pay_basis_rows()
    con.executemany("INSERT INTO raw.map_pay_basis VALUES (?, ?, ?, ?, ?, ?)", rows)
    return len(rows)


def annual_multiplier(mapping: dict, code: str) -> int | None:
    """The Python form of the same rule (the reference features use it): None means the line is rejected."""
    if code in mapping["codes"]:
        return int(mapping["codes"][code]["multiplier"])
    return UNKNOWN_MULTIPLIER[mapping["unknown_codes"]]


__all__ = ["annual_multiplier", "label", "mapping_sha256", "pay_basis_rows", "versions", "write_raw"]
