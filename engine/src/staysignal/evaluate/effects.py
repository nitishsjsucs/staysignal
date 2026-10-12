"""Feature effects (SPEC 9.5): partial dependence of the 3-month voluntary cumulative incidence on one feature at a
time. For each grid value the whole population at a cutoff gets that value (everything else as observed), the model
scores it, and the mean is the curve; the 80% band comes from parameter draws N(theta_hat, V). Associational, not
causal: a curve says how the model's prediction moves with a feature, not what changing it would do. Only these
population means are kept; nothing individual leaves the function. Synthetic world only."""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import numpy as np

from staysignal.features.reference import FeatureRow
from staysignal.forecast.montecarlo import mvn_draws
from staysignal.forecast.score import score
from staysignal.model.artifact import Model

DAY = 30.4375
FEATURES: dict[str, dict] = {
    "tenure": {
        "label": "Tenure (months)",
        "field": "tenure_days",
        "grid": [3, 6, 12, 24, 36, 60, 96, 144],
        "to_value": lambda x: int(round(x * DAY)),
    },
    "since_promotion": {
        "label": "Months since last promotion",
        "field": "days_since_last_promotion",
        "grid": [3, 6, 12, 18, 24, 36, 48],
        "to_value": lambda x: int(round(x * DAY)),
    },
    "compa_ratio": {
        "label": "Pay against band midpoint (compa-ratio)",
        "field": "compa_ratio",
        "grid": [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2],
        "to_value": float,
    },
    "manager_changes": {
        "label": "Manager changes in 180 days",
        "field": "manager_changes_180d",
        "grid": [0, 1, 2, 3],
        "to_value": int,
    },
    "team_departures": {
        "label": "Prior team departure rate (shrunk, 180 days)",
        "field": "prior_team_rate",
        "grid": [0.0, 0.02, 0.05, 0.1, 0.15, 0.2],
        "to_value": float,
    },
    "reorg": {
        "label": "Reorganization in the last 90 days",
        "field": "reorg_exposure_90d",
        "grid": [0, 1],
        "to_value": bool,
    },
}


def _mean_f3(model: Model, rows: list[FeatureRow], c: date, theta: np.ndarray | None) -> float:
    return float(score(model, rows, c, theta).F[:, 2, 0].mean())


def partial_dependence(
    model: Model, rows: list[FeatureRow], c: date, n_draws: int = 20, seed: int = 0
) -> dict[str, dict]:
    rng = np.random.default_rng(seed)
    thetas = mvn_draws(rng, model.theta, model.cov, n_draws)
    out: dict[str, dict] = {}
    for key, spec in FEATURES.items():
        points = []
        for x in spec["grid"]:
            v = spec["to_value"](x)
            moved = [replace(r, **{spec["field"]: v}) for r in rows]
            if spec["field"] == "days_since_last_promotion":
                moved = [replace(r, never_promoted_in_spell=False) for r in moved]
            est = _mean_f3(model, moved, c, None)
            draws = np.array([_mean_f3(model, moved, c, t) for t in thetas])
            points.append(
                {"x": x, "cif": est, "lo": float(np.quantile(draws, 0.1)), "hi": float(np.quantile(draws, 0.9))}
            )
        out[key] = {"label": spec["label"], "points": points}
    return out


__all__ = ["FEATURES", "partial_dependence"]
