"""The recording client (SPEC 15.4, 15.5): every model call the Lab makes goes through here and is logged.

Request layout: `model: "default_model"`, no `seed`, the system message byte-identical across personas and rounds of
one proposal (rules, the four tools, the status quo and the proposal), and the persona card, a memory digest and the
feed in the user message. Calls are keyed by the SHA-256 of the canonical request, which is how the recorded provider
finds them again and how an interrupted run resumes at a round boundary.

Providers:
- `stub`: deterministic scripted responses chosen from the request hash, every text prefixed "[stub]". It proves the
  pipeline (rounds, actions, replay, analysis) in CI and in placeholder recordings; it is not a model and its text
  says nothing about anyone.
- `recorded`: replays a committed `calls.jsonl.gz` by request hash; a request it has not seen is an error.
- `openai`: an OpenAI-compatible server (the Mac's `mlx_lm.server` with Qwen3.6-27B on 127.0.0.1:8186, started only by
  `scripts/llm.ts`). Not runnable in CI or the cloud.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import io
import json
import random
import time
from pathlib import Path
from typing import Protocol

SAMPLING = {"temperature": 0.7, "top_p": 0.95}
MAX_TOKENS = 220

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "create_post",
            "description": "Start a new thread on the forum.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {"type": "string", "maxLength": 280},
                    "stance": {
                        "type": "integer",
                        "minimum": -2,
                        "maximum": 2,
                        "description": "-2 strongly against the proposal, 2 strongly for",
                    },
                },
                "required": ["content", "stance"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_comment",
            "description": "Reply to a post in your feed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "post_id": {"type": "integer"},
                    "content": {"type": "string", "maxLength": 280},
                    "stance": {"type": "integer", "minimum": -2, "maximum": 2},
                },
                "required": ["post_id", "content", "stance"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "react",
            "description": "Like or dislike a post or a comment in your feed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target_kind": {"type": "string", "enum": ["post", "comment"]},
                    "target_id": {"type": "integer"},
                    "kind": {"type": "string", "enum": ["like", "dislike"]},
                },
                "required": ["target_kind", "target_id", "kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "do_nothing",
            "description": "Read without acting this round.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

RULES = (
    "You are a synthetic persona on an internal discussion forum at a fictional company. React to the proposal below "
    "the way your persona plausibly would, in at most 280 characters, using exactly one tool. Speak only for yourself "
    "and stay on the proposal. Never name a person, a real company or a product, and never discuss where, when or how "
    "any individual works, their conduct, their performance or their pay."
)


def system_message(proposal: dict) -> str:
    return f"{RULES}\n\nToday: {proposal['status_quo']}\nProposed: {proposal['change']}"


def user_message(card: str, digest: list[str], feed: list[dict]) -> str:
    lines = [card, "", "What you posted so far:"] + ([f"- {d}" for d in digest] or ["- nothing yet"])
    lines += ["", "Your feed:"]
    for p in feed:
        lines.append(f"[post {p['post_id']}] {p['content']} (score {p.get('score', 0)})")
        for c in p.get("comments", [])[:3]:
            lines.append(f"  [comment {c['comment_id']} on post {p['post_id']}] {c['content']}")
    if not feed:
        lines.append("(empty)")
    return "\n".join(lines)


def build_request(system: str, user: str, tools: list | None = TOOLS, max_tokens: int = MAX_TOKENS) -> dict:
    req: dict = {
        "model": "default_model",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        **SAMPLING,
        "max_tokens": max_tokens,
    }
    if tools is not None:
        req["tools"] = tools
    return req


def request_sha(req: dict) -> str:
    return hashlib.sha256(
        json.dumps(req, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    ).hexdigest()


class Provider(Protocol):
    name: str

    async def complete(self, req: dict) -> dict: ...


STUB_POSTS = [
    "[stub] What exactly would the published criteria say for moving up a level?",
    "[stub] A June window helps if the criteria are clear before it opens.",
    "[stub] Who decides, and how would the decision be explained?",
    "[stub] More windows could mean more preparation work for everyone.",
    "[stub] I would like to know how this changes what my manager can do.",
    "[stub] Not sure this changes much for people already close to the next level.",
]


class StubProvider:
    """Deterministic scripted responses: the action and the canned text are chosen from the request hash."""

    name = "stub"

    async def complete(self, req: dict) -> dict:
        h = request_sha(req)
        rng = random.Random(int(h[:12], 16))
        user = req["messages"][-1]["content"]
        if "tools" not in req:  # items, coding and voice calls: a JSON or text answer
            return {
                "choices": [{"message": {"content": self._text(user, rng)}}],
                "usage": {"prompt_tokens": len(user) // 4, "completion_tokens": 12},
            }
        post_ids = [int(x) for x in _ids(user, "[post ")]
        comment_ids = [int(x) for x in _ids(user, "[comment ")]
        roll = rng.random()
        if roll < 0.35 or not post_ids:
            call = ("create_post", {"content": rng.choice(STUB_POSTS), "stance": rng.randint(-2, 2)})
        elif roll < 0.6:
            call = (
                "create_comment",
                {"post_id": rng.choice(post_ids), "content": rng.choice(STUB_POSTS), "stance": rng.randint(-2, 2)},
            )
        elif roll < 0.85:
            kind = "comment" if comment_ids and rng.random() < 0.4 else "post"
            target = rng.choice(comment_ids if kind == "comment" else post_ids)
            call = (
                "react",
                {"target_kind": kind, "target_id": target, "kind": "like" if rng.random() < 0.7 else "dislike"},
            )
        else:
            call = ("do_nothing", {})
        msg = {
            "tool_calls": [
                {
                    "id": f"call_{h[:8]}",
                    "type": "function",
                    "function": {"name": call[0], "arguments": json.dumps(call[1])},
                }
            ]
        }
        return {"choices": [{"message": msg}], "usage": {"prompt_tokens": len(user) // 4, "completion_tokens": 30}}

    @staticmethod
    def _text(user: str, rng: random.Random) -> str:
        if '"items"' in user:
            return json.dumps({"items": [rng.randint(1, 5) for _ in range(4)]})
        if '"themes"' in user:
            return json.dumps(
                {
                    "themes": rng.sample(
                        ["criteria_clarity", "process_fairness", "workload", "change_uncertainty", "manager_support"],
                        k=rng.randint(1, 2),
                    )
                }
            )
        return "[stub] Practical, asks about timing."


def _ids(text: str, prefix: str) -> list[str]:
    out = []
    for part in text.split(prefix)[1:]:
        num = part.split("]", 1)[0].split(" ", 1)[0]
        if num.isdigit():
            out.append(num)
    return out


class RecordedProvider:
    """Answers from a recording's calls, by request hash."""

    name = "recorded"

    def __init__(self, calls_path: Path) -> None:
        self.by_sha: dict[str, dict] = {}
        with gzip.open(calls_path, "rt", encoding="utf-8") as fh:
            for line in fh:
                c = json.loads(line)
                self.by_sha[c["request_sha256"]] = c["response"]

    async def complete(self, req: dict) -> dict:
        sha = request_sha(req)
        if sha not in self.by_sha:
            raise KeyError(f"no recorded call for request {sha[:12]}")
        return self.by_sha[sha]


