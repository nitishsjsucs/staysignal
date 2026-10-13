"""Ground-truth recovery (SPEC 6.7, 9.1, C6): does the estimator recover a correctly specified truth?

The `recovery` world switches off everything the model cannot see (latent propensity, the tenure by level
interaction, drift, shocks) and makes the promotion effect an exact step, so the generator's hazards are exactly a
multinomial logit in the encodings below. Every person-month of the simulation is a period-1 row of the landmark at
the start of that month; the simulator records its hazard inputs and outcome directly (`Simulator.recorder`), so the
design uses the generator's own encodings, not the warehouse features. An unpenalized fit with the cluster-robust
sandwich (clusters: teams) must pass three checks:

(a) a joint Wald test of the voluntary slope vector against the truth at alpha 0.01;
(b) at least 85% of all slopes inside their 95% Wald intervals;
(c) the correct sign for every slope whose true value is at least 3 standard errors from zero.

Synthetic world only; this tests the estimator, not any claim about real workforces.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from scipy.stats import chi2

from staysignal.model import mnl
from staysignal.world import hazards
from staysignal.world.simulate import Simulator
from staysignal.world.spec import RECOVERY, Profile

ALPHA = 0.01
COVERAGE_MIN = 0.85
SIGN_SE = 3.0
Z95 = 1.959963984540054

FAMILIES = tuple(sorted(hazards.JOB_FAMILY_VOL))  # every other family is the reference (true effect 0)
MONTHS = tuple(sorted(hazards.MONTH_VOL))
LEVELS = ("early", "senior", "manager")  # reference: mid


@dataclass(frozen=True)
class Column:
    name: str
    vol: float | None  # true coefficient for voluntary, None when the column is not in that cause
    inv: float | None = None
    ret: float | None = None


def _columns() -> list[Column]:
    i = hazards.INTERCEPTS
    cols = [
        Column("intercept", i["vol"], i["inv"], i["ret"]),
        *(Column(f"month_{m:02d}", hazards.MONTH_VOL[m]) for m in MONTHS),
        Column("tenure_lt12", 0.15, 0.50),
        Column("tenure_12_24", 0.40),
        Column("tenure_24_48", 0.20),
        Column("tenure_ge84", -0.40),  # reference: 48 to 84 months
        Column("time_in_role_gt30", 0.20),
        Column("since_promotion_ge24", 0.30),
        Column("first_promotion_gt36", 0.15),
        Column("manager_changes_180d", 0.25, 0.10),
        Column("below_midpoint", 4.0),
        Column("above_midpoint", -1.0),
        Column("prior_team_rate", 2.5),
        Column("reorg_90d", 0.35, 0.60),
        *(Column(f"family_{f}", hazards.JOB_FAMILY_VOL[f]) for f in FAMILIES),
        *(Column(f"level_{b}", hazards.LEVEL_BAND_VOL[b], 0.20 if b == "early" else None) for b in LEVELS),
        Column("fixed_term", -0.30),
        Column("age_over_55", None, None, 0.35),
    ]
    return cols


COLUMNS = _columns()
CAUSES = ("vol", "inv", "ret")


def encode(x: hazards.HazardInputs) -> list[float]:
    """One design row in COLUMNS order: the generator's own encodings of its hazard inputs."""
    t = x.tenure_months
    row = [1.0]
    row += [1.0 if x.calendar_month == m else 0.0 for m in MONTHS]
    row += [float(t < 12), float(12 <= t < 24), float(24 <= t < 48), float(t >= 84)]
    row += [
        float(x.time_in_role_months > 30),
        float(x.months_since_promotion >= 24),
        float(x.first_promotion_months is not None and x.first_promotion_months > 36),
        float(min(x.manager_changes_180d, 3)),
        max(0.0, 1.0 - x.compa_ratio),
        min(max(0.0, x.compa_ratio - 1.0), 0.5),
        x.prior_team_rate,
        float(x.reorg_90d),
    ]
    row += [1.0 if x.job_family == f else 0.0 for f in FAMILIES]
    row += [1.0 if x.level_band == b else 0.0 for b in LEVELS]
    row += [float(x.fixed_term), max(0.0, x.age_years - 55.0)]
    return row


def packing() -> mnl.Packing:
    masks = [np.array([j for j, c in enumerate(COLUMNS) if getattr(c, k) is not None]) for k in CAUSES]
    return mnl.Packing(p=len(COLUMNS), masks=masks, penalized=np.zeros(len(COLUMNS), dtype=bool))


def truth_vector(pk: mnl.Packing) -> np.ndarray:
    return np.concatenate([[getattr(COLUMNS[j], k) for j in m] for k, m in zip(CAUSES, pk.masks, strict=True)])


@dataclass
class RecoveryData:
    X: np.ndarray
    Y: np.ndarray
    clusters: np.ndarray
    seconds: float


