"""Forecast runs (SPEC 9.6): run keys, cohort tables, the business-result hash, the prediction-vector hash and the
population change against the previous published run. Individual cumulative incidences exist only in this job's
memory; the run keeps cohort aggregates and hashes (ADR 0014).
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime

import numpy as np

from staysignal.baselines.historical import hist_forecast, trailing_rates
from staysignal.canonical import canonical_json, canonical_sha256, micro
from staysignal.clock import add_months, iso_z
from staysignal.features.reference import MAPPINGS, FeatureRow, Vintage, features_at
from staysignal.forecast.cohorts import Cohort, cohort_index, sort_key
from staysignal.forecast.montecarlo import McConfig, run_mc
from staysignal.forecast.score import score
from staysignal.ingest.landing import Sources
from staysignal.model.artifact import Model
from staysignal.privacy.pseudo import engine_pseudonymizer

HORIZONS = (1, 3, 6)
OTHER_KINDS = ("company", "organization")


@dataclass
class RunInputs:
    run_id: str
    cutoff: date
    vintage: datetime
    model: Model
    metric_def: str
    mapping: str
    mc: McConfig = McConfig()


def input_hash(src: Sources) -> str:
    return canonical_sha256(sorted([name, h] for name, h in src.file_hashes.items()))


def run_key(inp: RunInputs, src: Sources) -> str:
    """SHA-256 of the canonical inputs; no code version, time or randomness (ADR 0017)."""
    return canonical_sha256(
        {
            "cutoff": inp.cutoff.isoformat(),
            "vintage": iso_z(inp.vintage),
            "inputs": input_hash(src),
            "mappings": {"payroll": inp.mapping},
            "model_sha256": inp.model.sha256,
            "metric_def": inp.metric_def,
            "mc_config": inp.mc.as_dict(),
        }
    )


def seed_of(key: str) -> int:
    return int.from_bytes(bytes.fromhex(key)[:8], "big")


def population(src: Sources, cutoff: date, vintage: datetime, metric_def: str, mapping: str) -> list[FeatureRow]:
    return features_at(Vintage(src, vintage), cutoff, MAPPINGS[mapping], metric_def)


def prediction_vector_sha256(rows: list[FeatureRow], F: np.ndarray) -> str:
    pz = engine_pseudonymizer()
    items = []
    for i, r in enumerate(rows):
        pid = pz.pseudonym("employee_ref", r.employee_number)
        for k, cause in enumerate(("voluntary", "involuntary", "retirement")):
            for h in HORIZONS:
                items.append(f"{pid}|{cause}|{h}|{F[i, h - 1, k]:.9f}")
    items.sort()
    return hashlib.sha256("\n".join(items).encode()).hexdigest()


def membership(rows: list[FeatureRow]) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for cohort, idx in cohort_index(rows).items():
        out[cohort.id] = {rows[i].employee_number for i in idx}
    return out


def make_run(src: Sources, inp: RunInputs, prev_rows: list[FeatureRow] | None = None) -> dict:
    vin = Vintage(src, inp.vintage)
    rows = features_at(vin, inp.cutoff, MAPPINGS[inp.mapping], inp.metric_def)
    scored = score(inp.model, rows, inp.cutoff)
    cohorts = cohort_index(rows)
    ids = sorted(cohorts, key=lambda c: sort_key(c.id))
    members = np.zeros((len(ids), len(rows)))
    for ci, c in enumerate(ids):
        members[ci, cohorts[c]] = 1.0
    key = run_key(inp, src)
    mc = run_mc(inp.model, scored.X, [r.team for r in rows], inp.cutoff, members, seed_of(key), inp.mc)
    rates = trailing_rates(vin, inp.cutoff, inp.metric_def)
    prev = membership(prev_rows) if prev_rows is not None else None
    cur = {c.id: {rows[i].employee_number for i in cohorts[c]} for c in ids}
    table = []
    business = []
    pv = scored.F[:, :, 0]
    po = scored.F[:, :, 1] + scored.F[:, :, 2]
    for ci, c in enumerate(ids):
        idx = cohorts[c]
        n = len(idx)
        exp_vol = pv[idx].sum(axis=0)  # (6,)
        exp_oth = po[idx].sum(axis=0)
        var = mc.variance[ci]
        horizons = {}
        for h in HORIZONS:
            q = mc.vol_q[ci, h - 1]
            tot = float(var[h - 1].sum()) or 1.0
            r = rates.get(c.id, {"annual_rate": 0.0})
            entry = {
                "expected": float(exp_vol[h - 1]),
                "lo95": int(q[0]),
                "lo80": int(q[1]),
                "hi80": int(q[2]),
                "hi95": int(q[3]),
                "mc_mean": float(mc.vol_mean[ci, h - 1]),
                "variance_shares": {
                    k: float(var[h - 1, j] / tot)
                    for j, k in enumerate(("parameter", "org_shock", "team_shock", "process"))
                },
                "hist": hist_forecast(r["annual_rate"], n, h),
            }
            business.append(
                {
                    "cohort": c.id,
                    "horizon": h,
                    "cause": "voluntary",
                    "expected_micro": micro(entry["expected"]),
                    "lo80": entry["lo80"],
                    "hi80": entry["hi80"],
                    "lo95": entry["lo95"],
                    "hi95": entry["hi95"],
                }
            )
            if c.kind in OTHER_KINDS:
                qo = mc.other_q[ci, h - 1]
                entry["other"] = {
                    "expected": float(exp_oth[h - 1]),
                    "lo95": int(qo[0]),
                    "lo80": int(qo[1]),
                    "hi80": int(qo[2]),
                    "hi95": int(qo[3]),
                }
                business.append(
                    {
                        "cohort": c.id,
                        "horizon": h,
                        "cause": "other",
                        "expected_micro": micro(entry["other"]["expected"]),
                        "lo80": int(qo[1]),
                        "hi80": int(qo[2]),
                        "lo95": int(qo[0]),
                        "hi95": int(qo[3]),
                    }
                )
            horizons[str(h)] = entry
        curve = []
        for j in range(6):
            q = mc.vol_q[ci, j]
            point = {
                "month": j + 1,
                "date": add_months(inp.cutoff, j + 1).isoformat(),
                "vol": float(exp_vol[j]),
                "vol_lo80": int(q[1]),
                "vol_hi80": int(q[2]),
                "vol_lo95": int(q[0]),
                "vol_hi95": int(q[3]),
            }
            if c.kind in OTHER_KINDS:
                point["other"] = float(exp_oth[j])
            curve.append(point)
        row = {
            "cohort_id": c.id,
            "kind": c.kind,
            "name": c.name,
            "parent": c.parent,
            "n": n,
            "horizons": horizons,
            "curve": curve,
        }
        if prev is not None:
            before = prev.get(c.id, set())
            row["joiners"] = len(cur[c.id] - before)
            row["leavers"] = len(before - cur[c.id])
            row["n_previous"] = len(before)
        table.append(row)
    business.sort(key=lambda b: (b["cohort"], b["horizon"], b["cause"]))
    return {
        "run_id": inp.run_id,
        "run_key": key,
        "label": "synthetic",
        "cutoff": inp.cutoff.isoformat(),
        "vintage": iso_z(inp.vintage),
        "model_version": inp.model.version,
        "model_sha256": inp.model.sha256,
        "metric_def": inp.metric_def,
        "mappings": {"payroll": inp.mapping},
        "mc_config": inp.mc.as_dict(),
        "mc_seed": str(seed_of(key)),
        "input_hash": input_hash(src),
        "population": len(rows),
        "result_hash": canonical_sha256(business),
        "prediction_vector_sha256": prediction_vector_sha256(rows, scored.F),
        "cohorts": table,
        "business_result": business,
    }


__all__ = ["Cohort", "HORIZONS", "RunInputs", "canonical_json", "make_run", "population", "run_key"]
