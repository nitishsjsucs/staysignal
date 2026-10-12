from datetime import UTC, datetime
from pathlib import Path

import pytest

from staysignal.memory.repo import MemoryRepo

SEED = Path(__file__).resolve().parents[1] / "fixtures" / "memory_seed"
SEEDED_AT = datetime(2026, 10, 1, 7, 0, tzinfo=UTC)


@pytest.fixture
def repo(tmp_path) -> MemoryRepo:
    r = MemoryRepo(tmp_path / "memory")
    r.init(SEED, SEEDED_AT)
    return r
