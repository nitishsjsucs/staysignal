"""Exports the published layer as committed API fixtures (SPEC 5 `test/fixtures/api/`, 16.4).

Fixtures are what the API serves in fixtures mode (CI e2e and the fixtures deployment): cohort aggregates only, with
cells under 10 absent and every served value already disclosure-rounded (SPEC 17.5). The Worker's guard rounds again,
which is idempotent. Full-precision values exist only inside the business-result hash of each run manifest.
"""

from __future__ import annotations

import json
from pathlib import Path

from staysignal.privacy.suppression import round_share, round_to_step, rounding_step

PROVISIONAL = "provisional: computed on the canonical world before its calibration is frozen (SPEC 6.3)"


def slug(run_id: str) -> str:
    return run_id.replace("#", "-")


def rounded_cohort(row: dict) -> dict:
    n = row["n"]
    step, band = rounding_step(n)
    out = {
        "cohort_id": row["cohort_id"],
        "kind": row["kind"],
        "name": row["name"],
        "parent": row["parent"],
        "n": n,
        "rounding": {"step": step, "band": band},
    }
    for k in ("joiners", "leavers", "n_previous"):
        if k in row:
            out[k] = row[k]
    hz = {}
    for h, e in row["horizons"].items():
        item = {
            "expected": round_to_step(e["expected"], step),
            "i80": [e["lo80"], e["hi80"]],
            "i95": [e["lo95"], e["hi95"]],
            "variance": {k: round_share(v) for k, v in e["variance_shares"].items()},
            "hist": {
                "expected": round_to_step(e["hist"]["expected"], step),
                "annual_rate": round(e["hist"]["annual_rate"], 3),
                "i80": [int(e["hist"]["lo80"]), int(e["hist"]["hi80"])],
            },
        }
        if "other" in e:
            o = e["other"]
            item["other"] = {
                "expected": round_to_step(o["expected"], step),
                "i80": [o["lo80"], o["hi80"]],
                "i95": [o["lo95"], o["hi95"]],
            }
        hz[h] = item
    out["horizons"] = hz
    out["curve"] = [
        {k: (round_to_step(v, step) if k in ("vol", "other") else v) for k, v in pt.items()} for pt in row["curve"]
    ]
    return out


def run_brief(run: dict, status: str, version: int, extra: dict | None = None) -> dict:
    brief = {
        "run_id": run["run_id"],
        "version": version,
        "status": status,
        "label": "synthetic",
        "cutoff": run["cutoff"],
        "vintage": run["vintage"],
        "model": run["model_version"],
        "model_sha256": run["model_sha256"],
        "metric_def": run["metric_def"],
        "mapping": run["mappings"]["payroll"],
        "run_key": run["run_key"],
        "result_hash": run["result_hash"],
        "prediction_vector_sha256": run["prediction_vector_sha256"],
        "population": run["population"],
        "mc_config": run["mc_config"],
    }
    brief.update(extra or {})
    return brief


def write_json(path: Path, obj: object, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (
        json.dumps(obj, sort_keys=True, separators=(",", ":")) if compact else json.dumps(obj, indent=1, sort_keys=True)
    )
    path.write_text(text + "\n", encoding="utf-8")


def export_run(out: Path, run: dict, status: str, version: int, extra: dict | None = None) -> dict:
    brief = run_brief(run, status, version, extra)
    write_json(
        out / "forecast" / f"{slug(run['run_id'])}.json",
        {
            "run": brief,
            "label": "synthetic",
            "provisional": PROVISIONAL,
            "cohorts": [rounded_cohort(r) for r in run["cohorts"]],
        },
        compact=True,
    )
    return brief
