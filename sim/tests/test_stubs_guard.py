"""SPEC 15.1: OASIS runs on the Lab's paths with its heavy dependencies stubbed, and fails loudly if it ever starts
calling a stubbed API. A 3-persona forum creates, comments and reacts through OASIS with every stub in place."""

import sys

import pytest

from staysignal_sim import stubs
from staysignal_sim.forum import Forum


def test_every_heavy_dependency_is_a_stub_or_the_shim():
    import oasis  # noqa: F401

    for name in ("torch", "transformers", "sentence_transformers", "sklearn.feature_extraction.text", "neo4j"):
        assert getattr(sys.modules[name], "__stub__", False), name
    assert sys.modules["igraph"].__name__ == "staysignal_sim.igraph_shim"


def test_stubbed_apis_refuse_to_run():
    import torch
    from sentence_transformers import SentenceTransformer

    with pytest.raises(stubs.StubUsed):
        torch.matmul(1, 2)
    with pytest.raises(stubs.StubUsed):
        SentenceTransformer("any")
    assert torch.cuda.is_available() is False


def test_the_labs_forum_paths_never_touch_a_stub(tmp_path, run):
    async def go():
        f = await Forum.open(tmp_path / "f.db", ["P01", "P02", "P03"])
        assert (await f.apply(0, "create_post", {"content": "When is the third window?"}))["success"]
        await f.end_round()
        feed = await f.refresh(1)
        assert feed["posts"][0]["content"] == "When is the third window?"
        assert (await f.apply(1, "create_comment", {"post_id": 1, "content": "Same question."}))["success"]
        assert (await f.apply(2, "like_post", {"post_id": 1}))["success"]
        assert (await f.apply(2, "do_nothing", {}))["success"]
        await f.end_round()
        await f.close()

    run(go())
