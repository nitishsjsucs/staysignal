"""What changed: the five-factor Shapley decomposition between two runs (SPEC 12), with the population-change rule.

Each of the 32 combinations is a well-defined record set, cutoff, clock, model and definition, scored like a run
(point forecasts with shocks at their mean). A factor whose switch changes a cohort's population by 1 to 9 people is
merged with Calendar into one bar, "Time and population (merged: fewer than 10 people changed)" (SPEC 17.5).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

import numpy as np

from staysignal.changes.record_sets import FACTORS, FAR_FUTURE, LABELS, combine, split
from staysignal.changes.shapley import shapley
from staysignal.features.reference import MAPPINGS, FeatureRow, Vintage, features_at
from staysignal.forecast.cohorts import cohort_index
from staysignal.forecast.score import score
from staysignal.ingest.landing import Sources
from staysignal.model.artifact import Model
from staysignal.privacy.suppression import MIN_COMPARISON, round_to_step, rounding_step

HORIZONS = (1, 3, 6)
MERGE_LABEL = "Time and population (merged: fewer than 10 people changed)"


@dataclass(frozen=True)
class RunSpec:
    run_id: str
    cutoff: date
    vintage: datetime
    model: str
    metric_def: str
    mapping: str


def cohort_sums(rows: list[FeatureRow], F: np.ndarray) -> tuple[dict[str, dict[int, float]], dict[str, set[str]]]:
    sums: dict[str, dict[int, float]] = {}
    members: dict[str, set[str]] = {}
    for c, idx in cohort_index(rows).items():
        sums[c.id] = {h: float(F[idx, h - 1, 0].sum()) for h in HORIZONS}
        members[c.id] = {rows[i].employee_number for i in idx}
    return sums, members


def decompose(
    src: Sources, P: RunSpec, Q: RunSpec, models: dict[str, Model], q_table: dict[str, dict], p_table: dict[str, dict]
) -> dict:
    sp = split(src, P.vintage, Q.vintage, P.cutoff, Q.cutoff)
    values: dict[tuple[int, int, int, int, int], dict[str, dict[int, float]]] = {}
    populations: dict[tuple[int, int, int], dict[str, set[str]]] = {}
    for comp in (0, 1):
        for data in (0, 1):
            parts = [sp.base] + ([sp.composition] if comp else []) + ([sp.input_data] if data else [])
            vin = Vintage(combine(parts, src.bands), FAR_FUTURE)
            A = Q.cutoff if comp else P.cutoff
            for cal in (0, 1):
                clock = Q.cutoff if cal else P.cutoff
                for dfn in (0, 1):
                    rows = features_at(vin, A, MAPPINGS[P.mapping], Q.metric_def if dfn else P.metric_def, clock=clock)
                    for mdl in (0, 1):
                        sc = score(models[Q.model if mdl else P.model], rows, clock)
                        sums, members = cohort_sums(rows, sc.F)
                        values[(cal, comp, data, mdl, dfn)] = sums
                        if cal == 0 and mdl == 0:
                            populations[(comp, data, dfn)] = members
    entries = []
    checks = []
    for cid, qrow in q_table.items():
        prow = p_table.get(cid)
        if prow is None or qrow["n"] < MIN_COMPARISON or prow["n"] < MIN_COMPARISON:
            continue
        step, _ = rounding_step(qrow["n"])

        def changed(a: tuple[int, int, int], b: tuple[int, int, int], cid: str = cid) -> int:
            x, y = populations[a].get(cid, set()), populations[b].get(cid, set())
            return len(x ^ y)

        people = {
            "calendar": 0,
            "model": 0,
            "composition": changed((0, 0, 0), (1, 0, 0)),
            "input_data": changed((0, 0, 0), (0, 1, 0)),
            "definition": changed((0, 0, 0), (0, 0, 1)),
        }
        for h in HORIZONS:

            def v(s: frozenset[str], h: int = h, cid: str = cid) -> float:
                key = tuple(int(f in s) for f in FACTORS)
                return values[key].get(cid, {}).get(h, 0.0)  # type: ignore[index]

            phi = shapley(FACTORS, v)
            v_none, v_all = v(frozenset()), v(frozenset(FACTORS))
            checks.append(
                abs(v_none - prow["horizons"][str(h)]["expected"]) + abs(v_all - qrow["horizons"][str(h)]["expected"])
            )
            merged = [f for f in ("composition", "input_data", "definition") if 0 < people[f] < 10]
            bars = []
            if merged:
                bars.append(
                    {
                        "factor": "time_and_population",
                        "label": MERGE_LABEL,
                        "phi": phi["calendar"] + sum(phi[f] for f in merged),
                        "merged_from": ["calendar", *merged],
                        "changed_people": None,
                    }
                )
            else:
                bars.append(
                    {
                        "factor": "calendar",
                        "label": LABELS["calendar"],
                        "phi": phi["calendar"],
                        "merged_from": [],
                        "changed_people": 0,
                    }
                )
            for f in ("composition", "input_data", "model", "definition"):
                if f in merged:
                    continue
                bars.append(
                    {
                        "factor": f,
                        "label": LABELS[f],
                        "phi": phi[f],
                        "merged_from": [],
                        "changed_people": people[f] if f != "model" else 0,
                    }
                )
            hz = qrow["horizons"][str(h)]
            entries.append(
                {
                    "cohort_id": cid,
                    "horizon": h,
                    "from_value": round_to_step(v_none, step),
                    "to_value": round_to_step(v_all, step),
                    "delta": round_to_step(v_all - v_none, step),
                    "interval80_width": float(hz["hi80"] - hz["lo80"]),
                    "factors": [dict(b, phi=round_to_step(b["phi"], step)) for b in bars],
                    "evaluations": [
                        {"key": "".join(str(int(f in s)) for f in FACTORS), "value": round_to_step(v(s), step)}
                        for s in _subsets()
                    ],
                    "step": step,
                    "_exact": {"delta": v_all - v_none, "phi_sum": sum(phi.values())},
                }
            )
    return {
        "label": "synthetic",
        "from": P.run_id,
        "to": Q.run_id,
        "entries": entries,
        "max_endpoint_error": max(checks) if checks else 0.0,
    }


def _subsets() -> list[frozenset[str]]:
    out = []
    for mask in range(32):
        out.append(frozenset(f for i, f in enumerate(FACTORS) if mask & (1 << i)))
    return out
