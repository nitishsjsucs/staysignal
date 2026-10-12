"""Model comparison on the same quarterly origins (SPEC 9.4, 10): the main model (`dtcr-mnl`) against `hist` (the
trailing-rate status quo), `aj` (Aalen-Johansen marginal cumulative incidence per organization) and `oracle` (the
forward simulation of the generator), at company and organization level, for voluntary departures under
voluntary_departures@2, with the actual counts of mature windows.

Every model sees data as known at the origin: the model is trained on rows matured by the origin (cached per origin),
`aj` is fitted on the same landmarks, `hist` uses the 12 months before the origin, and only the oracle knows more
than the origin's vintage (the true state). Synthetic world only."""

from __future__ import annotations

import time
from datetime import date
from pathlib import Path

from staysignal.baselines import aalen_johansen as aj
from staysignal.baselines import oracle as oracle_baseline
from staysignal.baselines.historical import hist_forecast, trailing_rates
from staysignal.clock import OUTCOME_VINTAGE, add_months, as_cutoff_datetime
from staysignal.evaluate.backtest import BACKTEST_MC, METRIC, QUARTERLY_ORIGINS, model_for_origin, status_of
from staysignal.features.reference import PAYROLL_V1, Vintage, features_at, outcomes_at
from staysignal.forecast.cohorts import cohort_index
from staysignal.forecast.run import RunInputs, make_run
from staysignal.ingest.landing import Sources
from staysignal.model.train import landmark_dates
from staysignal.world.spec import Profile

# the quarterly origins whose 6-month window is mature by the outcome vintage
COMPARISON_ORIGINS = [o for o in QUARTERLY_ORIGINS if status_of(o, 6) == "mature"]
HORIZONS = (1, 3, 6)
MODELS = ("dtcr-mnl", "hist", "aj", "oracle")


def compare(
    src: Sources,
    profile: Profile,
    start: date,
    cache: Path,
    world_sha: str,
    origins: list[date] | None = None,
    n_futures: int = 2000,
    workers: int | None = None,
    log=print,
) -> dict:
    origins = origins or COMPARISON_ORIGINS
    vin_out = Vintage(src, OUTCOME_VINTAGE)
    entries: list[dict] = []
    for o in origins:
        t0 = time.perf_counter()
        v = as_cutoff_datetime(o)
        vin = Vintage(src, v)
        model = model_for_origin(src, start, o, cache, world_sha)
        run = make_run(src, RunInputs(f"CMP-{o.isoformat()}", o, v, model, METRIC, "payroll@1", BACKTEST_MC))
        by_id = {r["cohort_id"]: r for r in run["cohorts"]}
        rows = features_at(vin, o, PAYROLL_V1, METRIC)
        outs = outcomes_at(vin_out, o, [r.employee_number for r in rows])
        rates = trailing_rates(vin, o, METRIC)
        ajm = aj.fit(src, o, v, landmark_dates(start, o), METRIC)
        orc = oracle_baseline.forecasts(profile, o, METRIC, n_futures=n_futures, workers=workers)
        for cohort, members in cohort_index(rows).items():
            if cohort.kind not in ("company", "organization"):
                continue
            n = len(members)
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
                hf = hist_forecast(rates.get(cohort.id, {}).get("annual_rate", 0.0), n, h)
                af = ajm.forecast(cohort.id, n, h)
                of = orc.get(cohort.id, {}).get(h)
                entries.append(
                    {
                        "origin": o.isoformat(),
                        "cohort": cohort.id,
                        "n": n,
                        "horizon_months": h,
                        "status": status_of(o, h),
                        "actual": actual,
                        "dtcr-mnl": {
                            "expected": hz["expected"],
                            "i80": [hz["lo80"], hz["hi80"]],
                            "i95": [hz["lo95"], hz["hi95"]],
                        },
                        "hist": {
                            "expected": hf["expected"],
                            "i80": [hf["lo80"], hf["hi80"]],
                            "i95": [hf["lo95"], hf["hi95"]],
                        },
                        "aj": af,
                        "oracle": None if of is None else {k: of[k] for k in ("expected", "i80", "i95", "n")},
                    }
                )
        log(f"comparison origin {o}: {time.perf_counter() - t0:.1f} s")
    return {
        "label": "synthetic world; the oracle knows the latent propensities and the generator, no model can",
        "metric_def": METRIC,
        "origins": [o.isoformat() for o in origins],
        "models": list(MODELS),
        "entries": entries,
    }


__all__ = ["COMPARISON_ORIGINS", "HORIZONS", "MODELS", "compare"]
