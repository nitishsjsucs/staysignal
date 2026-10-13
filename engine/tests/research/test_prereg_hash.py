"""C52: research results follow the pre-registration. Every results file records the SHA-256 of
research/PREREGISTRATION.md, and the file may not change once a result exists (a change is logged under its
Deviations heading before the first result)."""

import json
from pathlib import Path

from staysignal.research.report import PREREG, prereg_sha256

RESULTS = Path(__file__).resolve().parents[3] / "results"


def test_the_preregistration_exists_with_its_decision_rules():
    text = PREREG.read_text()
    for needle in ("## Hypotheses, metrics and decision rules", "Counts against H1", "TOST", "## Deviations"):
        assert needle in text


def test_every_result_was_made_under_the_current_preregistration():
    for path in sorted(RESULTS.glob("research-*.json")):
        doc = json.loads(path.read_text())
        assert doc["prereg_sha256"] == prereg_sha256(), f"{path.name} was made under a different pre-registration"
        assert doc["kind"] == "research" and doc["label"] == "synthetic"
