"""Quarterly pseudo-real-time backtests for the history strip (SPEC 10): at each origin the model is trained only on
rows matured by the origin, with data as known at the origin (real-time vintages), and scored under the current
metric definition. A window (o, o + h] is mature when o + h + 75 days <= the outcome vintage; closed but immature
windows are provisional actuals; everything is synthetic. Not forecasts that were published."""

from __future__ import annotations

import json
import time
from datetime import date, datetime, timedelta
from pathlib import Path

from staysignal.clock import OUTCOME_VINTAGE, REPORTING_BUFFER_DAYS, add_months, as_cutoff_datetime
from staysignal.features.reference import PAYROLL_V1, Vintage, features_at, outcomes_at
from staysignal.forecast.cohorts import cohort_index
from staysignal.forecast.montecarlo import McConfig
from staysignal.forecast.run import RunInputs, make_run
from staysignal.ingest.landing import Sources
from staysignal.model import artifact as artifact_io
from staysignal.model.train import train
from staysignal.privacy.suppression import MIN_COMPARISON, round_to_step, rounding_step

QUARTERLY_ORIGINS = [
    date(2024, 10, 1),
    date(2025, 1, 1),
    date(2025, 4, 1),
    date(2025, 7, 1),
    date(2025, 10, 1),
    date(2026, 1, 1),
    date(2026, 4, 1),
    date(2026, 7, 1),
]
BACKTEST_MC = McConfig(n_theta=10, n_org=5, n_team=10)
METRIC = "voluntary_departures@2"


def status_of(origin: date, h: int) -> str:
    end = add_months(origin, h)
    if (
        datetime(end.year, end.month, end.day, tzinfo=OUTCOME_VINTAGE.tzinfo) + timedelta(days=REPORTING_BUFFER_DAYS)
        <= OUTCOME_VINTAGE
    ):
        return "mature"
    if datetime(end.year, end.month, end.day, tzinfo=OUTCOME_VINTAGE.tzinfo) <= OUTCOME_VINTAGE:
        return "provisional"
    return "pending"


def model_for_origin(src: Sources, start: date, origin: date, cache: Path, world_sha: str) -> artifact_io.Model:
    path = cache / f"bt-{origin.isoformat()}-{world_sha[:12]}" / "model.json"
    if not path.exists():
        art = train(src, start, origin, as_cutoff_datetime(origin), f"bt{origin.isoformat()}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(art))
    return artifact_io.load(path)


def quarterly_backtests(src: Sources, start: date, cache: Path, world_sha: str, log=print) -> dict:
    vin_out = Vintage(src, OUTCOME_VINTAGE)
    series: dict[str, dict[str, list[dict]]] = {}
    prev_members: dict[str, set[str]] = {}
    for origin in QUARTERLY_ORIGINS:
        t0 = time.perf_counter()
        model = model_for_origin(src, start, origin, cache, world_sha)
        v = as_cutoff_datetime(origin)
        run = make_run(src, RunInputs(f"BT-{origin.isoformat()}", origin, v, model, METRIC, "payroll@1", BACKTEST_MC))
        rows = features_at(Vintage(src, v), origin, PAYROLL_V1, METRIC)
        outs = outcomes_at(vin_out, origin, [r.employee_number for r in rows])
        idx = cohort_index(rows)
        for cohort, members in idx.items():
            if cohort.kind not in ("company", "organization", "group") or len(members) < MIN_COMPARISON:
                continue
            row = next(r for r in run["cohorts"] if r["cohort_id"] == cohort.id)
            people = {rows[i].employee_number for i in members}
            before = prev_members.get(cohort.id)
            changed = len(people ^ before) if before is not None else None
            prev_members[cohort.id] = people
            step, _ = rounding_step(len(members))
            for h in (1, 3, 6):
                end = add_months(origin, h)
                actual = sum(
                    1
                    for i in members
                    if (o := outs[rows[i].employee_number]).cause == "voluntary"
                    and o.end is not None
                    and origin < o.end <= end
                )
                hz = row["horizons"][str(h)]
                st = status_of(origin, h)
                point = {
                    "origin": origin.isoformat(),
                    "expected": round_to_step(hz["expected"], step),
                    "i80": [hz["lo80"], hz["hi80"]],
                    "i95": [hz["lo95"], hz["hi95"]],
                    "actual": actual if st != "pending" else None,
                    "actual_status": st,
                    "published_run_id": None,
                    "omitted_reason": "DIFFERENCING_RISK" if changed is not None and 0 < changed < 10 else None,
                    "n": len(members),
                }
                series.setdefault(cohort.id, {}).setdefault(str(h), []).append(point)
        log(f"backtest origin {origin}: {time.perf_counter() - t0:.1f} s")
    return {
        "label": "synthetic",
        "note": "Pseudo-real-time backtest: model and data as known at each cutoff, not forecasts that were published. Synthetic world.",
        "definition_change": "2026-09-20: voluntary_departures@2 excludes fixed-term employees; all history is computed under @2",
        "series": series,
    }


def add_published(history: dict, runs: list[dict]) -> None:
    """Marks the published runs on the strip with their own values (actuals pending or provisional)."""
    for run in runs:
        for row in run["cohorts"]:
            s = history["series"].get(row["cohort_id"])
            if s is None:
                continue
            step, _ = rounding_step(row["n"])
            for h in ("1", "3", "6"):
                hz = row["horizons"][h]
                st = status_of(date.fromisoformat(run["cutoff"]), int(h))
                s.setdefault(h, []).append(
                    {
                        "origin": run["cutoff"],
                        "expected": round_to_step(hz["expected"], step),
                        "i80": [hz["lo80"], hz["hi80"]],
                        "i95": [hz["lo95"], hz["hi95"]],
                        "actual": None,
                        "actual_status": "pending" if st == "pending" else "provisional",
                        "published_run_id": run["run_id"],
                        "omitted_reason": None,
                        "n": row["n"],
                        "definition_break": run["metric_def"].endswith("@1"),
                    }
                )


def trust_summary(history: dict) -> dict:
    """Backtest O/E and 80% coverage on mature, non-omitted quarterly windows, per cohort and horizon."""
    out: dict[str, dict[str, dict]] = {}
    for cid, by_h in history["series"].items():
        for h, pts in by_h.items():
            mature = [
                p
                for p in pts
                if p["actual_status"] == "mature"
                and p["actual"] is not None
                and not p["omitted_reason"]
                and not p["published_run_id"]
            ]
            if not mature:
                continue
            exp = sum(p["expected"] for p in mature)
            act = sum(p["actual"] for p in mature)
            held = sum(1 for p in mature if p["i80"][0] <= p["actual"] <= p["i80"][1])
            out.setdefault(cid, {})[h] = {
                "oe": round(act / exp, 2) if exp > 0 else None,
                "coverage80": {"held": held, "windows": len(mature)},
                "effective_windows": len(mature) if int(h) <= 3 else len(mature) // 2,
            }
    return out
