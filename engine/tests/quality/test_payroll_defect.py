"""C17, C66, C67: the defect pattern, the deterministic mapping proposal, and canonical runs passing their checks."""

from datetime import UTC, datetime

import pytest

from staysignal.ingest.landing import load_world_sources
from staysignal.quality.mapping_proposal import load_mapping, propose
from staysignal.quality.probes import rca_probe
from staysignal.quality.run_checks import run_checks, summarize

ARRIVAL = datetime(2026, 10, 5, 14, 5, tzinfo=UTC)


@pytest.fixture(scope="module")
def sources(canonical):
    return load_world_sources(canonical), load_world_sources(canonical, include_held=True)


def test_payroll_defect_pattern(sources):
    _, held = sources
    s = summarize(run_checks(held, ARRIVAL, "payroll@1"))
    assert s["failing"] == ["C01", "C02", "C03"]
    assert s["warnings"] == ["C04"]
    status = {r["check_id"]: r["status"] for r in s["results"]}
    assert status["X01"] == "pass" and status["F01"] == "pass"


def test_canonical_runs_pass_checks(sources):
    base, held = sources
    for v in (datetime(2026, 9, 1, 6, tzinfo=UTC), datetime(2026, 10, 1, 6, tzinfo=UTC)):
        assert summarize(run_checks(base, v, "payroll@1"))["failing"] == []
    assert summarize(run_checks(held, ARRIVAL, "payroll@2"))["failing"] == []


def test_mapping_proposal_is_generated_from_evidence(sources):
    _, held = sources
    failing = [r for r in run_checks(held, ARRIVAL, "payroll@1") if r["status"] == "fail"]
    probe = rca_probe(held, ARRIVAL, failing)
    ann = [p for p in probe["probes"] if p["pay_basis_code"] == "ANN"]
    assert ann and ann[0]["entity"] == "CA-ENT" and 10 < ann[0]["median_ratio"] < 14
    assert probe["ranking"][0]["node"] in ("stg_payroll__lines", "stg_map__pay_basis")
    assert probe["path"] == [
        "stg_payroll__lines",
        "int_comp__annualized",
        "fct_comp_position",
        "feature_snapshot",
        "forecast_run",
    ]
    assert propose(load_mapping(1), probe["probes"])["proposed"] == load_mapping(2)
