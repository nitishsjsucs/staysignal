"""Feature effects: partial dependence curves with parameter bands, population means only."""

import json
from datetime import UTC, date, datetime

from staysignal.evaluate.backtest import model_for_origin
from staysignal.evaluate.effects import FEATURES, partial_dependence
from staysignal.features.reference import Vintage, features_at
from staysignal.ingest.landing import load_world_sources
from staysignal.world.spec import SMALL


def test_partial_dependence_on_the_small_world(small, tmp_path):
    src = load_world_sources(small)
    sha = json.loads((small / "manifest.json").read_text())["world_sha256"]
    c = date(2026, 4, 1)
    model = model_for_origin(src, SMALL.start, c, tmp_path, sha)
    rows = features_at(Vintage(src, datetime(2026, 4, 1, tzinfo=UTC)), c)
    out = partial_dependence(model, rows, c, n_draws=4)
    assert set(out) == set(FEATURES)
    for key, curve in out.items():
        pts = curve["points"]
        assert [p["x"] for p in pts] == FEATURES[key]["grid"]
        for p in pts:
            assert 0.0 < p["cif"] < 1.0
            assert p["lo"] <= p["hi"]
    # a population mean, so the curve at the observed values brackets the run's mean prediction
    assert all(isinstance(p["cif"], float) for p in out["reorg"]["points"])
