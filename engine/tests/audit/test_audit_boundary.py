"""C57 (ADR 0013): the audit-only attribute never leaves the audit path. No forecast, model, feature, change,
semantic, evaluation, baseline, quality or memory module imports the audit package; only the generator, the loader
(into the isolated `audit` schema) and the audit package mention the attribute file; no warehouse model outside an
audit folder reads the audit source; no feature or published fixture carries an age field."""

import ast
import json
from dataclasses import fields
from pathlib import Path

from staysignal.features.reference import FeatureRow

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "engine" / "src" / "staysignal"
GUARDED = [
    "forecast",
    "model",
    "features",
    "changes",
    "semantic",
    "evaluate",
    "baselines",
    "quality",
    "memory",
    "runner",
    "service",
    "fixtures",
]


def imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module)
        elif isinstance(node, ast.Import):
            out.update(a.name for a in node.names)
    return out


def test_no_guarded_module_imports_the_audit_package():
    offenders = {
        str(p.relative_to(SRC)): sorted(m for m in imports(p) if m.startswith("staysignal.audit"))
        for pkg in GUARDED
        for p in (SRC / pkg).rglob("*.py")
    }
    assert {k: v for k, v in offenders.items() if v} == {}


def test_only_the_audit_path_names_the_attribute_file():
    allowed = {"audit", "world", "ingest"}
    hits = [
        str(p.relative_to(SRC))
        for p in SRC.rglob("*.py")
        if "audit_attributes" in p.read_text() and p.relative_to(SRC).parts[0] not in allowed
    ]
    # the one other mention is the replay leaving the audit file out of the rebuilt warehouse
    assert hits == ["runner/jobs.py"]
    assert "source <> 'audit_attributes'" in (SRC / "runner" / "jobs.py").read_text()


def test_no_warehouse_model_outside_audit_reads_the_audit_source():
    for p in (REPO / "warehouse" / "models").rglob("*.sql"):
        if "audit" in p.relative_to(REPO / "warehouse" / "models").parts:
            continue
        assert "source('audit'" not in p.read_text().replace('"', "'"), p


def test_no_feature_or_published_fixture_carries_age():
    assert not any("age" in f.name.split("_") for f in fields(FeatureRow))
    for p in (REPO / "test" / "fixtures" / "api").rglob("*.json"):
        if p.name == "action-audit.json":
            continue  # the audit's own aggregates (served to the auditor only)
        assert "age40" not in p.read_text(), p
    worker = json.loads((REPO / "policy" / "roles.json").read_text())
    assert worker  # roles are policy, not data
