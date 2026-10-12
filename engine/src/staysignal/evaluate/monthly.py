"""Monthly pseudo-real-time backtests and their metrics (SPEC 10).

Origins are the first of each month from 2024-10-01 to 2026-09-01. At each origin the model is trained only on rows
matured by the origin with data as known at it (cached per origin), and the run keeps its simulated counts in memory.
A window (o, o + h] is scored only when mature (o + h + 75 days <= the outcome vintage); closed but immature windows
are provisional and left out of every headline number. Levels: company and organizations with n of at least 50.

Per level and horizon: MAE, RMSE and skill against `hist`; observed over expected; 80% and 95% coverage with a
moving-block bootstrap over consecutive origins (block length h) and the effective number of independent windows;
the interval score; the mean non-randomized PIT histogram and ranked probability score. For individuals at 3 months:
the reliability table by deciles of predicted cumulative incidence with team-cluster bootstrap intervals (only bins of
10 or more are kept), and ICI, E50 and E90. Synthetic world only; nothing individual is written."""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np

from staysignal.clock import OUTCOME_VINTAGE, add_months, as_cutoff_datetime
from staysignal.evaluate import metrics as m
from staysignal.evaluate.backtest import BACKTEST_MC, METRIC, model_for_origin, status_of
from staysignal.features.reference import PAYROLL_V1, Vintage, features_at, outcomes_at
from staysignal.forecast.cohorts import cohort_index
from staysignal.forecast.run import RunInputs, make_run
from staysignal.ingest.landing import Sources
from staysignal.privacy.suppression import MIN_COMPARISON

MONTHLY_ORIGINS = [add_months(date(2024, 10, 1), k) for k in range(24)]
HORIZONS = (1, 3, 6)


def backtest(
    src: Sources, start: date, cache: Path, world_sha: str, origins: list[date] | None = None, log=print
) -> dict:
    """Entries per origin, level and horizon, plus the 3-month individual predictions and outcomes (in memory)."""
    origins = origins or MONTHLY_ORIGINS
    vin_out = Vintage(src, OUTCOME_VINTAGE)
    entries: list[dict] = []
    indiv: list[tuple[float, int, str]] = []
    for o in origins:
        t0 = time.perf_counter()
        v = as_cutoff_datetime(o)
        model = model_for_origin(src, start, o, cache, world_sha)
        run = make_run(
            src, RunInputs(f"MBT-{o.isoformat()}", o, v, model, METRIC, "payroll@1", BACKTEST_MC), keep_draws=True
        )
        by_id = {r["cohort_id"]: r for r in run["cohorts"]}
        rows = features_at(Vintage(src, v), o, PAYROLL_V1, METRIC)
        outs = outcomes_at(vin_out, o, [r.employee_number for r in rows])
        for cohort, members in cohort_index(rows).items():
            if cohort.kind not in ("company", "organization") or len(members) < MIN_COMPARISON:
                continue
            for h in HORIZONS:
                end = add_months(o, h)
                actual = sum(
                    1
                    for i in members
                    if (oc := outs[rows[i].employee_number]).cause == "voluntary"
                    and oc.end is not None
                    and o < oc.end <= end
                )
                hz = by_id[cohort.id]["horizons"][str(h)]
                draws = run["_draws"][cohort.id][h]
                entries.append(
                    {
                        "origin": o.isoformat(),
                        "cohort": cohort.id,
                        "level": cohort.kind,
                        "n": len(members),
                        "horizon_months": h,
                        "status": status_of(o, h),
                        "actual": actual,
                        "expected": hz["expected"],
                        "hist_expected": hz["hist"]["expected"],
                        "i80": [hz["lo80"], hz["hi80"]],
                        "i95": [hz["lo95"], hz["hi95"]],
                        "pit": [m.pit_function(draws, actual, j / 10) for j in range(11)],
                        "rps": m.ranked_probability_score(draws, actual),
                    }
                )
        if status_of(o, 3) == "mature":
            ind = run["_individual"]
            for p3, en, team in zip(ind["p3"], ind["employee"], ind["team"], strict=True):
                oc = outs[en]
                hit = int(oc.cause == "voluntary" and oc.end is not None and o < oc.end <= add_months(o, 3))
                indiv.append((float(p3), hit, team))
        log(f"monthly backtest origin {o}: {time.perf_counter() - t0:.1f} s")
    return {"entries": entries, "individual": indiv, "origins": [o.isoformat() for o in origins]}


