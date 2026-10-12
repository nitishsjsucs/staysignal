"""C1: the canonical world matches the committed SHA-256 pins (macOS-made, checked on ubuntu-latest by CI)."""

import json
from pathlib import Path

from staysignal.world.pins import compare

PINS = Path(__file__).resolve().parents[3] / "data" / "world" / "manifest.json"


def test_canonical_world_matches_the_pins(canonical):
    generated = json.loads((canonical / "manifest.json").read_text())
    assert compare(json.loads(PINS.read_text()), generated) == []


def test_compare_names_what_moved():
    pinned = json.loads(PINS.read_text())
    moved = json.loads(PINS.read_text())
    name = sorted(moved["files"])[0]
    moved["files"][name] = {**moved["files"][name], "sha256": "0" * 64}
    moved["realized"]["closing_headcount"] += 1
    diffs = compare(pinned, moved)
    assert any(d.startswith(f"files/{name}") for d in diffs)
    assert any(d.startswith("realized/closing_headcount") for d in diffs)
