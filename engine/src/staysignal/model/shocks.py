"""Shared-shock estimator (SPEC 9.3): effective team overdispersion and the organization-wide shock.

On quarter-aligned 3-month windows of the training data, with O observed, E = sum F and V = sum F(1 - F) per
team-quarter (F is the fitted 3-month voluntary cumulative incidence),
  V_hat = max(0, sum((O - E)^2 - V) / sum(E^2))   estimates Var(u),
and because Var(u) = exp(sigma^2) - 1 for a mean-one lognormal, sigma_team = sqrt(log(1 + V_hat)). The organization
estimate uses company-wide quarters after subtracting the team component. Contagion also adds overdispersion, so the
team value is labeled effective team overdispersion. Both carry a bootstrap distribution (team-quarters and quarters
resampled), and the Monte Carlo draws sigma from it.
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from staysignal.clock import add_months
from staysignal.model import mnl
from staysignal.model.design import expand, ft_bands, landmark_block, standardize


def v_hat(O: np.ndarray, E: np.ndarray, V: np.ndarray) -> float:
    den = float((E * E).sum())
    return max(0.0, float(((O - E) ** 2 - V).sum()) / den) if den > 0 else 0.0


def v_hat_org(Oq: np.ndarray, Eq: np.ndarray, Vq: np.ndarray, E2q: np.ndarray, vt: float) -> float:
    den = float((Eq * Eq).sum())
    return max(0.0, float(((Oq - Eq) ** 2 - Vq - vt * E2q).sum()) / den) if den > 0 else 0.0


def sigma_of(v: float) -> float:
    return math.sqrt(math.log1p(v))


def window_units(
    ts, Xs: np.ndarray, theta: np.ndarray, pk: mnl.Packing
) -> tuple[list[tuple[int, str, float, float, float]], list[int]]:
    """(quarter ordinal, team, O, E, V) per team-quarter, from quarter-start landmarks whose three periods matured."""
    B = pk.unpack(theta)
    units: list[tuple[int, str, float, float, float]] = []
    quarters: list[int] = []
    for li, lm in enumerate(ts.lm_rows):
        if lm.s.month not in (1, 4, 7, 10) or not lm.rows:
            continue
        sel = ts.landmark_index == li
        if not (ts.period[sel] == 3).any():
            continue
        n = len(lm.rows)
        L = landmark_block(lm.rows, ts.spec.knots)
        F = np.array([ft_bands(r) for r in lm.rows], dtype=float)
        idx = np.repeat(np.arange(n), 3)
        per = np.tile(np.arange(1, 4), n)
        mon = np.array([add_months(lm.s, int(j) - 1).month for j in per])
        X = standardize(expand(L[idx], F[idx], per, mon, ts.spec), ts.spec)
        P = mnl.probabilities(X, B).reshape(n, 3, 3)
        surv = np.cumprod(1.0 - P.sum(axis=2), axis=1)
        prev = np.concatenate([np.ones((n, 1)), surv[:, :2]], axis=1)
        f_vol = (P[:, :, 0] * prev).sum(axis=1)
        obs = np.zeros(n)
        rows = np.where(sel & (ts.period <= 3) & (ts.Y[:, 0] == 1))[0]
        for r in rows:
            obs[ts.person[r]] = 1.0
        by_team: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
        for i, row in enumerate(lm.rows):
            acc = by_team[row.team]
            acc[0] += obs[i]
            acc[1] += f_vol[i]
            acc[2] += f_vol[i] * (1.0 - f_vol[i])
        q = len(quarters)
        quarters.append(li)
        for team in sorted(by_team):
            o, e, v = by_team[team]
            units.append((q, team, o, e, v))
    return units, quarters


def estimate_shocks(ts, Xs: np.ndarray, theta: np.ndarray, pk: mnl.Packing, seed: int, draws: int = 200) -> dict:
    units, quarters = window_units(ts, Xs, theta, pk)
    if not units:
        return {
            "sigma_team": 0.0,
            "sigma_org": 0.0,
            "sigma_team_draws": [0.0],
            "sigma_org_draws": [0.0],
            "team_quarters": 0,
            "quarters": 0,
            "note": "no matured quarter-aligned windows",
        }
    q_idx = np.array([u[0] for u in units])
    O = np.array([u[2] for u in units])
    E = np.array([u[3] for u in units])
    V = np.array([u[4] for u in units])
    nq = len(quarters)

    def org_parts(o: np.ndarray, e: np.ndarray, v: np.ndarray, q: np.ndarray):
        Oq, Eq, Vq, E2q = (np.zeros(nq) for _ in range(4))
        np.add.at(Oq, q, o)
        np.add.at(Eq, q, e)
        np.add.at(Vq, q, v)
        np.add.at(E2q, q, e * e)
        return Oq, Eq, Vq, E2q

    vt = v_hat(O, E, V)
    Oq, Eq, Vq, E2q = org_parts(O, E, V, q_idx)
    vo = v_hat_org(Oq, Eq, Vq, E2q, vt)
    rng = np.random.default_rng(seed)
    st, so = [], []
    for _ in range(draws):
        pick = rng.integers(0, len(units), len(units))
        vt_b = v_hat(O[pick], E[pick], V[pick])
        qpick = rng.integers(0, nq, nq)
        vo_b = v_hat_org(Oq[qpick], Eq[qpick], Vq[qpick], E2q[qpick], vt_b)
        st.append(round(sigma_of(vt_b), 6))
        so.append(round(sigma_of(vo_b), 6))
    return {
        "sigma_team": round(sigma_of(vt), 6),
        "sigma_org": round(sigma_of(vo), 6),
        "var_u_hat": round(vt, 6),
        "var_w_hat": round(vo, 6),
        "sigma_team_draws": st,
        "sigma_org_draws": so,
        "team_quarters": len(units),
        "quarters": nq,
        "label": "effective team overdispersion (team shocks and contagion); organization shock from about one window per quarter",
    }