def _team_bootstrap(
    indiv: list[tuple[float, int, str]], bins: int = 10, n_boot: int = 300, seed: int = 0
) -> list[dict]:
    p = np.array([x[0] for x in indiv])
    y = np.array([x[1] for x in indiv], dtype=float)
    teams = np.array([x[2] for x in indiv])
    table = m.reliability_table(p, y, bins)
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    uniq = np.unique(teams)
    by_team = {t: np.flatnonzero(teams == t) for t in uniq}
    rng = np.random.default_rng(seed)
    obs = np.full((n_boot, bins), np.nan)
    for b in range(n_boot):
        pick = np.concatenate([by_team[t] for t in rng.choice(uniq, size=len(uniq))])
        for j in range(bins):
            sel = pick[idx[pick] == j]
            if len(sel):
                obs[b, j] = y[sel].mean()
    out = []
    for row in table:
        j = row["bin"] - 1
        if row["n"] < 10:
            continue
        col = obs[:, j][~np.isnan(obs[:, j])]
        out.append({**row, "observed_i80": [float(np.quantile(col, 0.1)), float(np.quantile(col, 0.9))]})
    return out


def summarize(bt: dict) -> dict:
    mature = [e for e in bt["entries"] if e["status"] == "mature"]
    by: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for e in mature:
        by[(e["level"], e["horizon_months"])].append(e)
    levels = {}
    for (level, h), es in sorted(by.items()):
        err = [e["expected"] - e["actual"] for e in es]
        err_hist = [e["hist_expected"] - e["actual"] for e in es]
        cov80, cov95 = (
            [float(m.covered(e["actual"], e["i80"])) for e in es],
            [float(m.covered(e["actual"], e["i95"])) for e in es],
        )
        # the block bootstrap runs over origins: one value per consecutive origin (the share of the level's cohorts
        # whose 80% range held at that origin), because the same people recur across overlapping windows
        per_origin: dict[str, list[float]] = defaultdict(list)
        for e in es:
            per_origin[e["origin"]].append(float(m.covered(e["actual"], e["i80"])))
        series = [float(np.mean(per_origin[o])) for o in sorted(per_origin)]
        n_origins = len({e["origin"] for e in es})
        pit = np.mean([np.diff(e["pit"]) for e in es], axis=0)
        levels[f"{level}|{h}"] = {
            "level": level,
            "horizon_months": h,
            "windows": len(es),
            "origins": n_origins,
            "effective_windows": m.effective_windows(n_origins, h),
            "mae": m.mae(err),
            "rmse": m.rmse(err),
            "mae_hist": m.mae(err_hist),
            "skill_vs_hist": m.skill(m.mae(err), m.mae(err_hist)),
            "observed_over_expected": m.observed_over_expected([e["actual"] for e in es], [e["expected"] for e in es]),
            "coverage80": float(np.mean(cov80)),
            "coverage95": float(np.mean(cov95)),
            "coverage80_block_i80": m.block_bootstrap(series, block=h),
            "interval_score80": float(np.mean([m.interval_score(e["actual"], e["i80"], 0.80) for e in es])),
            "interval_score95": float(np.mean([m.interval_score(e["actual"], e["i95"], 0.95) for e in es])),
            "pit_histogram": [float(x) for x in pit],
            "rps": float(np.mean([e["rps"] for e in es])),
        }
    indiv = bt["individual"]
    calib = {}
    if indiv:
        p = np.array([x[0] for x in indiv])
        y = np.array([x[1] for x in indiv], dtype=float)
        calib = {"n": len(indiv), "reliability": _team_bootstrap(indiv), **m.calibration_indices(p, y)}
    provisional = sum(1 for e in bt["entries"] if e["status"] == "provisional")
    return {"levels": levels, "calibration_3m": calib, "provisional_windows_excluded": provisional}


__all__ = ["MONTHLY_ORIGINS", "backtest", "summarize"]
