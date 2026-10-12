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


def run_effects(world: Path, models: Path, out_dir: Path, log=print) -> Path:
    """Partial dependence for the current published run's population (R-2026-10-01#1 inputs), recorded in results/."""
    from datetime import UTC, date, datetime

    from staysignal.evaluate.effects import partial_dependence
    from staysignal.features.reference import MAPPINGS, Vintage, features_at
    from staysignal.model import artifact as artifact_io

    t0 = time.perf_counter()
    manifest = json.loads((world / "manifest.json").read_text())
    src = load_world_sources(world)
    c = date(2026, 10, 1)
    rows = features_at(
        Vintage(src, datetime(2026, 10, 1, 6, tzinfo=UTC)), c, MAPPINGS["payroll@1"], "voluntary_departures@2"
    )
    model = artifact_io.load(models / "m2026.09" / "model.json")
    effects = partial_dependence(model, rows, c)
    day = dt.date.today().isoformat()
    p = out_dir / f"effects-{day}.json"
    p.write_text(
        json.dumps(
            {
                "kind": "effects",
                "command": "uv run --project engine staysignal eval effects",
                "date": day,
                "world_sha256": manifest["world_sha256"],
                "label": LABEL,
                "design": "partial dependence of the mean 3-month voluntary cumulative incidence over the population at 2026-10-01 (model m2026.09, voluntary_departures@2), one feature set to each grid value at a time; 80% bands from 20 parameter draws; associational, not causal",
                "population": len(rows),
                "effects": effects,
                "seconds": round(time.perf_counter() - t0, 1),
            },
            indent=1,
        )
        + "\n"
    )
    log(f"effects: {len(effects)} features, {time.perf_counter() - t0:.1f} s")
    return p


def latest(results: Path, kind: str) -> dict | None:
    files = sorted(results.glob(f"{kind}-*.json"))
    return json.loads(files[-1].read_text()) if files else None


def evaluation_fixture(results: Path) -> dict | None:
    """The Trust page's data (the API's `evaluation.json`), assembled from the latest recorded results."""
    bt, cal, cmp = latest(results, "backtest"), latest(results, "calibration"), latest(results, "model-comparison")
    eff = latest(results, "effects")
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
        "commands": sorted(
            {bt["command"], cmp["command"]}
            | ({cal["command"]} if cal else set())
            | ({eff["command"]} if eff else set())
        ),
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
        "effects": None if eff is None else {k: eff[k] for k in ("design", "population", "effects")},
    }


__all__ = ["comparison_summary", "evaluation_fixture", "latest", "run_all", "run_effects"]
