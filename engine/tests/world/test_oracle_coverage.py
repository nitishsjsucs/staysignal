"""C5: the oracle's 90% intervals contain the realized counts in 80% to 97% of cells (quarterly origins x company and
organizations x causes x horizons). Slow (about 10 minutes on 8 workers); recorded by `staysignal eval oracle-coverage`."""

import pytest

from staysignal.evaluate.oracle_coverage import BAND, coverage
from staysignal.world.spec import PROFILES


@pytest.mark.slow
def test_oracle_coverage_on_the_canonical_world():
    report = coverage(PROFILES["canonical"], n_futures=2000)
    assert BAND[0] <= report["coverage"] <= BAND[1], report["by_cause_horizon"]