def simulate(profile: Profile = RECOVERY) -> RecoveryData:
    """Runs the generator with the recorder on and encodes each month's rows as it goes (bounded memory)."""
    t0 = time.perf_counter()
    sim = Simulator(profile)
    sim.write_payroll = False
    sim.recorder = []
    sim.setup()
    blocks: list[np.ndarray] = []
    outcomes: list[np.ndarray] = []
    teams: list[str] = []
    for _ in range(profile.months):
        sim.step()
        blocks.append(np.array([encode(x) for x, _, _ in sim.recorder], dtype=np.float64))
        outcomes.append(np.array([o for _, o, _ in sim.recorder], dtype=np.int8))
        teams += [t for _, _, t in sim.recorder]
        sim.recorder.clear()
    X = np.vstack(blocks)
    out = np.concatenate(outcomes)
    Y = np.zeros((len(out), 3))
    for k in range(3):
        Y[out == k + 1, k] = 1.0
    codes = {t: i for i, t in enumerate(sorted(set(teams)))}
    clusters = np.array([codes[t] for t in teams], dtype=np.int64)
    return RecoveryData(X, Y, clusters, time.perf_counter() - t0)


def fit(data: RecoveryData) -> tuple[np.ndarray, np.ndarray, bool, float, float]:
    """The unpenalized fit and its cluster-robust covariance: (theta, V, converged, grad_max, seconds)."""
    pk = packing()
    t0 = time.perf_counter()
    f = mnl.fit(data.X, data.Y, pk, lam=0.0, gtol=1e-8)
    V = mnl.cluster_sandwich(f.theta, data.X, data.Y, data.clusters, pk, lam=0.0)
    return f.theta, V, f.converged, f.grad_max, time.perf_counter() - t0


def param_names() -> list[str]:
    pk = packing()
    return [f"{k}:{COLUMNS[j].name}" for k, m in zip(CAUSES, pk.masks, strict=True) for j in m]


def check(data: RecoveryData, targets: dict | None = None) -> dict:
    """The fit, the cluster-robust covariance and the three checks, as a JSON-ready report. Against the generator's
    truth by default; with `targets` (from `marginal_targets`, the shock-world variant) against those estimates,
    with their own covariance added to the fit's, since the targets are estimates too."""
    pk = packing()
    theta, V, converged, grad_max, fit_seconds = fit(data)
    truth = truth_vector(pk)
    if targets is not None:
        if targets["params"] != param_names():
            raise ValueError("the cached targets were fitted with a different design; regenerate them")
        truth = np.array(targets["theta"])
        V = V + np.array(targets["cov"])
    se = np.sqrt(np.diag(V))
    params = []
    o = 0
    for k, m in zip(CAUSES, pk.masks, strict=True):
        for j in m:
            params.append({"cause": k, "column": COLUMNS[j].name, "intercept": COLUMNS[j].name == "intercept", "i": o})
            o += 1
    slopes = [q for q in params if not q["intercept"]]
    vol = [q["i"] for q in slopes if q["cause"] == "vol"]
    d = theta[vol] - truth[vol]
    wald = float(d @ np.linalg.solve(V[np.ix_(vol, vol)], d))
    p_value = float(chi2.sf(wald, df=len(vol)))
    rows = []
    for q in slopes:
        i = q["i"]
        inside = abs(theta[i] - truth[i]) <= Z95 * se[i]
        signed = abs(truth[i]) >= SIGN_SE * se[i]
        rows.append(
            {
                "cause": q["cause"],
                "column": q["column"],
                "truth": float(truth[i]),
                "estimate": round(float(theta[i]), 6),
                "se": round(float(se[i]), 6),
                "inside_95": bool(inside),
                "sign_checked": bool(signed),
                "sign_ok": bool(not signed or np.sign(theta[i]) == np.sign(truth[i])),
            }
        )
    coverage = sum(r["inside_95"] for r in rows) / len(rows)
    signs_checked = [r for r in rows if r["sign_checked"]]
    return {
        "rows": int(data.X.shape[0]),
        "events": {c: int(data.Y[:, k].sum()) for k, c in enumerate(("voluntary", "involuntary", "retirement"))},
        "clusters": int(data.clusters.max()) + 1,
        "simulate_seconds": round(data.seconds, 1),
        "fit_seconds": round(fit_seconds, 1),
        "converged": converged,
        "grad_max": grad_max,
        "wald": {"statistic": round(wald, 4), "df": len(vol), "p_value": round(p_value, 6), "alpha": ALPHA},
        "coverage_95": {"inside": sum(r["inside_95"] for r in rows), "slopes": len(rows), "share": round(coverage, 4)},
        "signs": {"checked": len(signs_checked), "correct": sum(r["sign_ok"] for r in signs_checked)},
        "passed": {
            "wald": p_value >= ALPHA,
            "coverage": coverage >= COVERAGE_MIN,
            "signs": all(r["sign_ok"] for r in rows),
        },
        "slopes": rows,
    }


def marginal_targets(data: RecoveryData) -> dict:
    """The shock-world targets (SPEC 9.1): the same unpenalized fit on a large world with team shocks, with its
    cluster-robust covariance. Cached in results/ by `staysignal eval recovery-shock --targets`."""
    theta, V, converged, grad_max, seconds = fit(data)
    if not converged:
        raise RuntimeError(f"the targets fit did not converge (max gradient {grad_max:.2e})")
    return {
        "params": param_names(),
        "theta": [round(float(x), 10) for x in theta],
        "cov": [[float(x) for x in row] for row in V],
        "rows": int(data.X.shape[0]),
        "clusters": int(data.clusters.max()) + 1,
        "simulate_seconds": round(data.seconds, 1),
        "fit_seconds": round(seconds, 1),
    }


__all__ = [
    "COLUMNS",
    "RecoveryData",
    "check",
    "encode",
    "fit",
    "marginal_targets",
    "packing",
    "param_names",
    "simulate",
    "truth_vector",
]
