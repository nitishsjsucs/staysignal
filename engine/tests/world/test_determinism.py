"""C1: the world regenerates bit for bit from its seed."""

from staysignal.world.emit import generate
from staysignal.world.spec import SMALL


def test_small_world_is_deterministic(tmp_path):
    a = generate(SMALL, tmp_path / "a")
    b = generate(SMALL, tmp_path / "b")
    assert a["files"] == b["files"]
    assert a["world_sha256"] == b["world_sha256"]
    for name in a["files"]:
        assert (tmp_path / "a" / name).read_bytes() == (tmp_path / "b" / name).read_bytes()


def test_seed_changes_the_world(tmp_path):
    from dataclasses import replace

    a = generate(SMALL, None)
    b = generate(replace(SMALL, seed=8), None)
    assert a["world_sha256"] != b["world_sha256"]
