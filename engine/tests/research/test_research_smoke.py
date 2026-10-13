"""The CI run of the research benchmark (SPEC 11): 2 seeds by 2 origins on the small world, end to end, resumable,
with a results document that records the pre-registration hash. The numbers mean nothing at this size."""

import json

from staysignal.research.report import prereg_sha256, summarize
from staysignal.research.run import checkpoint_path, run_seeds


def test_two_seeds_two_origins_on_the_small_world(tmp_path):
    docs = run_seeds([1, 2], tmp_path, small=True, log=lambda *_: None)
    assert [d["seed"] for d in docs] == [1, 2]
    assert checkpoint_path(tmp_path, 1).exists()
    rows = docs[0]["rows"]
    assert {r["condition"] for r in rows} >= {"base", "late_0.30", "missing", "shock_0.5", "duplicates_0.05"}
    assert all(r["i80"][0] <= r["i80"][1] and r["i95"][0] <= r["i80"][0] and 0 <= r["pit"] <= 1 for r in rows)
    assert any(r["level"] == "team" for r in rows if r["condition"].startswith("shock_"))
    assert not any(r["level"] == "team" for r in rows if r["condition"] == "base")
    # a second call resumes from the checkpoints
    again = run_seeds([1, 2], tmp_path, small=True, log=lambda *_: None)
    assert json.dumps(again) == json.dumps(docs)
    s = summarize(docs)
    assert len(s["cells"]) == 22  # A 6, B 4, C 6, D 4, A x C 2
    assert set(s["hypotheses"]) == {"H1", "H2", "H3a", "H3b", "H4", "H5"}
    assert len(prereg_sha256()) == 64
