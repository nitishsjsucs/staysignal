"""The research runner (SPEC 11): for each seed, build the worlds of `arms.PLANS`, fit the model once per origin and
handling (parameters from the sandwich covariance, warm-started from the previous origin), score each origin with
the nested Monte Carlo of 9.3 (shock-aware: all layers; independence: process and parameter layers only), and
compare with the generator's clean final truth. One checkpoint file per seed, so an interrupted run resumes.

Features come from the Python reference (`features/reference.py`), which `pit.sql` reproduces exactly (feature test
17): fast enough that the planned SQL fast path was not needed (a deviation logged in the pre-registration).
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import replace
from pathlib import Path

import numpy as np

from staysignal.clock import add_months, as_cutoff_datetime
from staysignal.features.reference import Vintage, features_at
from staysignal.forecast.montecarlo import McConfig, run_mc
from staysignal.forecast.score import score
from staysignal.model import artifact as artifact_io
from staysignal.model.train import assemble, collect_landmarks, fit_artifact
from staysignal.research.arms import HORIZON, ORIGINS, PLANS, SMALL_ORIGINS, Handling
from staysignal.research.handling import censor_month, duplicate_exits
from staysignal.research.world import ResearchWorld, build, true_voluntary_exit

MC = McConfig(n_theta=10, n_org=5, n_team=10)
# L-BFGS-B stops at a relative objective change of 1e-7 and the Newton polish takes the gradient under 1e-10: the same
# optimum as the main model's 1e-15 (parameters agree to about 1e-13) in a quarter of the time
FTOL = 1e-7
TEAM_MIN = 10  # team cohorts for H3b: at least 10 people at the origin
TEAM_CONDITIONS = {"shock_0", "shock_0.25", "shock_0.5"}


def _seed(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:8], 16)


def no_shocks(model: artifact_io.Model) -> artifact_io.Model:
    return replace(
        model,
        shocks={
            **model.shocks,
            "sigma_team": 0.0,
            "sigma_org": 0.0,
            "sigma_team_draws": [0.0],
            "sigma_org_draws": [0.0],
        },
    )


def training_set(world: ResearchWorld, origin, h: Handling, cache: dict | None = None):
    v = as_cutoff_datetime(origin)
    col = collect_landmarks(world.src, world.profile.start, origin, v, buffer_days=h.buffer_days, feature_cache=cache)
    if h.missing == "censored" and world.missing_month is not None:
        col = censor_month(col, world.missing_month)
    if not h.dedupe and world.duplicated:
        col = duplicate_exits(col, world.duplicated)
    return assemble(col)


def evaluate(world: ResearchWorld, model: artifact_io.Model, origin, h: Handling, teams: bool) -> list[dict]:
    rows = features_at(Vintage(world.src, as_cutoff_datetime(origin)), origin)
    scored = score(model, rows, origin)
    end = add_months(origin, HORIZON)
    cohorts: list[tuple[str, str, list[int]]] = [("company", "company", list(range(len(rows))))]
    by_org: dict[str, list[int]] = {}
    by_team: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        by_org.setdefault(r.org, []).append(i)
        by_team.setdefault(r.team, []).append(i)
    cohorts += [(f"org:{o}", "organization", idx) for o, idx in sorted(by_org.items())]
    if teams:
        cohorts += [(f"team:{t}", "team", idx) for t, idx in sorted(by_team.items()) if len(idx) >= TEAM_MIN]
    members = np.zeros((len(cohorts), len(rows)))
    for ci, (_, _, idx) in enumerate(cohorts):
        members[ci, idx] = 1.0
    exits = np.array([true_voluntary_exit(world.truth, r.employee_number, origin, end) for r in rows], dtype=float)
    observed = members @ exits
    expected = members @ scored.F[:, HORIZON - 1, 0]
    out = []
    for interval in h.intervals:
        m = model if interval == "shock_aware" else no_shocks(model)
        seed = _seed(world.seed, world.condition.name, h.name, interval, origin)
        mc = run_mc(m, scored.X, [r.team for r in rows], origin, members, seed, MC, keep_counts=True)
        counts = mc.vol_counts[:, :, HORIZON - 1]  # (sims, C)
        rng = np.random.default_rng(seed)
        for ci, (cid, level, idx) in enumerate(cohorts):
            y = observed[ci]
            sims = counts[:, ci]
            f_y = float((sims <= y).mean())
            f_y1 = float((sims <= y - 1).mean())
            q = mc.vol_q[ci, HORIZON - 1]
            out.append(
                {
                    "condition": world.condition.name,
                    "fit": h.name,
                    "interval": interval,
                    "origin": origin.isoformat(),
                    "cohort": cid,
                    "level": level,
                    "n": len(idx),
                    "expected": round(float(expected[ci]), 6),
                    "observed": int(y),
                    "i80": [float(q[1]), float(q[2])],
                    "i95": [float(q[0]), float(q[3])],
                    "pit": round(f_y1 + float(rng.random()) * (f_y - f_y1), 6),
                }
            )
    return out


def run_seed(seed: int, small: bool = False, origins=None, log=print) -> dict:
    origins = origins or (SMALL_ORIGINS if small else ORIGINS)
    t0 = time.perf_counter()
    rows: list[dict] = []
    conditions: dict[str, dict] = {}
    for plan in PLANS:
        tw = time.perf_counter()
        world = build(seed, plan.condition, small)
        cache: dict = {}  # landmark features of this world, shared by its handlings and origins
        conditions[plan.condition.name] = {
            "changed_records": world.changed_records,
            "missing_month": world.missing_month,
        }
        for h in plan.handlings:
            theta0 = None
            for o in origins:
                v = as_cutoff_datetime(o)
                ts = training_set(world, o, h, cache)
                art = fit_artifact(
                    ts,
                    o,
                    v,
                    f"research-{seed}-{plan.condition.name}-{h.name}-{o.isoformat()}",
                    theta0=theta0,
                    ftol=FTOL,
                )
                theta0 = np.array(art["theta"])
                rows += evaluate(world, artifact_io.from_dict(art), o, h, teams=plan.condition.name in TEAM_CONDITIONS)
        conditions[plan.condition.name]["seconds"] = round(time.perf_counter() - tw, 1)
        log(f"seed {seed} {plan.condition.name}: {conditions[plan.condition.name]['seconds']} s")
    return {
        "seed": seed,
        "small": small,
        "origins": [o.isoformat() for o in origins],
        "conditions": conditions,
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }


def checkpoint_path(out_dir: Path, seed: int) -> Path:
    return out_dir / f"seed-{seed:02d}.json"


def run_seeds(
    seeds: list[int], out_dir: Path, small: bool = False, n_origins: int | None = None, log=print
) -> list[dict]:
    """Runs (or resumes) the seeds, one checkpoint file per seed."""
    out_dir.mkdir(parents=True, exist_ok=True)
    origins = (SMALL_ORIGINS if small else ORIGINS)[: n_origins or None]
    done = []
    for s in seeds:
        path = checkpoint_path(out_dir, s)
        if path.exists():
            doc = json.loads(path.read_text())
            if doc.get("origins") == [o.isoformat() for o in origins]:
                log(f"seed {s}: resumed from {path.name}")
                done.append(doc)
                continue
        doc = run_seed(s, small, origins, log)
        path.write_text(json.dumps(doc) + "\n")
        log(f"seed {s}: {doc['seconds']} s")
        done.append(doc)
    return done


__all__ = ["MC", "evaluate", "no_shocks", "run_seed", "run_seeds", "training_set"]
