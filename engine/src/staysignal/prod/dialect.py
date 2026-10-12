"""BigQuery dialect checks that need no credentials (SPEC 21, 23): the offline BigQuery compile of every model and
test, a scan of the compiled SQL for constructs BigQuery rejects, and a sqlglot parse in the BigQuery dialect.

`dbt parse` and sqlglot both accept some SQL that BigQuery rejects, so passing these checks does not prove BigQuery
validity; `npm run prod:validate` (free dry runs against the real project) does that in production. The banned list
and the scan are copied from DataTrust `pipelines/datatrust/dbt/dialect_check.py` (MIT), adapted for StaySignal.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from staysignal.lineage.capture import PROJECT_DIR, invoke

COMPILE_PROFILES = PROJECT_DIR / "profiles" / "bigquery_compile"

BANNED_IN_BIGQUERY: list[tuple[str, str]] = [
    (r"::", "postgres-style cast"),
    (r"\bmedian\s*\(", "median() is DuckDB-only"),
    (r"\blist\s*\(", "list() is DuckDB-only"),
    (r"\brange\s*\(", "range() is DuckDB-only"),
    (r"\bgenerate_series\s*\(", "generate_series() is DuckDB-only"),
    (r"\btimezone\s*\(", "timezone() is DuckDB-only"),
    (r"\bto_months\s*\(", "to_months() is DuckDB-only"),
    (r"//", "integer division operator"),
    (r"\bdecimal\s*\(", "decimal(p,s) type"),
    (r"\btimestamptz\b", "timestamptz type"),
    (r"\bvarchar\b", "varchar type"),
    (r"\bdouble\b", "double type"),
    (r"\bbigint\b", "bigint type"),
    (r"\bexclude\s*\(", "select * exclude"),
    (r"\bconcat_ws\s*\(", "concat_ws() is DuckDB-only"),
    (r"\bcount\s*\(\s*\*\s*\)\s*filter\s*\(", "aggregate filter clause"),
    (r"\bgroup\s+by\s+all\b", "group by all"),
    (r"date_diff\s*\(\s*'", "DuckDB date_diff argument order"),
    (r"date_trunc\s*\(\s*'", "DuckDB date_trunc argument order"),
    (r"percentile_(cont|disc)\s*\([^)]*\)\s*over\s*\([^)]*(order\s+by|rows|range)", "percentile window frame"),
]


def banned_hits(sql: str) -> list[str]:
    return [why for pattern, why in BANNED_IN_BIGQUERY if re.search(pattern, sql, re.I | re.M)]


def strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", re.sub(r"/\*.*?\*/", "", sql, flags=re.S))


def strip_jinja(sql: str) -> str:
    """Source SQL without jinja comments, expressions and statements (what remains is portable by contract)."""
    sql = re.sub(r"\{#.*?#\}", "", sql, flags=re.S)
    sql = re.sub(r"\{\{.*?\}\}", "", sql, flags=re.S)
    sql = re.sub(r"\{%.*?%\}", "", sql, flags=re.S)
    return strip_comments(sql)


def scan_compiled(compiled_dir: Path) -> dict[str, list[str]]:
    """Banned constructs per compiled SQL file (comments ignored)."""
    out = {}
    for path in sorted(compiled_dir.rglob("*.sql")):
        hits = banned_hits(strip_comments(path.read_text()))
        if hits:
            out[str(path.relative_to(compiled_dir))] = hits
    return out


def parse_failures(compiled_dir: Path) -> dict[str, str]:
    """Compiled files sqlglot cannot parse as BigQuery SQL."""
    import sqlglot

    out = {}
    for path in sorted(compiled_dir.rglob("*.sql")):
        try:
            sqlglot.parse_one(path.read_text(), read="bigquery")
        except sqlglot.errors.ParseError as exc:
            out[str(path.relative_to(compiled_dir))] = str(exc).splitlines()[0]
    return out


def compile_bigquery(target_path: Path) -> dict:
    """`dbt compile` of every model and test against the offline BigQuery profile, then the scan and the parse.

    No credentials are read and no query runs: the profile uses `oauth-secrets` with a placeholder token and the
    compile skips the relation cache. GOOGLE_APPLICATION_CREDENTIALS is cleared for the call so a developer's real
    credentials can never be picked up by accident."""
    saved = os.environ.pop("GOOGLE_APPLICATION_CREDENTIALS", None)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            ok, tp = invoke(
                ["--no-populate-cache", "compile"],
                Path(tmp) / "unused.duckdb",
                target_path,
                profiles_dir=COMPILE_PROFILES,
            )
    finally:
        if saved is not None:
            os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = saved
    compiled = tp / "compiled" / "staysignal"
    files = sorted(compiled.rglob("*.sql"))
    return {
        "ok": ok,
        "files": len(files),
        "models": sum(1 for f in files if "/models/" in str(f)),
        "tests": sum(1 for f in files if "/tests/" in str(f)),
        "banned": scan_compiled(compiled),
        "unparsed": parse_failures(compiled),
        "compiled_dir": str(compiled),
    }


def render_dialect_macros(dialect: str, target_path: Path) -> dict[str, str]:
    """Every dialect macro's branch for `dialect`, rendered by `print_dialect_macros` under the DuckDB profile."""
    printed: list[str] = []

    def on_event(event) -> None:  # dbt's print() surfaces as a PrintEvent
        if event.info.name == "PrintEvent":
            printed.append(event.data.msg)

    with tempfile.TemporaryDirectory() as tmp:
        ok, _ = invoke(
            ["run-operation", "print_dialect_macros", "--args", json.dumps({"dialect": dialect})],
            Path(tmp) / "render.duckdb",
            target_path,
            callbacks=[on_event],
        )
    line = next((m for m in printed if m.startswith("DIALECT_MACROS_JSON=")), None)
    if not ok or line is None:
        raise RuntimeError(f"print_dialect_macros failed for {dialect}")
    return json.loads(line.split("=", 1)[1])


__all__ = [
    "BANNED_IN_BIGQUERY",
    "banned_hits",
    "compile_bigquery",
    "parse_failures",
    "render_dialect_macros",
    "scan_compiled",
    "strip_jinja",
]
