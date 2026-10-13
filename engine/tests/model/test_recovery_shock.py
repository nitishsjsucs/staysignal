"""C6, shock-world variant (SPEC 9.1): with team shocks (sigma 0.45 per quarter) that the model omits, its slopes
estimate marginal effects, so the fit on a 40,040-person shock world (seed 1013) is compared with marginal targets:
the same fit on a separate 200,200-person world from the same truth (seed 1012), cached in
results/recovery-shock-targets.json by `staysignal eval recovery-shock --targets`. The targets' own covariance is added
to the fit's. The same three checks as C6. Slow: about 45 seconds and 3 GB."""

import json
from pathlib import Path

import numpy as np
import pytest

from staysignal.model import recovery
from staysignal.world.spec import SHOCK_SIGMA_TEAM, TARGETS_FACTOR, recovery_shock_profile

CACHE = Path(__file__).resolve().parents[3] / "results" / "recovery-shock-targets.json"


def targets() -> dict:
    return json.loads(CACHE.read_text())


def test_the_cached_targets_match_the_design_and_the_shock_world():
    t = targets()
    assert t["params"] == recovery.param_names()
    assert (t["seed"], t["sigma_team"], t["baseline_headcount"]) == (1012, SHOCK_SIGMA_TEAM, 1_820 * TARGETS_FACTOR)
    cov = np.array(t["cov"])
    assert cov.shape == (len(t["theta"]),) * 2 and np.all(np.diag(cov) > 0)


def test_the_tested_world_differs_from_the_targets_world_only_by_size_and_seed():
    small, big = recovery_shock_profile(), recovery_shock_profile(TARGETS_FACTOR, seed=1012)
    assert small.seed != big.seed and small.sigma_team == big.sigma_team == SHOCK_SIGMA_TEAM
    assert (small.latent_sd, small.interaction, small.drift, small.sigma_org) == (0.0, False, False, 0.0)


@pytest.fixture(scope="module")
def report() -> dict:
    return recovery.check(recovery.simulate(recovery_shock_profile()), targets())


@pytest.mark.slow
def test_joint_wald_test_against_the_marginal_targets(report):
    assert report["converged"]
    assert report["wald"]["p_value"] >= recovery.ALPHA


@pytest.mark.slow
def test_slopes_inside_their_95_percent_intervals_around_the_targets(report):
    assert report["coverage_95"]["share"] >= recovery.COVERAGE_MIN


@pytest.mark.slow
def test_signs_wherever_the_target_is_three_standard_errors_from_zero(report):
    assert report["signs"]["checked"] >= 15
    assert report["signs"]["correct"] == report["signs"]["checked"]
