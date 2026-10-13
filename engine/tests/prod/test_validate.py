"""prod:validate (SPEC 23.2, 21): the dry-run plan over the compiled SQL, and its execution against a fake client
(no network, no credentials). The real dry runs are the operator's, on the Mac."""

from pathlib import Path

import pytest

from staysignal.prod import validate


def compiled(tmp_path: Path, files: dict[str, str]) -> Path:
    for rel, sql in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(sql)
    return tmp_path


MODEL = "select * from `staysignal-project-id`.`staysignal_staging`.`stg_hris__records`"
TEST = "select 1 from `staysignal-project-id`.`staysignal_published`.`rpt_flows_monthly` where false"


class Job:
    def __init__(self, n: int) -> None:
        self.total_bytes_processed = n


class FakeClient:
    def __init__(self, outcomes: dict[str, object]) -> None:
        self.outcomes = outcomes
        self.sent: list[tuple[str, dict]] = []

    def query(self, sql: str, job_config: dict) -> Job:
        self.sent.append((sql, job_config))
        for key, outcome in self.outcomes.items():
            if key in sql:
                if isinstance(outcome, Exception):
                    raise outcome
                return Job(outcome)
        return Job(10)


def config(**kw: object) -> dict:
    return kw


def test_the_plan_has_one_dry_run_per_file_and_tells_models_from_tests(tmp_path):
    runs = validate.plan(
        compiled(tmp_path, {"models/staging/a.sql": MODEL, "tests/dq/t.sql": TEST, "models/x/_s.yml/n.sql": TEST})
    )
    assert [(r.name, r.kind) for r in runs] == [
        ("models/staging/a.sql", "model"),
        ("models/x/_s.yml/n.sql", "test"),
        ("tests/dq/t.sql", "test"),
    ]
    assert validate.problems(runs) == []
    assert validate.summarize(runs, None)["ok"] and not validate.summarize(runs, None)["executed"]


def test_a_foreign_dataset_or_project_is_a_problem_before_anything_is_sent(tmp_path):
    runs = validate.plan(compiled(tmp_path, {"models/a.sql": "select * from `other-proj`.`peoplelake_raw`.`t`"}))
    found = validate.problems(runs)
    assert any("peoplelake_raw" in f for f in found) and any("other-proj" in f for f in found)
    assert not validate.summarize(runs, None)["ok"]


def test_every_dry_run_is_free_capped_labelled_and_bound_to_the_project(tmp_path):
    runs = validate.plan(compiled(tmp_path, {"models/a.sql": MODEL, "tests/t.sql": TEST}))
    client = FakeClient({})
    results = validate.execute(runs, client, "my-project-123", config)
    assert [x["status"] for x in results] == ["passed", "passed"]
    for sql, cfg in client.sent:
        assert "`my-project-123`.`staysignal_" in sql and "staysignal-project-id" not in sql
        assert cfg == {
            "dry_run": True,
            "use_query_cache": False,
            "maximum_bytes_billed": 1 << 30,
            "labels": {"app": "staysignal", "purpose": "validate"},
        }


def test_missing_upstream_tables_are_not_failures_until_strict(tmp_path):
    runs = validate.plan(compiled(tmp_path, {"models/a.sql": MODEL, "tests/t.sql": TEST}))
    client = FakeClient(
        {"stg_hris__records": RuntimeError("404 Not found: Table my-project-123:staysignal_staging.stg_hris__records")}
    )
    results = validate.execute(runs, client, "my-project-123", config)
    assert [x["status"] for x in results] == ["needs_upstream", "passed"]
    assert validate.summarize(runs, results)["ok"]
    assert not validate.summarize(runs, results, strict=True)["ok"]


def test_invalid_sql_and_bytes_over_the_cap_fail(tmp_path):
    runs = validate.plan(compiled(tmp_path, {"models/a.sql": MODEL, "tests/t.sql": TEST}))
    client = FakeClient(
        {"stg_hris__records": RuntimeError("400 Syntax error: Unexpected keyword"), "rpt_flows": (1 << 30) + 1}
    )
    doc = validate.summarize(runs, validate.execute(runs, client, "my-project-123", config))
    assert doc["counts"] == {"passed": 0, "needs_upstream": 0, "failed": 2} and not doc["ok"]


def test_bind_refuses_anything_but_a_project_id():
    with pytest.raises(ValueError):
        validate.bind(MODEL, "proj`; drop table x; --")
