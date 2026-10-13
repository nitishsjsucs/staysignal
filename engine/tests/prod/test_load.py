"""prod:load (SPEC 23.2, path B): the plan from the files alone, the preflight that guards --execute, and a full
execution on the small world against fakes (no R2, no BigQuery, no dbt): every object, table and document goes where
the plan says, under the repo's prefixes, and nothing is published when dbt fails."""

import json
from pathlib import Path

import duckdb
import pytest

from staysignal.ingest.schemas import kind_of
from staysignal.prod import load


@pytest.fixture()
def published(tmp_path: Path) -> Path:
    d = tmp_path / "published"
    (d / "forecast").mkdir(parents=True)
    (d / "runs.json").write_text(json.dumps({"runs": [{"run_id": "R-1"}]}))
    (d / "forecast" / "R-1.json").write_text(json.dumps({"b": 2, "a": 1}))
    return d


def test_the_plan_names_every_extract_content_addressed_and_every_document(small, published):
    p = load.plan(small, published)
    assert p.rejected == [] and len(p.objects) == len(load.source_files(small)) > 10
    for o in p.objects:
        assert o["key"].startswith("landing/") and o["key"].endswith(f"/{o['sha256']}.csv")
    assert p.documents == ["forecast/R-1.json", "runs.json"]
    s = p.summary()
    assert s["raw"]["datasets"] == ["staysignal_audit", "staysignal_raw"] and s["lab"]["skipped"]
    assert s["dbt"]["maximum_bytes_billed"] == 1 << 30 and s["dbt"]["labels"]["app"] == "staysignal"


def test_execute_is_refused_without_a_project_or_the_production_pseudonym_key():
    assert load.preflight({"SS_HMAC_MASTER_KEY": "k"}, "my-project-123") == []
    assert any("project" in x for x in load.preflight({"SS_HMAC_MASTER_KEY": "k"}, None))
    assert any("malformed" in x for x in load.preflight({"SS_HMAC_MASTER_KEY": "k"}, "Bad_Project"))
    assert any("SS_HMAC_MASTER_KEY" in x for x in load.preflight({}, "my-project-123"))


def test_the_production_dbt_profile_uses_adc_the_cap_and_the_label():
    out = load.prod_profile("my-project-123")["staysignal"]["outputs"]["prod"]
    assert out["method"] == "oauth" and "keyfile" not in out
    assert out["maximum_bytes_billed"] == 1 << 30 and out["labels"]["app"] == "staysignal"


def test_only_the_raw_and_audit_schemas_have_production_datasets():
    assert load.dataset_for("raw") == "staysignal_raw" and load.dataset_for("audit") == "staysignal_audit"
    with pytest.raises(ValueError):
        load.dataset_for("restricted")


class Fakes:
    def __init__(self, dbt_ok: bool = True) -> None:
        self.r2: list[str] = []
        self.tables: dict[str, int] = {}
        self.docs: list[dict] = []
        self.dbt_ok = dbt_ok
        self.dbt_vars: dict | None = None

    def deps(self) -> load.Deps:
        def r2_put(key: str, path: Path) -> None:
            assert path.exists()
            self.r2.append(key)

        def load_parquet(path: Path, table: str) -> None:
            self.tables[table] = duckdb.sql(f"SELECT count(*) FROM '{path}'").fetchone()[0]

        def load_documents(rows: list[dict], table: str) -> None:
            assert table == "my-project-123.staysignal_published.documents"
            self.docs = rows

        def dbt_build(profiles: Path, dbt_vars: dict) -> bool:
            assert (profiles / "profiles.yml").exists()
            self.dbt_vars = dbt_vars
            return self.dbt_ok

        return load.Deps(r2_put, load_parquet, load_documents, dbt_build, log=lambda *_: None)


def test_execute_on_the_small_world_against_fakes(small, published, tmp_path, monkeypatch):
    monkeypatch.setenv("SS_HMAC_MASTER_KEY", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
    p = load.plan(small, published)
    f = Fakes()
    res = load.execute(p, small, published, tmp_path / "work", "my-project-123", f.deps())
    assert res["ok"] and f.r2 == [o["key"] for o in p.objects]
    assert all(t.startswith(("my-project-123.staysignal_raw.", "my-project-123.staysignal_audit.")) for t in f.tables)
    hris = [x for x in load.source_files(small) if (k := kind_of(x.name)) and k[0].source == "hris"]
    assert f.tables["my-project-123.staysignal_raw.raw_hris"] == sum(len(x.read_text().splitlines()) - 1 for x in hris)
    assert f.tables["my-project-123.staysignal_raw._employee_keys"] > 0
    assert f.dbt_vars == {"vintage": load.VINTAGE, "pay_basis_mapping": "payroll@1"}
    assert [d["key"] for d in f.docs] == ["forecast/R-1.json", "runs.json"]
    assert json.loads(f.docs[0]["doc"]) == {"a": 1, "b": 2}


def test_nothing_is_published_when_dbt_fails(small, published, tmp_path, monkeypatch):
    monkeypatch.setenv("SS_HMAC_MASTER_KEY", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
    f = Fakes(dbt_ok=False)
    res = load.execute(load.plan(small, published), small, published, tmp_path / "work", "my-project-123", f.deps())
    assert not res["ok"] and res["dbt"] is False and f.docs == []
