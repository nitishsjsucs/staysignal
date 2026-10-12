"""Recorded evaluation results (SPEC 10): `staysignal eval backtest` writes `results/backtest-<date>.json`,
`results/calibration-<date>.json` and `results/model-comparison-<date>.json`, each with its command, date, world hash
and the synthetic-world label; `npm run results:readme` renders them. Only cohort aggregates (company and
organizations of 50 or more) and calibration bins of 10 or more are written."""

from __future__ import annotations

import datetime as dt
import json
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from staysignal.evaluate import metrics as m
from staysignal.evaluate.comparison import MODELS, compare
from staysignal.evaluate.monthly import backtest, summarize
from staysignal.ingest.landing import load_world_sources
from staysignal.world.spec import PROFILES

LABEL = "synthetic world: these numbers test the pipeline and the uncertainty method, not real-world accuracy"


def comparison_summary(cmp: dict) -> dict:
    by: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for e in cmp["entries"]:
        if e["status"] == "mature":
            by[("company" if e["cohort"] == "company" else "organization", e["horizon_months"])].append(e)
    out = {}
    for (level, h), es in sorted(by.items()):
        row = {"level": level, "horizon_months": h, "windows": len(es)}
        for model in MODELS:
            fs = [(e[model], e["actual"]) for e in es if e[model] is not None]
            if not fs:
                continue
            err = [f["expected"] - a for f, a in fs]
            row[model] = {
                "mae": m.mae(err),
                "rmse": m.rmse(err),
                "observed_over_expected": m.observed_over_expected([a for _, a in fs], [f["expected"] for f, _ in fs]),
                "coverage80": float(np.mean([m.covered(a, f["i80"]) for f, a in fs])),
                "coverage95": float(np.mean([m.covered(a, f["i95"]) for f, a in fs])),
                "interval_score80": float(np.mean([m.interval_score(a, f["i80"], 0.80) for f, a in fs])),
            }
        out[f"{level}|{h}"] = row
    return out


def run_all(world: Path, cache: Path, out_dir: Path, n_futures: int, workers: int | None, log=print) -> list[Path]:
    profile = PROFILES["canonical"]
    manifest = json.loads((world / "manifest.json").read_text())
    sha = manifest["world_sha256"]
    src = load_world_sources(world)
    date = dt.date.today().isoformat()
    base = {"date": date, "world_sha256": sha, "label": LABEL}
    t0 = time.perf_counter()
    bt = backtest(src, profile.start, cache, sha, log=log)
    s = summarize(bt)
    entries = [{k: v for k, v in e.items() if k not in ("pit",)} for e in bt["entries"]]
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    p = out_dir / f"backtest-{date}.json"
    p.write_text(
        json.dumps(
            {
                "kind": "backtest",
                "command": "uv run --project engine staysignal eval backtest",
                **base,
                "design": "monthly pseudo-real-time origins 2024-10-01 to 2026-09-01; model and data as known at each origin; mature windows only (o + h + 75 days <= 2026-10-01); company and organizations with n >= 50; voluntary_departures@2",
                "levels": s["levels"],
                "provisional_windows_excluded": s["provisional_windows_excluded"],
                "seconds": round(time.perf_counter() - t0, 1),
                "entries": entries,
            },
            indent=1,
        )
        + "\n"
    )
    paths.append(p)
    p = out_dir / f"calibration-{date}.json"
    p.write_text(
        json.dumps(
            {
                "kind": "calibration",
                "command": "uv run --project engine staysignal eval backtest",
                **base,
                "design": "individual predicted 3-month voluntary cumulative incidence at mature monthly origins against observed departures; deciles; team-cluster bootstrap 80% intervals; bins with n >= 10 only",
                **s["calibration_3m"],
            },
            indent=1,
        )
        + "\n"
    )
    paths.append(p)
    t1 = time.perf_counter()
    cmp = compare(src, profile, profile.start, cache, sha, n_futures=n_futures, workers=workers, log=log)
    p = out_dir / f"model-comparison-{date}.json"
    p.write_text(
        json.dumps(
            {
                "kind": "model-comparison",
                "command": f"uv run --project engine staysignal eval backtest --futures {n_futures}",
                **base,
                "design": "the six quarterly origins whose 6-month window is mature; company and organizations; voluntary_departures@2; every model sees data as known at the origin except the oracle, which knows the true state",
                "origins": cmp["origins"],
                "models": cmp["models"],
                "summary": comparison_summary(cmp),
                "seconds": round(time.perf_counter() - t1, 1),
                "entries": cmp["entries"],
            },
            indent=1,
        )
        + "\n"
    )
    paths.append(p)
    return paths


def latest(results: Path, kind: str) -> dict | None:
    files = sorted(results.glob(f"{kind}-*.json"))
    return json.loads(files[-1].read_text()) if files else None


def evaluation_fixture(results: Path) -> dict | None:
    """The Trust page's data (the API's `evaluation.json`), assembled from the latest recorded results."""
    bt, cal, cmp = latest(results, "backtest"), latest(results, "calibration"), latest(results, "model-comparison")
    if bt is None or cmp is None:
        return None
    keep = (
        "origin",
        "cohort",
        "level",
        "n",
        "horizon_months",
        "status",
        "actual",
        "expected",
        "hist_expected",
        "i80",
        "i95",
    )
    return {
        "label": LABEL,
        "date": bt["date"],
        "commands": sorted({bt["command"], cmp["command"]} | ({cal["command"]} if cal else set())),
        "world_sha256": bt["world_sha256"],
        "backtest": {
            "design": bt["design"],
            "levels": bt["levels"],
            "provisional_windows_excluded": bt["provisional_windows_excluded"],
            "entries": [{k: e[k] for k in keep} for e in bt["entries"]],
        },
        "calibration": None
        if cal is None
        else {k: cal[k] for k in ("design", "n", "ici", "e50", "e90", "reliability")},
        "comparison": {k: cmp[k] for k in ("design", "origins", "models", "summary")},
    }


__all__ = ["comparison_summary", "evaluation_fixture", "latest", "run_all"]
