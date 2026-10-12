"""Disclosure control helpers shared by publishing and the fixtures export (SPEC 17.5). The Worker's
`guard/disclosure.ts` applies the same steps from `policy/disclosure.json`; a test compares the two."""

from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path

MIN_CELL = 10
MIN_COMPARISON = 50


@lru_cache(maxsize=1)
def disclosure_policy() -> dict:
    here = Path(__file__).resolve()
    for parent in here.parents:
        p = parent / "policy" / "disclosure.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError("policy/disclosure.json not found")


def rounding_step(n: int) -> tuple[float, str]:
    """Rounding step and band for a cohort of n people (n of at least 10)."""
    for band in disclosure_policy()["expected_rounding"]:
        if n >= band["min_n"]:
            return float(band["step"]), band["band"]
    raise ValueError(f"cohort of {n} is below the minimum cell size")


def round_to_step(x: float, step: float) -> float:
    """Half-up rounding to a multiple of step, exact for the steps used (0.1, 0.5, 1)."""
    k = math.floor(x / step + 0.5 + 1e-9)
    return round(k * step, 6)


def round_share(x: float, points: int = 5) -> int:
    """A share in [0, 1] as whole percentage points rounded to a multiple of `points`."""
    return int(points * math.floor(100.0 * x / points + 0.5))
