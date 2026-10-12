"""Penalized multinomial logit with per-cause column masks (SPEC 9.1, ADR 0004).

Outcome per person-period row: 0 stay, 1 voluntary, 2 involuntary, 3 retirement. For cause k the linear predictor
is X[:, mask_k] @ beta_k and p_k = exp(eta_k) / (1 + sum_m exp(eta_m)). The objective is the negative log-likelihood
plus lambda / 2 times the squared norm of penalized coefficients (everything but the cause intercepts; columns are
standardized first). Fit with scipy L-BFGS-B and an analytic gradient, then polished with Newton steps on the
analytic Hessian until the gradient's max norm is below `gtol`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import minimize

K = 3


@dataclass
class Packing:
    p: int
    masks: list[np.ndarray]  # column indices per cause
    penalized: np.ndarray  # bool per column

    @property
    def sizes(self) -> list[int]:
        return [len(m) for m in self.masks]

    @property
    def n_params(self) -> int:
        return sum(self.sizes)

    def unpack(self, theta: np.ndarray) -> np.ndarray:
        B = np.zeros((self.p, K))
        o = 0
        for k, m in enumerate(self.masks):
            B[m, k] = theta[o : o + len(m)]
            o += len(m)
        return B

    def pack(self, G: np.ndarray) -> np.ndarray:
        return np.concatenate([G[m, k] for k, m in enumerate(self.masks)])

    def penalty_mask(self) -> np.ndarray:
        return np.concatenate([self.penalized[m] for m in self.masks]).astype(float)


def probabilities(X: np.ndarray, B: np.ndarray) -> np.ndarray:
    """(n, K) cause probabilities for each row."""
    eta = X @ B
    mx = np.maximum(eta.max(axis=1, keepdims=True), 0.0)
    e = np.exp(eta - mx)
    denom = np.exp(-mx) + e.sum(axis=1, keepdims=True)
    return e / denom


def objective(theta: np.ndarray, X: np.ndarray, Y: np.ndarray, pk: Packing, lam: float) -> tuple[float, np.ndarray]:
    B = pk.unpack(theta)
    eta = X @ B
    mx = np.maximum(eta.max(axis=1, keepdims=True), 0.0)
    lse = (mx + np.log(np.exp(-mx) + np.exp(eta - mx).sum(axis=1, keepdims=True)))[:, 0]
    ll = float((Y * eta).sum() - lse.sum())
    P = np.exp(eta - lse[:, None])
    G = X.T @ (Y - P)
    pen = pk.penalty_mask()
    f = -ll + 0.5 * lam * float((pen * theta * theta).sum())
    g = -pk.pack(G) + lam * pen * theta
    return f, g


def hessian(theta: np.ndarray, X: np.ndarray, pk: Packing, lam: float) -> np.ndarray:
    """Analytic Hessian of the penalized objective (positive definite at the optimum)."""
    B = pk.unpack(theta)
    P = probabilities(X, B)
    n_par = pk.n_params
    H = np.zeros((n_par, n_par))
    offs = np.cumsum([0] + pk.sizes)
    for k in range(K):
        for l in range(k, K):
            w = P[:, k] * ((1.0 if k == l else 0.0) - P[:, l])
            Xk = X[:, pk.masks[k]]
            Xl = X[:, pk.masks[l]]
            block = (Xk * w[:, None]).T @ Xl
            H[offs[k] : offs[k + 1], offs[l] : offs[l + 1]] = block
            if l != k:
                H[offs[l] : offs[l + 1], offs[k] : offs[k + 1]] = block.T
    H += lam * np.diag(pk.penalty_mask())
    return H


@dataclass
class Fit:
    theta: np.ndarray
    loglik: float
    iterations: int
    newton_steps: int
    grad_max: float
    converged: bool


def fit(
    X: np.ndarray,
    Y: np.ndarray,
    pk: Packing,
    lam: float = 1.0,
    gtol: float = 1e-10,
    maxiter: int = 5000,
    theta0: np.ndarray | None = None,
) -> Fit:
    """Y is the (n, K) one-hot outcome matrix (all zeros for stay)."""
    theta = np.zeros(pk.n_params) if theta0 is None else theta0.copy()
    if theta0 is None:
        # start the intercepts at the marginal log-odds of each cause
        rates = np.clip(Y.mean(axis=0), 1e-6, None)
        stay = max(1e-6, 1.0 - rates.sum())
        o = 0
        for k, m in enumerate(pk.masks):
            theta[o] = np.log(rates[k] / stay)
            o += len(m)
    res = minimize(
        objective,
        theta,
        args=(X, Y, pk, lam),
        jac=True,
        method="L-BFGS-B",
        options={"maxiter": maxiter, "gtol": gtol, "ftol": 1e-15, "maxcor": 30},
    )
    theta = res.x
    steps = 0
    f, g = objective(theta, X, Y, pk, lam)
    while np.abs(g).max() > gtol and steps < 25:
        H = hessian(theta, X, pk, lam)
        delta = np.linalg.solve(H, g)
        t = 1.0
        while t > 1e-6:
            cand = theta - t * delta
            fc, gc = objective(cand, X, Y, pk, lam)
            if fc <= f + 1e-12 * abs(f):
                break
            t *= 0.5
        theta, f, g = cand, fc, gc
        steps += 1
    return Fit(
        theta=theta,
        loglik=-(f - 0.5 * lam * float((pk.penalty_mask() * theta * theta).sum())),
        iterations=int(res.nit),
        newton_steps=steps,
        grad_max=float(np.abs(g).max()),
        converged=bool(np.abs(g).max() <= max(gtol, 1e-8)),
    )


def cluster_sandwich(
    theta: np.ndarray, X: np.ndarray, Y: np.ndarray, clusters: np.ndarray, pk: Packing, lam: float
) -> np.ndarray:
    """Cluster-robust covariance H^-1 M H^-1 with per-cluster score sums (clusters: integer codes per row), with the
    small-sample factor C / (C - 1)."""
    B = pk.unpack(theta)
    P = probabilities(X, B)
    R = Y - P
    n_clusters = int(clusters.max()) + 1
    scores = np.zeros((n_clusters, pk.n_params))
    o = 0
    for k, m in enumerate(pk.masks):
        contrib = X[:, m] * R[:, k : k + 1]
        np.add.at(scores[:, o : o + len(m)], clusters, contrib)
        o += len(m)
    meat = scores.T @ scores * (n_clusters / max(1, n_clusters - 1))
    Hinv = np.linalg.inv(hessian(theta, X, pk, lam))
    V = Hinv @ meat @ Hinv
    return (V + V.T) / 2.0
