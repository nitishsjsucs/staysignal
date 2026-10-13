"""The live persona interview (SPEC 15.8): the persona's context comes only from the recorded session (its card from
the voice call, its own posts), one merged system message, the stub streams for CI, and a missing model server is a
503 before anything is streamed, so the Worker can fall back to a recorded answer."""

import json

from fastapi.testclient import TestClient

from staysignal.lab import interview
from staysignal.paths import REPO_ROOT
from staysignal.runner.jobs import EngineState
from staysignal.service.app import create_app

REC = REPO_ROOT / "lab" / "recordings"
PROPOSAL = "promotion-criteria-third-window"


def test_context_comes_from_the_recorded_session():
    session = interview.find_session(REC, PROPOSAL)
    ctx = interview.persona_context(session, "P03")
    assert ctx["handle"].startswith("P03 ")
    assert ctx["card"].startswith("You are P03 ") and "Proposed:" in ctx["card"]
    assert "Describe how this persona talks" not in ctx["card"]
    assert ctx["posts"] and all(isinstance(p, str) for p in ctx["posts"])
    msgs = interview.messages(ctx, "  What would you ask   first? ")
    assert [m["role"] for m in msgs] == ["system", "user"]
    assert msgs[1]["content"] == "What would you ask first?"
    assert ctx["card"] in msgs[0]["content"] and ctx["posts"][0] in msgs[0]["content"]


def test_rejects_unknown_inputs():
    for proposal, persona, question in [
        ("nope", "P01", "q"),
        (PROPOSAL, "P99", "q"),
        (PROPOSAL, "x", "q"),
        (PROPOSAL, "P01", ""),
    ]:
        try:
            interview.messages(interview.persona_context(interview.find_session(REC, proposal), persona), question)
        except interview.InterviewError:
            continue
        raise AssertionError((proposal, persona, question))


def _client(tmp_path) -> TestClient:
    st = EngineState(None, tmp_path / "w.duckdb", tmp_path, tmp_path, tmp_path, tmp_path / "pub", tmp_path / "work")  # type: ignore[arg-type]
    return TestClient(create_app(st, lab_recordings=REC, mlx_url="http://127.0.0.1:9/v1/chat/completions"))


def test_the_stub_streams_with_the_label_and_logs_outside_the_recordings(tmp_path):
    c = _client(tmp_path)
    r = c.post(
        "/lab/interview",
        json={"proposal": PROPOSAL, "persona_id": "P03", "question": "What would you ask first?", "provider": "stub"},
    )
    assert r.status_code == 200
    assert r.text.startswith("[stub] ")
    assert r.headers["x-staysignal-label"] == interview.LABEL
    log = [json.loads(x) for x in (tmp_path / "work" / "lab" / "interviews.jsonl").read_text().splitlines()]
    assert log[0]["persona_id"] == "P03" and log[0]["answer"] == r.text.strip() and log[0]["provider"] == "stub"


def test_no_model_server_is_a_503_and_bad_input_a_400(tmp_path):
    c = _client(tmp_path)
    r = c.post(
        "/lab/interview", json={"proposal": PROPOSAL, "persona_id": "P03", "question": "Why?", "provider": "mlx"}
    )
    assert r.status_code == 503
    assert (
        c.post("/lab/interview", json={"proposal": PROPOSAL, "persona_id": "P77", "question": "Why?"}).status_code
        == 400
    )
    assert not (tmp_path / "work" / "lab" / "interviews.jsonl").exists()


def test_the_27b_request_bans_dash_tokens():
    # the same list as the Lab recorder's; the engine never imports the sim, so it keeps a copy
    import re

    sim = (REPO_ROOT / "sim" / "src" / "staysignal_sim" / "client.py").read_text(encoding="utf-8")
    block = re.search(r"NO_DASH_TOKEN_IDS = \((.*?)\)", sim, re.S)
    assert block is not None
    assert tuple(int(x) for x in re.findall(r"\d+", block.group(1))) == interview.NO_DASH_TOKEN_IDS
    body = interview.mlx_body([{"role": "user", "content": "Why?"}])
    assert len(body["logit_bias"]) == len(interview.NO_DASH_TOKEN_IDS)
    assert set(body["logit_bias"].values()) == {-100.0}
    assert body["max_tokens"] == interview.MAX_TOKENS and body["stream"] is True
