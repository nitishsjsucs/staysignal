"""SPEC 15.1: no GPL-licensed distribution is installed in the sim environment (python-igraph is replaced by the
in-repo shim, and the heavy ML stack is kept out of the lock)."""

import re
from importlib.metadata import distributions

EXCLUDED = {"torch", "transformers", "sentence-transformers", "igraph", "python-igraph", "neo4j", "unstructured"}


def licenses(d) -> str:
    meta = d.metadata
    parts = [meta.get("License") or "", meta.get("License-Expression") or ""]
    parts += [c for c in meta.get_all("Classifier") or [] if c.startswith("License")]
    return " ".join(parts)


def test_no_gpl_distribution_and_none_of_the_excluded_ones():
    names = {(d.metadata["Name"] or "").lower() for d in distributions()}
    assert not names & EXCLUDED
    gpl = [
        d.metadata["Name"]
        for d in distributions()
        if re.search(r"\bA?GPL\b|GNU (Affero )?General Public", licenses(d))
        and not re.search(r"\bLGPL\b|Lesser", licenses(d))
    ]
    assert gpl == []
