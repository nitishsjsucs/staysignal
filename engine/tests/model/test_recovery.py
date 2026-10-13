"""C6: the estimator recovers a correctly specified truth (SPEC 6.7, 9.1). On the `recovery` world (about 40,000
employees, 42 months, everything the model cannot see switched off) an unpenalized fit of the generator's own
encodings passes a joint Wald test of the voluntary slopes against the truth at alpha 0.01, puts at least 85% of slopes
inside their 95% cluster-robust intervals, and gets the sign right wherever the truth is at least 3 standard errors
from zero. About 45 seconds and 3 GB."""

from dataclasses import replace

import numpy as np
import pytest

from staysignal.model import recovery
from staysignal.world import hazards
from staysignal.world.simulate import Simulator
from staysignal.world.spec import RECOVERY, recovery_profile


def test_the_design_reproduces_the_generators_linear_predictors():
    profile = replace(recovery_profile(1), months=8)
    sim = Simulator(profile)
    sim.write_payroll = False
    sim.recorder = []
    sim.setup()
    for _ in range(profile.months):
        sim.step()
    pk = recovery.packing()
    truth = recovery.truth_vector(pk)
    offsets = np.cumsum([0] + pk.sizes)
    X = np.array([recovery.encode(x) for x, _, _ in sim.recorder])
    eta = [X[:, m] @ truth[offsets[k] : offsets[k + 1]] for k, m in enumerate(pk.masks)]
    expected = np.array(
        [
            (hazards.eta_voluntary(x, sim.knobs), hazards.eta_involuntary(x), hazards.eta_retirement(x))
            for x, _, _ in sim.recorder
        ]
    )
    assert len(X) > 10_000
    np.testing.assert_allclose(np.column_stack(eta), expected, rtol=0, atol=1e-12)


def test_the_recovery_world_is_correctly_specified():
    assert RECOVERY.baseline_headcount == 40_040
    assert (RECOVERY.latent_sd, RECOVERY.sigma_team, RECOVERY.sigma_org) == (0.0, 0.0, 0.0)
    assert (RECOVERY.interaction, RECOVERY.drift, RECOVERY.promo_effect, RECOVERY.planted) == (
        False,
        False,
        "step",
        None,
    )


@pytest.fixture(scope="module")
def report() -> dict:
    return recovery.check(recovery.simulate())


def test_joint_wald_test_of_the_voluntary_slopes(report):
    assert report["converged"]
    assert report["wald"]["df"] == 29
    assert report["wald"]["p_value"] >= recovery.ALPHA


def test_slopes_inside_their_95_percent_intervals(report):
    assert report["coverage_95"]["slopes"] == 34
    assert report["coverage_95"]["share"] >= recovery.COVERAGE_MIN


def test_signs_wherever_the_truth_is_three_standard_errors_from_zero(report):
    assert report["signs"]["checked"] >= 20
    assert report["signs"]["correct"] == report["signs"]["checked"]
    assert all(report["passed"].values())
