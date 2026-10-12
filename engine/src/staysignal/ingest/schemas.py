"""Source extract schemas (`sources/schemas/*.schema.json`) and the file kinds they validate (SPEC 7.1).

The schemas use a small subset of JSON Schema 2020-12 (required, enum, pattern, string formats `date` and
`date-time`), checked here without a schema library. An empty CSV cell is a missing value: allowed for optional
fields, an error for required ones. A file that fails validation is never appended to its raw table.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import cache

from staysignal.paths import REPO_ROOT

SCHEMA_DIR = REPO_ROOT / "sources" / "schemas"

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATE_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


@dataclass(frozen=True)
class FileKind:
    """A kind of landed extract: which raw table it appends to and which schema validates it."""

    source: str  # raw table is raw_<source>
    schema: str  # sources/schemas/<schema>.schema.json
    definition: str | None  # $defs entry, when one schema file covers several extracts
    pattern: re.Pattern[str]  # file name; group "period" names the landing period
    raw_schema: str = "raw"  # the audit attribute lands in the isolated `audit` schema (ADR 0013)


KINDS: tuple[FileKind, ...] = (
    FileKind("hris", "hris", None, re.compile(r"^hris_records\.csv$")),
    FileKind("hris", "hris", None, re.compile(r"^hris_delta_(?P<period>\d{4}-\d{2}-\d{2})\.csv$")),
    FileKind(
        "payroll", "payroll", None, re.compile(r"^payroll_(?P<entity>[A-Z]{2}-ENT)_(?P<period>\d{4}-\d{2})\.csv$")
    ),
    FileKind("ats_requisitions", "ats", "requisitions", re.compile(r"^ats_requisitions\.csv$")),
    FileKind("ats_offers", "ats", "offers", re.compile(r"^ats_offers\.csv$")),
    FileKind("org_teams", "org", "teams", re.compile(r"^org_teams\.csv$")),
    FileKind("org_events", "org", "events", re.compile(r"^org_events\.csv$")),
    FileKind("ref_bands", "org", "bands", re.compile(r"^ref_bands\.csv$")),
    FileKind("audit_attributes", "audit", None, re.compile(r"^audit_attributes\.csv$"), raw_schema="audit"),
)


def kind_of(name: str) -> tuple[FileKind, str] | None:
    """The file kind and landing period for an extract name (`base` for full extracts without a period)."""
    for k in KINDS:
        m = k.pattern.match(name)
        if m:
            return k, m.groupdict().get("period") or "base"
    return None


@cache
def schema_for(kind: FileKind) -> dict:
    doc = json.loads((SCHEMA_DIR / f"{kind.schema}.schema.json").read_text())
    return doc["$defs"][kind.definition] if kind.definition else doc


def columns(kind: FileKind) -> list[str]:
    return list(schema_for(kind)["properties"])


def validate_rows(kind: FileKind, header: list[str], rows: list[dict[str, str]], limit: int = 20) -> list[str]:
    """Problems with an extract against its schema; empty when it conforms."""
    schema = schema_for(kind)
    props: dict[str, dict] = schema["properties"]
    required = set(schema.get("required", []))
    problems: list[str] = []
    missing = [c for c in props if c not in header and c in required]
    extra = [c for c in header if c not in props]
    if missing:
        problems.append(f"missing columns: {', '.join(missing)}")
    if extra:
        problems.append(f"unexpected columns: {', '.join(extra)}")
    if problems:
        return problems
    patterns = {c: re.compile(p["pattern"]) for c, p in props.items() if "pattern" in p}
    for i, row in enumerate(rows, start=2):  # line 1 is the header
        for col, spec in props.items():
            v = row.get(col, "")
            if v == "":
                if col in required:
                    problems.append(f"line {i}: {col} is required")
                continue
            if "enum" in spec and v not in spec["enum"]:
                problems.append(f"line {i}: {col}={v!r} is not one of {spec['enum']}")
            elif col in patterns and not patterns[col].match(v):
                problems.append(f"line {i}: {col}={v!r} does not match {spec['pattern']}")
            elif spec.get("format") == "date" and not DATE.match(v):
                problems.append(f"line {i}: {col}={v!r} is not a date")
            elif spec.get("format") == "date-time" and not DATE_TIME.match(v):
                problems.append(f"line {i}: {col}={v!r} is not a UTC timestamp")
        if len(problems) >= limit:
            break
    return problems


def pay_basis_dictionary() -> dict[str, dict]:
    """The vendor's pay-basis code dictionary (`x-pay-basis-codes` in payroll.schema.json)."""
    return json.loads((SCHEMA_DIR / "payroll.schema.json").read_text())["x-pay-basis-codes"]


__all__ = ["KINDS", "FileKind", "columns", "kind_of", "pay_basis_dictionary", "schema_for", "validate_rows"]
