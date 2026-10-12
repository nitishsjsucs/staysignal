"""SplitMix64 pseudo random number generator.

Copied from PeopleLake pipeline/src/peoplelake/prng.py (MIT), adapted for StaySignal: adds uniform floats, normal and
lognormal draws and named streams. Integer draws use only 64-bit integer arithmetic; floats are built from the top
53 bits, and the transcendental functions behind normal draws are Python's scalar `math` functions, never vectorized
numpy, so a draw is the same on macOS and Linux (SPEC 6).
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from typing import TypeVar

MASK64 = (1 << 64) - 1
T = TypeVar("T")
_INV53 = 1.0 / 9007199254740992.0


class SplitMix64:
    def __init__(self, seed: int) -> None:
        self.state = seed & MASK64

    def next_u64(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def below(self, n: int) -> int:
        """Uniform integer in [0, n)."""
        if n <= 0:
            raise ValueError("n must be positive")
        limit = (1 << 64) - ((1 << 64) % n)
        while True:
            x = self.next_u64()
            if x < limit:
                return x % n

    def randint(self, lo: int, hi: int) -> int:
        """Uniform integer in [lo, hi] (inclusive)."""
        if hi < lo:
            raise ValueError(f"empty range [{lo}, {hi}]")
        return lo + self.below(hi - lo + 1)

    def uniform(self) -> float:
        """Uniform float in [0, 1) from the top 53 bits."""
        return (self.next_u64() >> 11) * _INV53

    def bernoulli(self, p: float) -> bool:
        return self.uniform() < p

    def normal(self, mean: float = 0.0, sd: float = 1.0) -> float:
        """Box-Muller with scalar math; one variate per call so streams stay aligned."""
        u1 = 1.0 - self.uniform()  # (0, 1]
        u2 = self.uniform()
        return mean + sd * math.sqrt(-2.0 * math.log(u1)) * math.cos(2.0 * math.pi * u2)

    def lognormal_mean_one(self, sigma: float) -> float:
        """Lognormal with mean 1: exp(sigma * N - sigma^2 / 2)."""
        if sigma == 0.0:
            return 1.0
        return math.exp(sigma * self.normal() - 0.5 * sigma * sigma)

    def choice(self, seq: Sequence[T]) -> T:
        return seq[self.below(len(seq))]

    def weighted(self, items: Sequence[tuple[T, int]]) -> T:
        total = sum(w for _, w in items)
        x = self.below(total)
        for item, w in items:
            if x < w:
                return item
            x -= w
        raise AssertionError("unreachable")

    def shuffle(self, items: list[T]) -> None:
        for i in range(len(items) - 1, 0, -1):
            j = self.below(i + 1)
            items[i], items[j] = items[j], items[i]

    def sample(self, seq: Sequence[T], k: int) -> list[T]:
        if k > len(seq):
            raise ValueError(f"sample of {k} from {len(seq)} items")
        pool = list(seq)
        for i in range(k):
            j = i + self.below(len(pool) - i)
            pool[i], pool[j] = pool[j], pool[i]
        return pool[:k]

    def fork(self, label: str) -> SplitMix64:
        """Independent stream derived from this generator's seed and a label (does not advance self)."""
        digest = hashlib.sha256(f"{self.state}:{label}".encode()).digest()
        return SplitMix64(int.from_bytes(digest[:8], "big"))


def stream(seed: int, name: str) -> SplitMix64:
    """Named stream: one per generator stage, so adding a stage never shifts another stage's draws."""
    digest = hashlib.sha256(f"staysignal:{seed}:{name}".encode()).digest()
    return SplitMix64(int.from_bytes(digest[:8], "big"))
