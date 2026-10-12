"""The generator's ground-truth hazards (SPEC 6.3). The model of SPEC 9.1 encodes some terms only approximately and
cannot see others (the latent propensity, the tenure by level interaction, drift); that is deliberate.

Calibration rule: only the three hazard intercepts (each within 0.5 of its starting value) and the promotion intercept
(within 0.4 of -3.9) may be adjusted, and only before they are frozen in the manifest.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Starting values (SPEC 6.3) and the calibrated values in use. Frozen once the canonical manifest is committed.
START_INTERCEPTS = {"vol": -5.20, "inv": -6.40, "ret": -8.20, "promo": -3.90}
INTERCEPTS = {"vol": -5.50, "inv": -6.40, "ret": -8.20, "promo": -3.60}

JOB_FAMILY_VOL = {"AE": 0.30, "SDR": 0.45, "TS": 0.30, "CSM": 0.15, "SWE": 0.10, "INF": 0.10, "DAT": 0.10, "SEC": 0.10}
LEVEL_BAND_VOL = {"early": 0.10, "mid": 0.0, "senior": -0.10, "manager": -0.25}
MONTH_VOL = {1: 0.10, 2: 0.25, 3: 0.25, 11: -0.15, 12: -0.30}
PROMO_LEVEL_ADJ = {"IC1": 0.3, "IC2": 0.2, "IC3": 0.0, "IC4": -0.2, "IC5": -0.5, "M1": -0.3, "M2": -0.5, "M3": -0.8}


@dataclass(frozen=True)
class HazardInputs:
    tenure_months: float
    level_band: str
    time_in_role_months: float
    months_since_promotion: float  # since last promotion, or since spell start if never promoted
    first_promotion_months: float | None  # months from spell start to the first promotion, if any
    manager_changes_180d: int
    compa_ratio: float
    prior_team_rate: float  # shrunk 180-day voluntary departure rate of the team
    reorg_90d: bool
    job_family: str
    fixed_term: bool
    calendar_month: int
    months_since_drift_start: float
    latent: float
    log_team_shock: float
    log_org_shock: float
    age_years: float


@dataclass(frozen=True)
class WorldKnobs:
    interaction: bool = True
    promo_effect: str = "smooth"
    drift: bool = True
    contagion: bool = True


def tenure_term(t: float) -> float:
    if t < 12:
        return 0.15
    if t < 24:
        return 0.40
    if t < 48:
        return 0.20
    if t < 84:
        return 0.0
    return -0.40


def eta_voluntary(x: HazardInputs, k: WorldKnobs) -> float:
    eta = INTERCEPTS["vol"] + x.latent + tenure_term(x.tenure_months)
    if k.interaction:
        if x.level_band == "early" and 12 <= x.tenure_months < 36:
            eta += 0.25
        if x.level_band == "senior" and x.tenure_months >= 84:
            eta -= 0.15
    if x.time_in_role_months > 30:
        eta += 0.20
    if k.promo_effect == "smooth":
        eta += 0.30 * min(max((x.months_since_promotion - 12.0) / 24.0, 0.0), 1.0)
    elif x.months_since_promotion >= 24:
        eta += 0.30
    if x.first_promotion_months is not None and x.first_promotion_months > 36:
        eta += 0.15
    eta += 0.25 * min(x.manager_changes_180d, 3)
    eta += 4.0 * max(0.0, 1.0 - x.compa_ratio)
    eta -= 1.0 * min(max(0.0, x.compa_ratio - 1.0), 0.5)
    if k.contagion:
        eta += 2.5 * x.prior_team_rate
    if x.reorg_90d:
        eta += 0.35
    eta += JOB_FAMILY_VOL.get(x.job_family, 0.0)
    eta += LEVEL_BAND_VOL[x.level_band]
    if x.fixed_term:
        eta -= 0.30
    eta += MONTH_VOL.get(x.calendar_month, 0.0)
    if k.drift:
        eta -= 0.15 * min(max(x.months_since_drift_start / 12.0, 0.0), 1.0)
    return eta + x.log_team_shock + x.log_org_shock


def eta_involuntary(x: HazardInputs) -> float:
    eta = INTERCEPTS["inv"]
    if x.tenure_months < 12:
        eta += 0.50
    if x.level_band == "early":
        eta += 0.20
    if x.reorg_90d:
        eta += 0.60
    return eta + 0.10 * min(x.manager_changes_180d, 3)


def eta_retirement(x: HazardInputs) -> float:
    return INTERCEPTS["ret"] + 0.35 * max(0.0, x.age_years - 55.0)


def cause_probabilities(eta_vol: float, eta_inv: float, eta_ret: float) -> tuple[float, float, float]:
    """Multinomial logit with stay as the reference: p_k = exp(eta_k) / (1 + sum_m exp(eta_m))."""
    a, b, c = math.exp(eta_vol), math.exp(eta_inv), math.exp(eta_ret)
    denom = 1.0 + a + b + c
    return a / denom, b / denom, c / denom


def promotion_probability(months_in_level: float, level: str) -> float:
    if level in ("IC6", "M4"):
        return 0.0
    z = INTERCEPTS["promo"] + 0.08 * min(months_in_level, 36.0) + PROMO_LEVEL_ADJ.get(level, 0.0)
    return 1.0 / (1.0 + math.exp(-z))
