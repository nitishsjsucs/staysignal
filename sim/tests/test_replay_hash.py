"""SPEC 15.5: every committed recording replays, with no model, to the database hash in its manifest."""

import asyncio
import json
from pathlib import Path

import pytest

from staysignal_sim.run import replay

RECORDINGS = Path(__file__).resolve().parents[2] / "lab" / "recordings"
RUNS = sorted(p for p in RECORDINGS.glob("*/*") if (p / "manifest.json").exists()) if RECORDINGS.exists() else []


def test_there_is_a_session_per_proposal():
    sessions = {json.loads((p / "manifest.json").read_text())["proposal"] for p in RUNS}
    assert sessions == {"promotion-criteria-third-window", "infra-data-merge"}


@pytest.mark.parametrize("run_dir", RUNS, ids=[f"{p.parent.name}/{p.name}" for p in RUNS])
def test_replay_hash(run_dir, tmp_path):
    manifest = json.loads((run_dir / "manifest.json").read_text())
    assert asyncio.run(replay(run_dir, tmp_path)) == manifest["db_sha256"]
