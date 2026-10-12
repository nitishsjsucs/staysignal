"""Versioned metric definitions (SPEC 7.4), read from `semantic/metric_definitions.yaml`.

The file is the single source of the population rule: which employment types a metric version leaves out of the
population at a cutoff. Every engine path that builds a population (point-in-time features in Python and SQL, the
trailing-rate baseline, the oracle) asks `excluded_employment_types` instead of parsing version strings. A version
is frozen once a published run references it: `semantic/metric_definitions.lock.json` pins the SHA-256 of each
frozen version's canonical JSON, and `engine/tests/semantic/test_metric_definitions.py` fails if one changes.
"""

from __future__ import annotations

import hashlib
import json
from functools import cache
from pathlib import Path

import yaml

from staysignal.canonical import canonical_json
from staysignal.paths import REPO_ROOT

DEFINITIONS = REPO_ROOT / "semantic" / "metric_definitions.yaml"
LOCK = REPO_ROOT / "semantic" / "metric_definitions.lock.json"


@cache
def load(path: Path = DEFINITIONS) -> dict[str, list[dict]]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["metrics"]


def parse_ref(metric_def: str) -> tuple[str, int]:
    """`voluntary_departures@2` -> ("voluntary_departures", 2)."""
    name, sep, ver = metric_def.partition("@")
    if not sep or not ver.isdigit():
        raise ValueError(f"not a versioned metric reference: {metric_def!r}")
    return name, int(ver)


def version(metric_def: str) -> dict:
    name, ver = parse_ref(metric_def)
    versions = load().get(name)
    if versions is None:
        raise KeyError(f"unknown metric {name!r}")
    for entry in versions:
        if entry["version"] == ver:
            return entry
    raise KeyError(f"unknown version {metric_def!r}")


def population(metric_def: str) -> dict:
    """The population rule of a metric version, following `follows` references."""
    pop = version(metric_def).get("population")
    seen = {metric_def}
    while pop and "follows" in pop:
        ref = pop["follows"]
        if ref in seen:
            raise ValueError(f"cyclic population reference at {ref}")
        seen.add(ref)
        pop = version(ref).get("population")
    if not pop:
        raise KeyError(f"{metric_def} has no population rule")
    return pop


def excluded_employment_types(metric_def: str) -> tuple[str, ...]:
    return tuple(population(metric_def).get("exclude_employment_types") or ())


def excludes(metric_def: str, employment_type: str | None) -> bool:
    return employment_type in excluded_employment_types(metric_def)


def version_sha256(entry: dict) -> str:
    return hashlib.sha256(canonical_json(entry).encode("utf-8")).hexdigest()


def current_hashes() -> dict[str, str]:
    return {f"{name}@{e['version']}": version_sha256(e) for name, vs in load().items() for e in vs}


def frozen_hashes(lock: Path = LOCK) -> dict[str, str]:
    return json.loads(lock.read_text(encoding="utf-8"))["frozen"]


__all__ = [
    "current_hashes",
    "excluded_employment_types",
    "excludes",
    "frozen_hashes",
    "load",
    "parse_ref",
    "population",
    "version",
    "version_sha256",
]
