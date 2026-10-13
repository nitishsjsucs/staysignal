"""The Scenario Lab's sanity panel (SPEC 15.7): a consistency check, not validation. It runs here, in the engine,
because only the engine holds model outputs; the sim never sees them.

- Persona agreement: the Spearman correlation between each cohort cell's mean pre-round concern (the career item,
  reverse-scored: 6 minus "I can see a future for my career here") and the published model's mean expected 3-month
  voluntary rate for that cell, with a bootstrap 95% interval (2,000 resamples of personas within replicates).
- Facts-only baseline: the same correlation for a composite of the facts printed on the cards (the mean rank of the
  three facts). The model's cohort risk is driven by those same facts, so persona agreement is mostly prompt echo;
  the panel claims only what personas add beyond this baseline.
- Negative controls: the facts-removed and facts-shuffled replicates' concern against the same model rates.

Cells with fewer than 3 persona-replicates are pooled. Model rates are cell means only; no individual value leaves.
"""

from __future__ import annotations

import json
import random
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

from staysignal.features.reference import FeatureRow
from staysignal.forecast.score import score
from staysignal.lab.cells import cells_with_members
from staysignal.model.artifact import Model

BOOTSTRAP = 2000
MIN_PER_CELL = 3
CONSTRUCT_NOTE = (
    "Stance toward a proposal is a different construct from departure propensity, so the comparison is anchored on "
    "the pre-round career item, reverse-scored as concern."
)
LIMITS = [
    "Argyle et al. 2023: fidelity requires rich conditioning",
    "Bisbee et al. 2024: too little variance, wording sensitivity, drift",
    "Santurkar et al. 2023: misalignment with group opinions",
    "Dominguez-Olmedo et al. 2024: ordering and labeling bias",
    "Wang, Morgenstern and Dickerson 2025: flattening of groups",
    "Li et al. 2025: more persona detail drifts results further",
    "Chang et al. 2025: LLM-generated networks overstate homophily",
    "Lukauskas and Sarkauskaite 2026: no LLM beat a Gaussian-copula baseline on an employee psychometric audit; models agree with each other more than with people; acquiescence",
    "Larooij and Tornberg: validation is the central gap",
]


