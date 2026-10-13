"""The research results (research/PREREGISTRATION.md): per arm, level and handling, mean observed over expected (company
level), 80% and 95% coverage and the 80% interval score (company and organizations), the seed-bootstrap 90% interval
and the TOST p-value; team-level randomized PIT for factor C; and each hypothesis judged by its pre-registered rule.

Operationalization of the rules: "inside the bounds" means equivalence shown by TOST at alpha 0.05 (the bootstrap 90%
interval inside the bounds); "outside the bounds" means equivalence not shown. Every results file records the
SHA-256 of the pre-registration. Synthetic worlds only.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path

import numpy as np

from staysignal.evaluate.metrics import covered, interval_score
from staysignal.research.arms import Arm, arms
from staysignal.research.tost import ks_uniform, tost

PREREG = Path(__file__).resolve().parents[4] / "research" / "PREREGISTRATION.md"
OE_BOUNDS = (0.95, 1.05)
COVERAGE_BOUNDS = (0.75, 0.85)
PIT_KS_MAX = 0.05


def prereg_sha256(path: Path = PREREG) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _cell(arm: Arm, by_seed: dict[int, list[dict]]) -> dict:
    oe: list[list[float]] = []
    cov80: list[list[float]] = []
    cov95: list[float] = []
    score80: list[float] = []
    pits: list[float] = []
    team_cov: list[float] = []
    for _, rows in sorted(by_seed.items()):
        sel = [
            r for r in rows if r["condition"] == arm.condition and r["fit"] == arm.fit and r["interval"] == arm.interval
        ]
        oe.append([r["observed"] / r["expected"] for r in sel if r["level"] == "company" and r["expected"] > 0])
        agg = [r for r in sel if r["level"] in ("company", "organization")]
        cov80.append([float(covered(r["observed"], r["i80"])) for r in agg])
        cov95 += [float(covered(r["observed"], r["i95"])) for r in agg]
        score80 += [interval_score(r["observed"], r["i80"], 0.80) for r in agg]
        pits += [r["pit"] for r in sel if r["level"] == "team"]
        team_cov += [float(covered(r["observed"], r["i80"])) for r in sel if r["level"] == "team"]
    t_oe = tost(oe, OE_BOUNDS)
    t_cov = tost(cov80, COVERAGE_BOUNDS)
    return {
        "factor": arm.factor,
        "level": arm.level,
        "handling": arm.handling,
        "condition": arm.condition,
        "fit": arm.fit,
        "interval": arm.interval,
        "seeds": len(oe),
        "company_windows": sum(len(v) for v in oe),
        "oe": round(t_oe.estimate, 4),
        "oe_lo90": round(t_oe.lo90, 4),
        "oe_hi90": round(t_oe.hi90, 4),
        "oe_tost_p": round(t_oe.p, 4),
        "oe_equivalent": t_oe.equivalent,
        "cov80": round(t_cov.estimate, 4),
        "cov80_lo90": round(t_cov.lo90, 4),
        "cov80_hi90": round(t_cov.hi90, 4),
        "cov80_tost_p": round(t_cov.p, 4),
        "cov80_equivalent": t_cov.equivalent,
        "cov95": round(float(np.mean(cov95)), 4) if cov95 else None,
        "interval_score80": round(float(np.mean(score80)), 4) if score80 else None,
        "team_pit_ks": round(ks_uniform(pits), 4) if pits else None,
        "team_cov80": round(float(np.mean(team_cov)), 4) if team_cov else None,
        "team_windows": len(pits),
    }


def _find(cells: list[dict], factor: str, level: str, handling: str) -> dict:
    return next(c for c in cells if c["factor"] == factor and c["level"] == level and c["handling"] == handling)


def hypotheses(cells: list[dict]) -> dict:
    a = lambda lvl, h: _find(cells, "A", lvl, h)  # noqa: E731
    b = lambda lvl, h: _find(cells, "B", lvl, h)  # noqa: E731
    c = lambda lvl, h: _find(cells, "C", lvl, h)  # noqa: E731
    d = lambda lvl, h: _find(cells, "D", lvl, h)  # noqa: E731
    h1_against = (not a("0.30", "matured")["oe_equivalent"]) or a("0.30", "naive")["oe_equivalent"]
    h2_against = (not b("missing", "censored")["oe_equivalent"]) or b("missing", "no_events")["oe_equivalent"]
    h3a_against = (not c("0.5", "shock_aware")["cov80_equivalent"]) or c("0.5", "independence")["cov80_equivalent"]
    ks = c("0.5", "shock_aware")["team_pit_ks"]
    h3b_against = ks is None or ks > PIT_KS_MAX
    h4_against = (not d("0.05", "deduplicated")["oe_equivalent"]) or d("0.05", "not_deduplicated")["oe_equivalent"]
    verdict = lambda against: "counts against" if against else "consistent"  # noqa: E731
    return {
        "H1": {
            "rule": "counts against: matured O/E not shown equivalent at share 0.30, or naive O/E shown equivalent at share 0.30",
            "naive_oe_by_share": {lvl: a(lvl, "naive")["oe"] for lvl in ("0", "0.15", "0.30")},
            "matured_equivalent_by_share": {lvl: a(lvl, "matured")["oe_equivalent"] for lvl in ("0", "0.15", "0.30")},
            "verdict": verdict(h1_against),
        },
        "H2": {
            "rule": "counts against: censored O/E not shown equivalent, or no-events O/E shown equivalent",
            "no_events_oe": b("missing", "no_events")["oe"],
            "censored_oe": b("missing", "censored")["oe"],
            "verdict": verdict(h2_against),
        },
        "H3a": {
            "rule": "counts against: shock-aware 80% coverage at sigma 0.5 not shown within 75% to 85%, or independence coverage at sigma 0.5 shown within it",
            "independence_cov80_by_sigma": {lvl: c(lvl, "independence")["cov80"] for lvl in ("0", "0.25", "0.5")},
            "shock_aware_cov80_by_sigma": {lvl: c(lvl, "shock_aware")["cov80"] for lvl in ("0", "0.25", "0.5")},
            "verdict": verdict(h3a_against),
        },
        "H3b": {
            "rule": "counts against: team-level shock-aware randomized PIT KS distance above 0.05 at sigma 0.5",
            "shock_aware_ks_by_sigma": {lvl: c(lvl, "shock_aware")["team_pit_ks"] for lvl in ("0", "0.25", "0.5")},
            "independence_ks_by_sigma": {lvl: c(lvl, "independence")["team_pit_ks"] for lvl in ("0", "0.25", "0.5")},
            "verdict": verdict(h3b_against),
        },
        "H4": {
            "rule": "counts against: deduplicated O/E not shown equivalent, or not-deduplicated O/E shown equivalent at share 0.05",
            "not_deduplicated_oe": d("0.05", "not_deduplicated")["oe"],
            "deduplicated_oe": d("0.05", "deduplicated")["oe"],
            "verdict": verdict(h4_against),
        },
        "H5": {
            "rule": "exploratory, no decision rule",
            "cells": [x for x in cells if x["factor"] == "AxC"],
            "verdict": "descriptive",
        },
    }


def summarize(seed_docs: list[dict]) -> dict:
    by_seed: dict[int, list[dict]] = defaultdict(list)
    for doc in seed_docs:
        by_seed[doc["seed"]] += doc["rows"]
    cells = [_cell(arm, by_seed) for arm in arms()]
    return {"cells": cells, "hypotheses": hypotheses(cells)}


__all__ = ["COVERAGE_BOUNDS", "OE_BOUNDS", "PREREG", "hypotheses", "prereg_sha256", "summarize"]
