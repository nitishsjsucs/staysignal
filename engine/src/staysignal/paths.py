"""Repository paths. The engine runs from the repository (uv run --project engine), so the root is found by walking up
to the directory that holds `sources/schemas`; `SS_REPO_ROOT` overrides it."""

from __future__ import annotations

import os
from pathlib import Path


def _find_root() -> Path:
    env = os.environ.get("SS_REPO_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "sources" / "schemas").is_dir() and (parent / "engine").is_dir():
            return parent
    raise FileNotFoundError("repository root with sources/schemas not found")


REPO_ROOT = _find_root()
VAR = REPO_ROOT / "var"
WAREHOUSE = VAR / "warehouse.duckdb"
LANDING = VAR / "landing"
CONFORMED = VAR / "conformed"
MAPPINGS = REPO_ROOT / "sources" / "mappings"
