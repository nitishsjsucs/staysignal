"""Shared fixtures: generated worlds are built once per session into a temporary directory."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from staysignal.world.emit import generate
from staysignal.world.spec import PROFILES


@pytest.fixture(scope="session")
def world_dir(tmp_path_factory: pytest.TempPathFactory):
    cache: dict[str, Path] = {}

    def make(profile: str) -> Path:
        if profile not in cache:
            out = tmp_path_factory.mktemp(f"world-{profile}")
            generate(PROFILES[profile], out)
            cache[profile] = out
        return cache[profile]

    return make


@pytest.fixture(scope="session")
def canonical(world_dir) -> Path:
    return world_dir("canonical")


@pytest.fixture(scope="session")
def small(world_dir) -> Path:
    return world_dir("small")


def manifest(path: Path) -> dict:
    return json.loads((path / "manifest.json").read_text())
