"""Training the landmark competing-risks model (SPEC 9.1) and writing its artifact (SPEC 9.6).

Training set for training cutoff T: monthly landmarks s from the first complete landmark; each employee in the
population at (s, v_s = s) contributes calendar-month periods j = 1..6 after s until the first event or censoring.
Row (s, j) is included only when period j ends at least 75 days before T (the matured rule), with features from
vintage s and outcomes from vintage T. People whose spell at s turns out (as known at T) to have ended before s are
dropped from that landmark.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta

import numpy as np

from staysignal.clock import REPORTING_BUFFER_DAYS, add_months, as_cutoff_datetime
from staysignal.features.reference import FeatureRow, Vintage, features_at, outcomes_at
from staysignal.ingest.landing import Sources
from staysignal.model import mnl
from staysignal.model.design import (
    CAUSES,
    PERIODS,
    DesignSpec,
    expand,
    ft_bands,
    landmark_block,
    standardize,
    standardize_fit,
)
from staysignal.model.shocks import estimate_shocks

LAMBDA = 1.0
CAUSE_CODE = {"voluntary": 0, "involuntary": 1, "retirement": 2}


@dataclass
class Landmark:
    s: date
    rows: list[FeatureRow]


@dataclass
class TrainingSet:
    X: np.ndarray  # raw design (n, p)
    Y: np.ndarray  # (n, 3) one-hot
    clusters: np.ndarray
    landmark_index: np.ndarray  # row -> landmark ordinal
    period: np.ndarray
    person: np.ndarray  # row -> person key index within its landmark list
    spec: DesignSpec
    landmarks: list[dict]
    lm_rows: list[Landmark]


def first_landmark(start: date) -> date:
    return add_months(start, 6)


def landmark_dates(start: date, T: date, buffer_days: int = REPORTING_BUFFER_DAYS) -> list[date]:
    out = []
    s = first_landmark(start)
    while add_months(s, 1) + timedelta(days=buffer_days) <= T:
        out.append(s)
        s = add_months(s, 1)
    return out


@dataclass
class Collected:
    """One landmark's eligible people before assembly: rows, matured periods per person, and per-period causes
    (-1 for a stay)."""

    s: date
    rows: list[FeatureRow]
    periods: list[int]
    causes: list[list[int]]


def collect_landmarks(
    src: Sources,
    start: date,
    T: date,
    vintage_T: datetime,
    buffer_days: int = REPORTING_BUFFER_DAYS,
    landmarks: list[date] | None = None,
    feature_cache: dict[date, list[FeatureRow]] | None = None,
) -> list[Collected]:
    """`feature_cache` (landmark -> rows) lets callers that collect the same sources at many cutoffs compute each
    landmark's features once; features at a landmark depend only on that landmark's vintage."""
    vin_T = Vintage(src, vintage_T)
    lms = landmarks if landmarks is not None else landmark_dates(start, T, buffer_days)
    out: list[Collected] = []
    for s in lms:
        if feature_cache is not None and s in feature_cache:
            rows = feature_cache[s]
        else:
            rows = features_at(Vintage(src, as_cutoff_datetime(s)), s)
            if feature_cache is not None:
                feature_cache[s] = rows
        outs = outcomes_at(vin_T, s, [r.employee_number for r in rows])
        kept: list[FeatureRow] = []
        periods: list[int] = []
        causes: list[list[int]] = []
        for r in rows:
            o = outs[r.employee_number]
            if o.cause == "not_employed":
                continue
            ps, cs = [], []
            for j in range(1, PERIODS + 1):
                lo, hi = add_months(s, j - 1), add_months(s, j)
                if hi + timedelta(days=buffer_days) > T:
                    break
                ps.append(j)
                if o.end is not None and lo < o.end <= hi:
                    cs.append(CAUSE_CODE[o.cause or "involuntary"])
                    break
                cs.append(-1)
            if ps:
                kept.append(r)
                periods.append(len(ps))
                causes.append(cs)
        out.append(Collected(s, kept, periods, causes))
    return out


def build_training(
    src: Sources,
    start: date,
    T: date,
    vintage_T: datetime,
    buffer_days: int = REPORTING_BUFFER_DAYS,
    landmarks: list[date] | None = None,
) -> TrainingSet:
    return assemble(collect_landmarks(src, start, T, vintage_T, buffer_days, landmarks))


def assemble(collected: list[Collected]) -> TrainingSet:
    """The person-period training set from collected landmarks (a subset of people is fine: the design spec, knots
    and standardization come from the rows given)."""
    lms = [c.s for c in collected]
    lm_rows = [Landmark(c.s, c.rows) for c in collected]
    per_lm = [(c.rows, c.periods, c.causes) for c in collected]
    all_rows = [r for lm in lm_rows for r in lm.rows]
    spec = DesignSpec.build(all_rows)
    blocks, fts, per, mon, ys, cl, lmi, pidx = [], [], [], [], [], [], [], []
    team_codes: dict[str, int] = {}
    manifest = []
    for li, (s, (kept, periods, causes)) in enumerate(zip(lms, per_lm, strict=True)):
        if not kept:
            continue
        L = landmark_block(kept, spec.knots)
        F = np.array([ft_bands(r) for r in kept], dtype=float)
        n_rows = sum(periods)
        idx = np.repeat(np.arange(len(kept)), periods)
        blocks.append(L[idx])
        fts.append(F[idx])
        jj = np.concatenate([np.arange(1, n + 1) for n in periods])
        per.append(jj)
        mon.append(np.array([add_months(s, int(j) - 1).month for j in jj]))
        y = np.zeros((n_rows, 3))
        flat = [c for cs in causes for c in cs]
        for i, c in enumerate(flat):
            if c >= 0:
                y[i, c] = 1.0
        ys.append(y)
        cl.append(np.array([team_codes.setdefault(kept[i].team, len(team_codes)) for i in idx]))
        lmi.append(np.full(n_rows, li))
        pidx.append(idx)
        manifest.append(
            {
                "landmark": s.isoformat(),
                "people": len(kept),
                "rows": int(n_rows),
                "events": {c: int(y[:, k].sum()) for k, c in enumerate(CAUSES)},
            }
        )
    X = expand(np.vstack(blocks), np.vstack(fts), np.concatenate(per), np.concatenate(mon), spec)
    standardize_fit(X, spec)
    return TrainingSet(
        X=X,
        Y=np.vstack(ys),
        clusters=np.concatenate(cl),
        landmark_index=np.concatenate(lmi),
        period=np.concatenate(per),
        person=np.concatenate(pidx),
        spec=spec,
        landmarks=manifest,
        lm_rows=lm_rows,
    )


def packing(spec: DesignSpec) -> mnl.Packing:
    return mnl.Packing(
        p=len(spec.columns), masks=[np.array(spec.masks[c]) for c in CAUSES], penalized=np.array(spec.penalized)
    )


def _round(x: float, digits: int = 12) -> float:
    return float(f"{x:.{digits}g}")


def train(src: Sources, start: date, T: date, vintage_T: datetime, version: str, mapping: str = "payroll@1") -> dict:
    t0 = time.perf_counter()
    return fit_artifact(build_training(src, start, T, vintage_T), T, vintage_T, version, mapping, t0)


def fit_artifact(
    ts: TrainingSet,
    T: date,
    vintage_T: datetime,
    version: str,
    mapping: str = "payroll@1",
    t0: float | None = None,
    theta0: np.ndarray | None = None,
    ftol: float = 1e-15,
) -> dict:
    """Fits the model on a training set and returns the artifact (SPEC 9.6). `theta0` warm-starts the optimizer (the
    research benchmark passes the previous origin's fit); the optimum and its tolerance are the same."""
    t0 = time.perf_counter() if t0 is None else t0
    Xs = standardize(ts.X, ts.spec)
    pk = packing(ts.spec)
    res = mnl.fit(Xs, ts.Y, pk, lam=LAMBDA, theta0=theta0, ftol=ftol)
    V = mnl.cluster_sandwich(res.theta, Xs, ts.Y, ts.clusters, pk, LAMBDA)
    shocks = estimate_shocks(ts, Xs, res.theta, pk, seed=int(hashlib.sha256(version.encode()).hexdigest()[:8], 16))
    names = []
    for c in CAUSES:
        names += [f"{c}:{ts.spec.columns[i]}" for i in ts.spec.masks[c]]
    artifact = {
        "kind": "staysignal-model",
        "model": "dtcr-mnl",
        "version": version,
        "label": "synthetic",
        "training_cutoff": T.isoformat(),
        "data_vintage": vintage_T.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "mapping": mapping,
        "lambda": LAMBDA,
        "buffer_days": REPORTING_BUFFER_DAYS,
        "design": {
            "columns": ts.spec.columns,
            "knots": [_round(k) for k in ts.spec.knots],
            "mean": [_round(m) for m in ts.spec.mean],
            "scale": [_round(s) for s in ts.spec.scale],
            "masks": ts.spec.masks,
            "penalized": ts.spec.penalized,
        },
        "parameters": names,
        "theta": [_round(x) for x in res.theta.tolist()],
        "covariance": [[_round(x) for x in row] for row in V.tolist()],
        "fit": {
            "loglik": _round(res.loglik),
            "iterations": res.iterations,
            "newton_steps": res.newton_steps,
            "grad_max": _round(res.grad_max, 4),
            "converged": res.converged,
            "rows": int(ts.X.shape[0]),
            "clusters": int(ts.clusters.max() + 1),
            "events": {c: int(ts.Y[:, k].sum()) for k, c in enumerate(CAUSES)},
        },
        "shocks": shocks,
        "training_landmarks": ts.landmarks,
        "feature_spec_sha256": feature_spec_sha256(),
    }
    artifact["artifact_sha256"] = artifact_sha256(artifact)
    artifact["provenance"] = {"fit_seconds": round(time.perf_counter() - t0, 2)}
    return artifact


def artifact_sha256(artifact: dict) -> str:
    body = {k: v for k, v in artifact.items() if k not in ("provenance", "artifact_sha256")}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


from staysignal.features.spec import feature_spec_sha256  # noqa: E402