class OpenAICompatibleProvider:
    """The Mac's mlx_lm.server (OpenAI-compatible); never used in CI or the cloud."""

    name = "openai"

    def __init__(self, url: str = "http://127.0.0.1:8186/v1/chat/completions", timeout: float = 300.0) -> None:
        self.url = url
        self.timeout = timeout

    async def complete(self, req: dict) -> dict:
        import httpx

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(self.url, json=req)
            r.raise_for_status()
            return r.json()


class Recorder:
    """Wraps a provider and logs every call: request hash, the user message (the system message once, by hash), the
    response, usage and latency. `applied` is filled in by the runner once the action is applied."""

    def __init__(self, provider: Provider) -> None:
        self.provider = provider
        self.calls: list[dict] = []
        self.systems: dict[str, str] = {}

    async def call(
        self, req: dict, purpose: str, persona: str | None = None, round_: int | None = None
    ) -> tuple[dict, int]:
        sha = request_sha(req)
        system = req["messages"][0]["content"]
        sys_sha = hashlib.sha256(system.encode()).hexdigest()
        self.systems[sys_sha] = system
        t0 = time.perf_counter()
        resp = await self.provider.complete(req)
        latency = round((time.perf_counter() - t0) * 1000)
        self.calls.append(
            {
                "request_sha256": sha,
                "purpose": purpose,
                "persona": persona,
                "round": round_,
                "system_sha256": sys_sha,
                "user": req["messages"][-1]["content"],
                "response": resp,
                "usage": resp.get("usage", {}),
                "latency_ms": latency if self.provider.name == "openai" else 0,
                "applied": None,
            }
        )
        return resp, len(self.calls) - 1

    async def gather(self, reqs: list[tuple[dict, str, str | None, int | None]]) -> list[tuple[dict, int]]:
        return list(await asyncio.gather(*(self.call(*r) for r in reqs)))

    def write(self, run_dir: Path) -> None:
        # mtime 0 keeps the gzip header, and so the committed file, identical for identical calls
        with (
            gzip.GzipFile(run_dir / "calls.jsonl.gz", "wb", compresslevel=9, mtime=0) as raw,
            io.TextIOWrapper(raw, encoding="utf-8") as fh,
        ):
            for c in self.calls:
                fh.write(json.dumps(c, sort_keys=True, ensure_ascii=False) + "\n")
        (run_dir / "systems.json").write_text(json.dumps(self.systems, indent=1, sort_keys=True) + "\n")


__all__ = [
    "MAX_TOKENS",
    "SAMPLING",
    "TOOLS",
    "OpenAICompatibleProvider",
    "RecordedProvider",
    "Recorder",
    "StubProvider",
    "build_request",
    "request_sha",
    "system_message",
    "user_message",
]
