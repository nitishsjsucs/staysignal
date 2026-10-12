"""C77: the recorded action audit equals a fresh run on the canonical world; its screens are shares of one population
and its units are every person employed on each review's date."""

import json
from pathlib import Path

from staysignal.audit.action_audit import run

REPO = Path(__file__).resolve().parents[3]


def test_the_recorded_audit_is_a_fresh_run(canonical, tmp_path):
    recorded = sorted((REPO / "results").glob("action-audit-*.json"))[-1]
    rec = json.loads(recorded.read_text())
    _, fresh = run(canonical, tmp_path, today=rec["date"])
    assert json.loads(json.dumps(fresh)) == rec


def test_screens_partition_the_units(canonical, tmp_path):
    _, doc = run(canonical, tmp_path, today="2026-10-12")
    assert doc["reviews"] == 12 and doc["units"] > 20000
    for name, s in doc["screens"].items():
        rows = s["rows"]
        assert sum(r["n"] for r in rows) == doc["units"], name
        assert sum(r["selected"] for r in rows) == doc["selected_units"], name
        assert abs(sum(r["population_share"] for r in rows) - 1) < 1e-9
    assert doc["screens"]["age40"]["kind"] == "audit_only"
    assert 0.5 <= doc["proxy_strength"]["tenure_band_auc"] <= 1.0
