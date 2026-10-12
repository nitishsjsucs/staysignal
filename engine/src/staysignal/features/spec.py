"""The single declaration of the point-in-time features (SPEC 8.2). `reference.py` and `pit.sql` implement it; the
model artifact records the SHA-256 of this declaration, so a definition change is visible in every run key."""

from __future__ import annotations

import hashlib

from staysignal.canonical import canonical_json

FEATURE_SPEC_VERSION = "1"

FEATURES: dict[str, str] = {
    "tenure_days": "c - start_date of the current spell (a rehire starts at 0); natural cubic spline of log(1 + tenure months)",
    "time_in_role_days": "c - start of the current role segment (job_code, level); indicator over 30 months",
    "days_since_last_promotion": "c - latest level increase in the spell, or spell start; indicator 24 months or more",
    "first_promotion_status": "none_yet, or months from spell start to the first promotion banded le18, 18to36, gt36",
    "manager_changes_180d": "net changes of effective manager in [c - 180 days, c) after dedupe and corrections; min(count, 3)",
    "compa_ratio": "annualized base pay (latest period before c known at v, by the active pay-basis mapping) / band midpoint",
    "prior_team_departures_180d": "other employees' voluntary departures from the team at c in [c - 180 days, c), shrunk to the organization rate",
    "reorg_exposure_90d": "the team at c had a reorganization event effective in [c - 90 days, c)",
    "job_family": "as of c",
    "level_band": "as of c",
    "organization": "as of c",
    "employment_type": "regular or fixed-term at c",
    "fixed_term_days_remaining": "days to the planned contract end, banded; involuntary cause only",
}


def feature_spec_sha256() -> str:
    return hashlib.sha256(
        canonical_json({"version": FEATURE_SPEC_VERSION, "features": FEATURES}).encode("ascii")
    ).hexdigest()
