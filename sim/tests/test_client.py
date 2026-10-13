"""The live provider's request cache and dash ban (SPEC 15.5, 22.6): a run interrupted by a server error resumes from
the cache and ends where an uninterrupted run would; identical requests in flight share one call; the manifest
records the sampling-time dash ban."""

import asyncio
import json

import pytest

from staysignal_sim.client import NO_DASH_TOKEN_IDS, CachedProvider, OpenAICompatibleProvider, StubProvider
from staysignal_sim.personas import load_cells, load_proposals
from staysignal_sim.run import run_replicate

PROPOSAL = load_proposals()["promotion-criteria-third-window"]


class FakeLive(StubProvider):
    """Deterministic like the stub, named like the live provider; fails after `fail_after` calls when set."""

    name = "openai"
    sampling_note = OpenAICompatibleProvider.sampling_note

    def __init__(self, fail_after: int | None = None) -> None:
        self.calls = 0
        self.fail_after = fail_after

    async def complete(self, req: dict) -> dict:
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise ConnectionError("generation thread died")
        await asyncio.sleep(0)
        return await super().complete(req)


def test_an_interrupted_run_resumes_from_the_cache(tmp_path, run):
    whole = run(run_replicate(PROPOSAL, load_cells(), "main", 2, "rehearsal", FakeLive(), tmp_path / "whole"))
    cache = tmp_path / "cache.jsonl"
    with pytest.raises(ConnectionError):
        run(
            run_replicate(
                PROPOSAL,
                load_cells(),
                "main",
                2,
                "rehearsal",
                CachedProvider(FakeLive(fail_after=20), cache),
                tmp_path / "a",
            )
        )
    assert len(cache.read_text().splitlines()) == 20
    resumed_inner = FakeLive()
    resumed = CachedProvider(resumed_inner, cache)
    again = run(run_replicate(PROPOSAL, load_cells(), "main", 2, "rehearsal", resumed, tmp_path / "b"))
    assert again["db_sha256"] == whole["db_sha256"]
    assert resumed.hits == 20 and resumed_inner.calls == whole["calls"] - 20
    assert again["sampling"]["logit_bias"]["tokens"] == len(NO_DASH_TOKEN_IDS)
    cached = {json.loads(line)["request_sha256"] for line in cache.read_text().splitlines()}
    assert len(cached) == whole["calls"]


def test_identical_requests_in_flight_share_one_call(tmp_path, run):
    inner = FakeLive()
    p = CachedProvider(inner, tmp_path / "c.jsonl")
    req = {"model": "default_model", "messages": [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}]}

    async def both():
        return await asyncio.gather(p.complete(req), p.complete(req))

    a, b = run(both())
    assert a == b and inner.calls == 1 and len((tmp_path / "c.jsonl").read_text().splitlines()) == 1


def test_the_dash_ban_covers_unique_tokens():
    assert len(NO_DASH_TOKEN_IDS) == len(set(NO_DASH_TOKEN_IDS)) == 58
    assert OpenAICompatibleProvider.sampling_note["logit_bias"]["bias"] == -100
