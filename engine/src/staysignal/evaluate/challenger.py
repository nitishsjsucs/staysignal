"""The challenger on the model comparison's origins (SPEC 9.4, C15): `survivalboost` (with Poisson-binomial and
shock-aware intervals) and a like-for-like `dtcr-mnl-12k` fitted on the same sampled person-landmarks, scored on the
same six quarterly origins, cohorts, horizons and actual counts as `evaluate/comparison.py`. Every model sees data as
known at the origin. Needs the uv extra `challenger`. Synthetic world only."""

from __future__ import annotations

import json
import time
from datetime import date
from pathlib import Path

import numpy as np

from staysignal.baselines import survivalboost as sb
from staysignal.clock import OUTCOME_VINTAGE, add_months, as_cutoff_datetime
from staysignal.evaluate.backtest import BACKTEST_MC, METRIC, model_for_origin, status_of
from staysignal.evaluate.comparison import COMPARISON_ORIGINS, HORIZONS
from staysignal.features.reference import PAYROLL_V1, Vintage, features_at, outcomes_at
from staysignal.forecast.cohorts import cohort_index
from staysignal.forecast.run import RunInputs, make_run
from staysignal.ingest.landing import Sources
from staysignal.model import artifact as artifact_io
from staysignal.model.train import assemble, collect_landmarks, fit_artifact, landmark_dates

MODELS = ("survivalboost", "survivalboost-shock", "dtcr-mnl-12k")


def run_origin(
    src: Sources,
    start: date,
    origin: date,
    cache: Path,
    world_sha: str,
    n_iter: int = sb.N_ITER,
    cap: int = sb.ROW_CAP,
    shock_draws: int = 2000,
    log=print,
) -> tuple[list[dict], dict]:
    t0 = time.perf_counter()
    v = as_cutoff_datetime(origin)
    seed = sb.seed_for(origin)
    lms = sb.quarterly_landmarks(landmark_dates(start, origin))
    collected = collect_landmarks(src, start, origin, v, landmarks=lms)
    eligible = sum(len(c.rows) for c in collected)
    chosen = sb.sample(collected, cap, seed)
    vin_o = Vintage(src, v)
    outs = [outcomes_at(vin_o, c.s, [r.employee_number for r in c.rows]) for c in chosen]
    orgs = sorted({r.org for c in chosen for r in c.rows})
    rows = sb.survival_rows(chosen, outs, orgs)
    t_fit = time.perf_counter()
    model = sb.fit(rows, n_iter=n_iter, seed=seed)
    sb_seconds = time.perf_counter() - t_fit

    # the like-for-like main model on the same people
    path = cache / f"cmp12k-{origin.isoformat()}-{world_sha[:12]}-{cap}" / "model.json"
    if not path.exists():
        art = fit_artifact(assemble(chosen), origin, v, f"cmp12k{origin.isoformat()}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(art))
    small = artifact_io.load(path)
    run12 = make_run(src, RunInputs(f"CMP12K-{origin.isoformat()}", origin, v, small, METRIC, "payroll@1", BACKTEST_MC))
    by_id = {r["cohort_id"]: r for r in run12["cohorts"]}

    shocks = json.loads((cache / f"bt-{origin.isoformat()}-{world_sha[:12]}" / "model.json").read_text())["shocks"]
    pred_rows = features_at(vin_o, origin, PAYROLL_V1, METRIC)
    vin_out = Vintage(src, OUTCOME_VINTAGE)
    actual_outs = outcomes_at(vin_out, origin, [r.employee_number for r in pred_rows])
    Xp = np.array([sb.raw_features(r, origin, orgs) for r in pred_rows], dtype=float)
    cif = sb.voluntary_cif(model, Xp, [sb.horizon_days(origin, h) for h in HORIZONS])
    org_of = np.array([r.org for r in pred_rows])
    team_of = np.array([r.team for r in pred_rows])
    entries = []
    for cohort, members in cohort_index(pred_rows).items():
        if cohort.kind not in ("company", "organization"):
            continue
        idx = np.asarray(members)
        for hi, h in enumerate(HORIZONS):
            end = add_months(origin, h)
            actual = sum(
                1
                for i in members
                if (oc := actual_outs[pred_rows[i].employee_number]).cause == "voluntary"
                and oc.end is not None
                and origin < oc.end <= end
            )
            p = cif[idx, hi]
            hz = by_id[cohort.id]["horizons"][str(h)]
            entries.append(
                {
                    "origin": origin.isoformat(),
                    "cohort": cohort.id,
                    "n": len(members),
                    "horizon_months": h,
                    "status": status_of(origin, h),
                    "actual": actual,
                    "survivalboost": sb.poisson_binomial_forecast(p),
                    "survivalboost-shock": sb.shock_forecast(
                        p,
                        org_of[idx],
                        team_of[idx],
                        shocks.get("sigma_org_draws", []),
                        shocks.get("sigma_team_draws", []),
                        draws=shock_draws,
                        seed=seed + hi,
                    ),
                    "dtcr-mnl-12k": {
                        "expected": hz["expected"],
                        "i80": [hz["lo80"], hz["hi80"]],
                        "i95": [hz["lo95"], hz["hi95"]],
                    },
                }
            )
    info = {
        "origin": origin.isoformat(),
        "landmarks": [s.isoformat() for s in lms],
        "eligible_person_landmarks": eligible,
        "rows": int(rows.X.shape[0]),
        "events": {
            c: int((rows.event == k).sum()) for k, c in ((1, "voluntary"), (2, "involuntary"), (3, "retirement"))
        },
        "survivalboost_fit_seconds": round(sb_seconds, 1),
        "seconds": round(time.perf_counter() - t0, 1),
    }
    log(
        f"challenger origin {origin}: {info['rows']} rows, fit {info['survivalboost_fit_seconds']} s, total {info['seconds']} s"
    )
    return entries, info


def run_challenger(
    src: Sources,
    start: date,
    cache: Path,
    world_sha: str,
    origins: list[date] | None = None,
    n_iter: int = sb.N_ITER,
    cap: int = sb.ROW_CAP,
    shock_draws: int = 2000,
    log=print,
) -> dict:
    origins = origins or COMPARISON_ORIGINS
    entries: list[dict] = []
    per_origin: list[dict] = []
    for o in origins:
        model_for_origin(src, start, o, cache, world_sha)  # the main model's shock estimates for the shock variant
        es, info = run_origin(src, start, o, cache, world_sha, n_iter, cap, shock_draws, log)
        entries += es
        per_origin.append(info)
    return {"origins": [o.isoformat() for o in origins], "models": list(MODELS), "fits": per_origin, "entries": entries}


__all__ = ["MODELS", "run_challenger", "run_origin"]
