"""C47: metric definitions are versioned and frozen once a published run uses them (SPEC 7.4), and the engine's
population rule comes from the definitions file, not from version strings."""

import json
from pathlib import Path

import pytest

from staysignal.semantic import definitions as d

REPO = Path(__file__).resolve().parents[3]


def published_metric_refs() -> set[str]:
    runs = json.loads((REPO / "test" / "fixtures" / "api" / "runs.json").read_text())["runs"]
    refs = {r["metric_def"] for r in runs}
    # the expected-departures metric of each run follows its departures definition
    return refs | {f"expected_{r}" for r in refs}


def test_every_version_a_published_run_uses_is_frozen_and_unchanged():
    frozen = d.frozen_hashes()
    current = d.current_hashes()
    refs = published_metric_refs()
    assert refs == {"voluntary_departures@1", "voluntary_departures@2"} | {
        "expected_voluntary_departures@1",
        "expected_voluntary_departures@2",
    }
    assert refs <= set(frozen)
    changed = {k for k in frozen if current.get(k) != frozen[k]}
    assert changed == set(), f"frozen metric versions were edited: {sorted(changed)}; add a new version instead"


def test_an_edit_to_a_frozen_version_is_detected():
    entry = dict(d.version("voluntary_departures@1"))
    assert d.version_sha256(entry) == d.frozen_hashes()["voluntary_departures@1"]
    entry["definition"] = entry["definition"] + " (edited)"
    assert d.version_sha256(entry) != d.frozen_hashes()["voluntary_departures@1"]


def test_population_rules():
    assert d.excluded_employment_types("voluntary_departures@1") == ()
    assert d.excluded_employment_types("voluntary_departures@2") == ("fixed_term",)
    assert d.excluded_employment_types("expected_voluntary_departures@2") == ("fixed_term",)  # follows @2
    assert d.excludes("voluntary_departures@2", "fixed_term") and not d.excludes("voluntary_departures@2", "regular")
    assert not d.excludes("voluntary_departures@2", None)
    with pytest.raises(KeyError):
        d.version("voluntary_departures@3")
    with pytest.raises(ValueError):
        d.parse_ref("voluntary_departures")


def test_versions_are_numbered_and_contiguous_in_time():
    for name, versions in d.load().items():
        assert [v["version"] for v in versions] == sorted(v["version"] for v in versions), name
        for a, b in zip(versions, versions[1:], strict=False):
            assert a["valid_to"] == b["valid_from"], f"{name}@{a['version']} does not end where @{b['version']} starts"
        assert versions[-1]["valid_to"] is None, f"{name}: the latest version must be open"
        for v in versions:
            assert v["definition"].strip() and v["changelog"].strip(), f"{name}@{v['version']}"


def test_the_definition_change_date_matches_the_decision():
    v1, v2 = d.load()["voluntary_departures"]
    assert v1["valid_to"] == v2["valid_from"] == "2026-09-20"
    assert "DEC-2026-09-20-01" in v2["changelog"]