def ranks(xs: list[float]) -> np.ndarray:
    """Average ranks (ties share their mean rank)."""
    a = np.asarray(xs, dtype=float)
    order = a.argsort(kind="mergesort")
    r = np.empty(len(a))
    i = 0
    while i < len(a):
        j = i
        while j + 1 < len(a) and a[order[j + 1]] == a[order[i]]:
            j += 1
        r[order[i : j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return r


def spearman(x: list[float], y: list[float]) -> float | None:
    if len(x) < 3:
        return None
    rx, ry = ranks(x), ranks(y)
    if rx.std() == 0 or ry.std() == 0:
        return None
    return float(np.corrcoef(rx, ry)[0, 1])


def cell_rates(
    model: Model, rows: list[FeatureRow], cutoff: date
) -> tuple[dict[str, float], dict[str, dict], dict[str, str]]:
    """Mean expected 3-month voluntary probability per cell, each cell's facts and its tenure band."""
    cells, _ = cells_with_members(rows)
    s = score(model, rows, cutoff)
    p3 = {r.employee_number: float(s.F[i, 2, 0]) for i, r in enumerate(rows)}
    rates = {c["cell_id"]: float(np.mean([p3[m.employee_number] for m in members])) for c, members in cells}
    return rates, {c["cell_id"]: c["facts"] for c, _ in cells}, {c["cell_id"]: c["tenure_band"] for c, _ in cells}


def concern_rows(session: Path, variant: str) -> list[dict]:
    """(replicate, persona, cell, concern) from the pre items of every replicate of one card variant."""
    out = []
    for d in sorted(p for p in session.iterdir() if (p / "manifest.json").exists()):
        m = json.loads((d / "manifest.json").read_text())
        if m["card_variant"] != variant:
            continue
        career = 4  # index of the career item in the sim's ITEMS
        for line in (d / "items.jsonl").read_text().splitlines():
            it = json.loads(line)
            if it["phase"] == "pre" and it["values"]:
                out.append(
                    {
                        "replicate": m["seed"],
                        "persona": it["persona"],
                        "cell": it["cell_id"],
                        "concern": 6 - it["values"][career],
                    }
                )
    return out


def _pool(rows: list[dict], tenure: dict[str, str]) -> list[dict]:
    """Cells with fewer than MIN_PER_CELL persona-replicates are pooled by tenure band; each row keeps its own cell."""
    count: dict[str, int] = defaultdict(int)
    for r in rows:
        count[r["cell"]] += 1
    return [
        {**r, "group": r["cell"] if count[r["cell"]] >= MIN_PER_CELL else f"pooled {tenure.get(r['cell'], 'other')}"}
        for r in rows
    ]


def _agreement(rows: list[dict], rates: dict[str, float]) -> tuple[float | None, int]:
    """Spearman over groups: mean concern against the mean model rate of the cells the group's personas came from."""
    concern: dict[str, list[float]] = defaultdict(list)
    rate: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        concern[r["group"]].append(r["concern"])
        if r["cell"] in rates:
            rate[r["group"]].append(rates[r["cell"]])
    groups = sorted(g for g in concern if rate[g])
    return spearman([float(np.mean(concern[g])) for g in groups], [float(np.mean(rate[g])) for g in groups]), len(
        groups
    )


def facts_composite(facts: dict[str, dict], cells: list[str]) -> list[float]:
    keys = ("share_below_midpoint", "median_months_since_promotion", "share_manager_change_180d")
    cols = [ranks([facts[c][k] if facts[c][k] is not None else 0.0 for c in cells]) for k in keys]
    return [float(np.mean([col[i] for col in cols])) for i in range(len(cells))]


def panel(
    session: Path, rates: dict[str, float], facts: dict[str, dict], tenure: dict[str, str], seed: int = 0
) -> dict:
    main = _pool(concern_rows(session, "main"), tenure)
    rho, n_cells = _agreement(main, rates)
    rng = random.Random(seed)
    by_rep: dict[int, list[dict]] = defaultdict(list)
    for r in main:
        by_rep[r["replicate"]].append(r)
    boots = []
    for _ in range(BOOTSTRAP):
        b, _ = _agreement([rng.choice(rows) for rows in by_rep.values() for _ in rows], rates)
        if b is not None:
            boots.append(b)
    ci = [float(np.percentile(boots, 2.5)), float(np.percentile(boots, 97.5))] if boots else None
    cells = sorted(c for c in {r["cell"] for r in main} if c in facts)
    baseline = spearman(facts_composite(facts, cells), [rates[c] for c in cells]) if len(cells) >= 3 else None
    controls = {
        v: _agreement(_pool(concern_rows(session, v), tenure), rates) for v in ("facts_removed", "facts_shuffled")
    }
    per_group: dict[str, int] = defaultdict(int)
    for r in main:
        per_group[r["group"]] += 1

    def rnd(v: float | None) -> float | None:
        return None if v is None else round(v, 3)

    return {
        "label": "A consistency check, not validation",
        "persona_agreement": {
            "spearman": rnd(rho),
            "ci95": [rnd(x) for x in ci] if ci else None,
            "n_cells": n_cells,
            "persona_replicates_per_cell": dict(sorted(per_group.items())),
            "bootstrap": BOOTSTRAP,
        },
        "facts_only_baseline": {"spearman": rnd(baseline), "n_cells": len(cells)},
        "negative_controls": {k: {"spearman": rnd(v[0]), "n_cells": v[1]} for k, v in controls.items()},
        "construct_note": CONSTRUCT_NOTE,
        "limits": LIMITS,
    }


__all__ = ["BOOTSTRAP", "LIMITS", "cell_rates", "concern_rows", "facts_composite", "panel", "ranks", "spearman"]
