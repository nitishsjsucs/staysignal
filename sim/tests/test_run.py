"""A recorded replicate and its replay (SPEC 15.3 to 15.5) with the stub provider: replay rebuilds the forum from the
actions with no model and reproduces the database hash; the recorded provider answers the same requests from the
log; malformed or out-of-feed tool calls become do_nothing with the reason kept."""

import json

import pytest

from staysignal_sim.client import RecordedProvider, StubProvider, build_request, request_sha, system_message
from staysignal_sim.personas import load_cells, load_proposals
from staysignal_sim.run import parse_action, parse_items, replay, run_replicate, to_oasis

PROPOSAL = load_proposals()["promotion-criteria-third-window"]


@pytest.fixture(scope="module")
def recorded(tmp_path_factory):
    import asyncio

    out = tmp_path_factory.mktemp("rec") / "run"
    manifest = asyncio.run(run_replicate(PROPOSAL, load_cells(), "main", 3, "rehearsal", StubProvider(), out))
    return out, manifest


def test_replay_reproduces_the_database_hash(recorded, tmp_path, run):
    out, manifest = recorded
    assert manifest["placeholder"] and manifest["provider"] == "stub" and len(manifest["personas"]) == 8
    assert run(replay(out, tmp_path)) == manifest["db_sha256"]


def test_the_recorded_provider_answers_from_the_log(recorded, tmp_path, run):
    out, manifest = recorded
    again = run(
        run_replicate(
            PROPOSAL, load_cells(), "main", 3, "rehearsal", RecordedProvider(out / "calls.jsonl.gz"), tmp_path / "again"
        )
    )
    assert again["db_sha256"] == manifest["db_sha256"]


def test_every_action_is_logged_with_round_structure(recorded):
    out, manifest = recorded
    acts = [json.loads(line) for line in (out / "actions.jsonl").read_text().splitlines()]
    assert [a["round"] for a in acts if a["action"] == "end_round"] == [1, 2, 3, 4]
    assert [a["args"]["value"] for a in acts if a["action"] == "seed"] == ["3:1", "3:2", "3:3", "3:4"]
    assert any(a["persona"] == "Program office" and a["args"]["content"].startswith("Program office FAQ") for a in acts)
    items = [json.loads(line) for line in (out / "items.jsonl").read_text().splitlines()]
    assert {i["phase"] for i in items} == {"pre", "post"} and len(items) == 16


def test_the_system_message_is_identical_across_personas_and_rounds(recorded):
    out, _ = recorded
    systems = json.loads((out / "systems.json").read_text())
    assert len(systems) == 1 and PROPOSAL["change"] in next(iter(systems.values()))


def test_tool_calls_are_validated_against_the_feed():
    feed = [{"post_id": 4, "comments": [{"comment_id": 9}]}]
    assert to_oasis("create_comment", {"post_id": 4, "content": "x", "stance": 1}, feed)[:3] == (
        "create_comment",
        {"post_id": 4, "content": "x"},
        1,
    )
    assert to_oasis("create_comment", {"post_id": 5, "content": "x"}, feed)[0] == "do_nothing"
    assert to_oasis("react", {"target_kind": "comment", "target_id": 9, "kind": "dislike"}, feed)[:2] == (
        "dislike_comment",
        {"comment_id": 9},
    )
    assert to_oasis("create_post", {"content": "y" * 400, "stance": 7}, [])[1]["content"] == "y" * 280
    assert to_oasis("create_post", {"content": "y", "stance": 7}, [])[2] is None
    assert parse_action({"choices": [{"message": {"content": "hi"}}]}) == ("do_nothing", {}, "no tool call")
    bad = {"choices": [{"message": {"tool_calls": [{"function": {"name": "react", "arguments": "{oops"}}]}}]}
    assert parse_action(bad)[2] == "arguments are not JSON"


def test_items_parse_only_five_labeled_points():
    assert parse_items('Sure: {"items": [5, 4, 2, 3, 1]}') == [5, 4, 2, 3, 1]
    assert parse_items('{"items": [5, 4, 2]}') is None and parse_items('{"items": [6, 4, 2, 3, 1]}') is None


def test_requests_have_no_seed_and_hash_canonically():
    req = build_request(system_message(PROPOSAL), "hello")
    assert "seed" not in req and req["model"] == "default_model"
    assert request_sha(req) == request_sha(json.loads(json.dumps(req)))
