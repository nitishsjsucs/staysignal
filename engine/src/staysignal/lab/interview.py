"""The Scenario Lab's live persona interview (SPEC 15.8): one question to one synthetic persona of a recorded session.

The persona's context is rebuilt from the session's own files, never from company data: the card is the user message
of the persona's recorded voice call (handle, the cohort facts, the status quo and the proposal), and the digest is the
persona's own posts and comments from the main replicate. One merged system message (the Qwen3.6 template rejects two
leading system messages, SPEC 15.4), `max_tokens` 100, streamed from the local OpenAI-compatible server on 8186
(mlx_lm.server with the 27B), or from a scripted stub for CI. Hypothesis generation with synthetic personas: not a
forecast, not a survey, not validated. The engine never imports the sim project; it reads the recorded files."""

from __future__ import annotations

import gzip
import json
import re
import urllib.request
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

LABEL = "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated."
MLX_URL = "http://127.0.0.1:8186/v1/chat/completions"
MAX_TOKENS = 100
SYSTEM = (
    "You are a synthetic persona on an internal discussion forum at a fictional company, answering one interview "
    "question about the proposal below in at most three sentences, in the first person, as your persona plausibly "
    "would. Speak only for yourself. Never name a person, a real company or a product, and never discuss where, when "
    "or how any individual works, their conduct, their performance or their pay."
)
STUB_ANSWER = (
    "[stub] Speaking only for this synthetic persona: I would want to see the published criteria before deciding, "
    "and I would ask how the June window works for people who just missed March."
)
PROPOSAL_ID = re.compile(r"[a-z0-9-]{3,60}")
PERSONA_ID = re.compile(r"P\d{2}")


class InterviewError(ValueError):
    pass


def find_session(recordings: Path, proposal: str) -> Path:
    """The recorded session for a proposal: a model-recorded one when it exists, otherwise the placeholder."""
    if not PROPOSAL_ID.fullmatch(proposal):
        raise InterviewError("unknown proposal")
    found = []
    for session in sorted(recordings.iterdir()) if recordings.is_dir() else []:
        analysis = session / "analysis.json"
        if analysis.is_file():
            a = json.loads(analysis.read_text(encoding="utf-8"))
            if a.get("proposal") == proposal:
                found.append((bool(a.get("placeholder")), session))
    if not found:
        raise InterviewError("no recorded session for this proposal")
    return sorted(found, key=lambda x: x[0])[0][1]


def persona_context(session: Path, persona_id: str, max_posts: int = 6) -> dict:
    """The persona's card (from its recorded voice call) and a digest of its own posts in the main replicate."""
    if not PERSONA_ID.fullmatch(persona_id):
        raise InterviewError("unknown persona")
    main = next(
        (d for d in sorted(session.iterdir()) if d.name.startswith("main-") and (d / "manifest.json").is_file()), None
    )
    if main is None:
        raise InterviewError("the session has no main replicate")
    manifest = json.loads((main / "manifest.json").read_text(encoding="utf-8"))
    persona = next((p for p in manifest["personas"] if p["persona_id"] == persona_id), None)
    if persona is None:
        raise InterviewError("unknown persona")
    card = None
    with gzip.open(main / "calls.jsonl.gz", "rt", encoding="utf-8") as fh:
        for line in fh:
            call = json.loads(line)
            if call.get("purpose") == "voice" and call.get("persona") == persona_id:
                card = call["user"].rsplit("\n\n", 1)[0]
                break
    if card is None:
        raise InterviewError("no recorded card for this persona")
    posts = []
    for line in (main / "actions.jsonl").read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        if row.get("persona") == persona_id and row.get("action") in ("create_post", "create_comment"):
            posts.append(str(row["args"].get("content", "")))
    return {
        "persona_id": persona_id,
        "handle": persona["handle"],
        "card": card,
        "posts": posts[-max_posts:],
        "session": session.name,
        "placeholder": bool(manifest.get("placeholder")),
    }


def messages(ctx: dict, question: str) -> list[dict]:
    q = " ".join(question.split())
    if not q or len(q) > 300:
        raise InterviewError("the question must be 1 to 300 characters")
    digest = "\n".join(f"- {p}" for p in ctx["posts"]) or "- (no posts)"
    system = f"{SYSTEM}\n\n{ctx['card']}\nYour own posts on the forum, oldest first:\n{digest}"
    return [{"role": "system", "content": system}, {"role": "user", "content": q}]


def stream_stub() -> Iterator[str]:
    for word in STUB_ANSWER.split(" "):
        yield word + " "


def stream_mlx(msgs: list[dict], url: str = MLX_URL, timeout: float = 60.0) -> Iterator[str]:
    """Streams the answer's text from an OpenAI-compatible server (server-sent events)."""
    body = {
        "model": "default_model",
        "messages": msgs,
        "max_tokens": MAX_TOKENS,
        "temperature": 0.7,
        "stream": True,
        # the 27B server already starts with thinking off; servers that read it per request get the same setting
        "chat_template_kwargs": {"enable_thinking": False},
    }
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (a fixed local URL)
        for raw in res:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                return
            delta = (json.loads(data).get("choices") or [{}])[0].get("delta") or {}
            if delta.get("content"):
                yield delta["content"]


def append_log(path: Path, ctx: dict, question: str, answer: str, provider: str) -> None:
    """Appends the exchange to a local log outside the committed recordings (scanned before anything is committed)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "at": datetime.now(UTC).isoformat(timespec="seconds"),
        "session": ctx["session"],
        "persona_id": ctx["persona_id"],
        "question": question,
        "answer": answer,
        "provider": provider,
        "label": LABEL,
    }
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, sort_keys=True) + "\n")
