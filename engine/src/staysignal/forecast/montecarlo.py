"""Uncertainty by nested Monte Carlo (SPEC 9.3): parameters, organization and team shocks per calendar quarter, and
the monthly process, in a nested design (default 20 parameter draws x 10 organization-shock draws x 20 team-shock
draws, one process path each).

1. Parameters: draws from N(theta_hat, V_cluster); with each draw, sigma_team and sigma_org are drawn from their
   bootstrap distributions, so the uncertainty in the sigmas widens the interval.
2. Shocks: for every calendar quarter the window touches, one organization shock w_q and one team shock u_{t,q} per
   team, lognormal with mean 1, multiplying the voluntary hazard in the months of that quarter.
3. Process: each person's monthly outcome drawn sequentially.

The variance of a cohort's count is decomposed exactly by the law of total variance over the nested layers, using
the analytic conditional mean and Poisson-binomial variance given (theta, w, u).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from staysignal.clock import add_months, quarter_of
from staysignal.forecast.score import cumulative
from staysignal.model.artifact import Model

PERIODS = 6


@dataclass(frozen=True)
class McConfig:
    n_theta: int = 20
    n_org: int = 10
    n_team: int = 20

    def as_dict(self) -> dict:
        return {"n_theta": self.n_theta, "n_org": self.n_org, "n_team": self.n_team, "design": "nested", "version": 1}


@dataclass
class McResult:
    # per cohort (C), month (6): quantiles of simulated counts for voluntary and other exits
    vol_q: np.ndarray  # (C, 6, 4) lo95, lo80, hi80, hi95
    other_q: np.ndarray  # (C, 6, 4)
    vol_mean: np.ndarray  # (C, 6) Monte Carlo mean count
    variance: np.ndarray  # (C, 6, 4) parameter, org shock, team shock, process (voluntary)
    sims: int
    vol_counts: np.ndarray | None = None  # (sims, C, 6) simulated counts, kept only for evaluation (never persisted)


def mvn_draws(rng: np.random.Generator, mean: np.ndarray, cov: np.ndarray, n: int) -> np.ndarray:
    vals, vecs = np.linalg.eigh((cov + cov.T) / 2.0)
    root = vecs * np.sqrt(np.clip(vals, 0.0, None))
    return mean + rng.standard_normal((n, len(mean))) @ root.T


def _agg(a: np.ndarray, Mt: np.ndarray) -> np.ndarray:
    """(U, n, 6) per-person values -> (U, C, 6) cohort sums, through BLAS matmul."""
    return np.matmul(a.transpose(0, 2, 1), Mt).transpose(0, 2, 1)


def run_mc(
    model: Model,
    X: np.ndarray,
    teams: list[str],
    window_start,
    members: np.ndarray,
    seed: int,
    cfg: McConfig | None = None,
    keep_counts: bool = False,
) -> McResult:
    """X: (n, 6, p) standardized design; members: (C, n) 0/1 cohort membership matrix. `keep_counts` returns the
    simulated cohort counts for evaluation (PIT and RPS); they are never written anywhere."""
    cfg = cfg or McConfig()
    rng = np.random.default_rng(seed)
    n = X.shape[0]
    C = members.shape[0]
    team_ids = sorted(set(teams))
    team_code = np.array([team_ids.index(t) for t in teams])
    quarters = [quarter_of(add_months(window_start, j)) for j in range(PERIODS)]
    q_ids = sorted(set(quarters))
    q_of_month = np.array([q_ids.index(q) for q in quarters])
    thetas = mvn_draws(rng, model.theta, model.cov, cfg.n_theta)
    st_draws = np.array(model.shocks.get("sigma_team_draws") or [model.shocks.get("sigma_team", 0.0)])
    so_draws = np.array(model.shocks.get("sigma_org_draws") or [model.shocks.get("sigma_org", 0.0)])
    Xf = X.reshape(n * PERIODS, -1)
    sims = cfg.n_theta * cfg.n_org * cfg.n_team
    vol_counts = np.zeros((sims, C, PERIODS), dtype=np.float32)
    oth_counts = np.zeros((sims, C, PERIODS), dtype=np.float32)
    m_cond = np.zeros((cfg.n_theta, cfg.n_org, cfg.n_team, C, PERIODS))
    v_cond = np.zeros((cfg.n_theta, cfg.n_org, cfg.n_team, C, PERIODS))
    Mt = members.T.astype(float)  # (n, C)
    s = 0
    for b in range(cfg.n_theta):
        B = model.pk.unpack(thetas[b])
        eta = (Xf @ B).reshape(n, PERIODS, 3)
        sig_t = float(st_draws[rng.integers(len(st_draws))])
        sig_o = float(so_draws[rng.integers(len(so_draws))])
        for a in range(cfg.n_org):
            log_w = sig_o * rng.standard_normal(len(q_ids)) - 0.5 * sig_o * sig_o
            log_u = sig_t * rng.standard_normal((cfg.n_team, len(team_ids), len(q_ids))) - 0.5 * sig_t * sig_t
            shock = log_u[:, team_code][:, :, q_of_month] + log_w[q_of_month][None, None, :]  # (U, n, 6)
            e = np.repeat(eta[None], cfg.n_team, axis=0)
            e[..., 0] += shock
            mx = np.maximum(e.max(axis=-1, keepdims=True), 0.0)
            ex = np.exp(e - mx)
            P = ex / (np.exp(-mx) + ex.sum(axis=-1, keepdims=True))  # (U, n, 6, 3)
            F = cumulative(P)
            fv = F[..., 0]  # (U, n, 6)
            m_cond[b, a] = _agg(fv, Mt)
            v_cond[b, a] = _agg(fv * (1.0 - fv), Mt)
            # one process path per (theta, w, u)
            alive = np.ones((cfg.n_team, n), dtype=bool)
            dep_v = np.zeros((cfg.n_team, n, PERIODS), dtype=bool)
            dep_o = np.zeros((cfg.n_team, n, PERIODS), dtype=bool)
            for j in range(PERIODS):
                u = rng.random((cfg.n_team, n))
                pv, pi, pr = P[:, :, j, 0], P[:, :, j, 1], P[:, :, j, 2]
                is_v = alive & (u < pv)
                is_o = alive & (u >= pv) & (u < pv + pi + pr)
                alive &= ~(is_v | is_o)
                dep_v[:, :, j:] |= is_v[:, :, None]
                dep_o[:, :, j:] |= is_o[:, :, None]
            vol_counts[s : s + cfg.n_team] = _agg(dep_v.astype(float), Mt)
            oth_counts[s : s + cfg.n_team] = _agg(dep_o.astype(float), Mt)
            s += cfg.n_team
    qs = [0.025, 0.10, 0.90, 0.975]
    vol_q = np.moveaxis(np.quantile(vol_counts, qs, axis=0, method="inverted_cdf"), 0, -1)
    other_q = np.moveaxis(np.quantile(oth_counts, qs, axis=0, method="inverted_cdf"), 0, -1)
    # law of total variance over the nested layers
    var_process = v_cond.mean(axis=(0, 1, 2))
    var_team = m_cond.var(axis=2).mean(axis=(0, 1))
    var_org = m_cond.mean(axis=2).var(axis=1).mean(axis=0)
    var_param = m_cond.mean(axis=(1, 2)).var(axis=0)
    variance = np.stack([var_param, var_org, var_team, var_process], axis=-1)
    return McResult(
        vol_q=vol_q,
        other_q=other_q,
        vol_mean=vol_counts.mean(axis=0),
        variance=variance,
        sims=sims,
        vol_counts=vol_counts if keep_counts else None,
    )
