"""The warehouse compiles to BigQuery offline (SPEC 7.2, 21): every model and test renders against the BigQuery
compile profile with no credentials, the compiled SQL is free of constructs BigQuery rejects and parses as BigQuery
SQL, the dialect macros render both ways, and model sources route every dialect difference through those macros.
Pattern from DataTrust `pipelines/tests/test_dialect_macros.py` (MIT). This does not prove BigQuery validity; the
production dry runs do (`npm run prod:validate`)."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest
import sqlglot

from staysignal.lineage.capture import PROJECT_DIR
from staysignal.prod.dialect import banned_hits, compile_bigquery, render_dialect_macros, strip_jinja

pytestmark = pytest.mark.dbt


@pytest.fixture(scope="module")
def rendered(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("dialect")
    return {d: render_dialect_macros(d, tmp / d) for d in ("bigquery", "duckdb")}


@pytest.fixture(scope="module")
def compiled(tmp_path_factory):
    return compile_bigquery(tmp_path_factory.mktemp("bq") / "target")


def test_both_dialects_render_the_same_macros(rendered):
    assert set(rendered["bigquery"]) == set(rendered["duckdb"])
    assert len(rendered["bigquery"]) >= 18


def test_bigquery_branches_have_no_banned_constructs(rendered):
    assert {k: banned_hits(v) for k, v in rendered["bigquery"].items() if banned_hits(v)} == {}


def test_the_check_catches_duckdb_only_sql(rendered):
    # the guard must fail on the DuckDB branches, otherwise it proves nothing
    flagged = {name for name, sql in rendered["duckdb"].items() if banned_hits(sql)}
    assert {
        "add_months",
        "days_between",
        "month_start",
        "month_series",
        "content_hash",
        "star_except",
        "int_series",
        "cast_ts",
        "cast_string",
    } <= flagged
    assert banned_hits("select count(*) filter (where x) from t group by all")


def _statement(name: str, sql: str) -> str:
    if name in ("month_series",):
        return f"select month_start from {sql} as s"
    if name == "int_series":
        return f"select i from t, {sql}"
    if name == "star_except":
        return f"select {sql} from t"
    return f"select {sql} as v from t"


@pytest.mark.parametrize("dialect", ["bigquery", "duckdb"])
def test_sqlglot_parses_rendered_branches(rendered, dialect):
    for name, sql in rendered[dialect].items():
        sqlglot.parse_one(_statement(name, sql), read=dialect)


def _bind(sql: str, **args: str) -> str:
    """The rendered branch with its placeholder arguments (d, start_date, a, ...) replaced by SQL literals."""
    import re

    return re.sub(r"\b(" + "|".join(args) + r")\b", lambda m: args[m.group(1)], sql)


def test_duckdb_branches_compute_what_the_bigquery_branches_mean(rendered):
    """The DuckDB branches, executed: end-of-month clamping, whole days, month spines, null-skipping hashes."""
    r = rendered["duckdb"]
    con = duckdb.connect()

    def one(sql: str):
        return con.execute(f"select {sql}").fetchone()[0]

    assert one(_bind(r["add_months"], d="date '2026-01-31'")).isoformat() == "2026-02-28"
    assert one(_bind(r["add_days"], d="date '2026-03-01'")).isoformat() == "2026-02-28"
    assert one(_bind(r["days_between"], start_date="date '2026-01-01'", end_date="date '2026-03-01'")) == 59
    assert one(f"count(*) from {r['month_series']} as s") == 43  # 2023-04 to 2026-10
    with_null = _bind(r["content_hash"], a="'x'", b="null", c="'y'")  # coalesce(null, '') keeps an empty field
    assert one(with_null) == one("sha256('x||y')")
    assert one(_bind(r["regex_group1"], job_code="'ENG-SWE-IC3'")) == "ENG-SWE"


def test_models_and_tests_use_only_portable_sql():
    """Model, macro and singular-test SQL outside dialect macros must route dialect differences through them."""
    offenders = {}
    for folder in ("models", "tests", "macros"):
        for path in PROJECT_DIR.joinpath(folder).rglob("*.sql"):
            if path.parent.name == "dialect" or path.name == "print_dialect_macros.sql":
                continue
            hits = banned_hits(strip_jinja(path.read_text()))
            if hits:
                offenders[str(path.relative_to(PROJECT_DIR))] = hits
    assert offenders == {}


def test_every_model_and_test_compiles_offline_for_bigquery(compiled):
    assert compiled["ok"]
    sql_models = len(list(Path(PROJECT_DIR, "models").rglob("*.sql")))
    sql_tests = len(list(Path(PROJECT_DIR, "tests").rglob("*.sql")))
    assert compiled["tests"] == sql_tests
    assert compiled["models"] >= sql_models  # plus the generic tests declared in the YAML files


def test_compiled_bigquery_sql_is_clean_and_parses(compiled):
    assert compiled["banned"] == {}
    assert compiled["unparsed"] == {}


def test_compiled_bigquery_sql_reads_only_prefixed_datasets(compiled):
    datasets = set()
    for path in Path(compiled["compiled_dir"]).rglob("*.sql"):
        for tbl in sqlglot.parse_one(path.read_text(), read="bigquery").find_all(sqlglot.exp.Table):
            if tbl.db:
                datasets.add(tbl.db)
    assert datasets and all(d.startswith("staysignal_") for d in datasets)
    assert "staysignal_audit" not in datasets  # nothing outside the audit models reads the audit attribute
