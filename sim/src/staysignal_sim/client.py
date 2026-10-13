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
            return json.dumps({"items": [rng.randint(1, 5) for _ in range(5)]})
        if user.startswith("Codebook:"):
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


# Every token of the Qwen3.6-27B tokenizer (mlx-community/Qwen3.6-27B-4bit, snapshot c000ac2c) whose text holds an en
# or em dash. The public hygiene tier rejects those characters in committed text, and a recorded call is never
# hand-edited (SPEC 15.5, 22.6), so the openai provider bans them at sampling time with a logit bias of -100; the
# manifest records it under `sampling`.
NO_DASH_TOKEN_IDS = (
    1317, 1892, 2218, 4006, 8283, 15744, 16312, 21010, 27090, 28630, 32963, 36203, 38697, 42064, 46812, 47267, 47853,
    48944, 48952, 50649, 52510, 57541, 58180, 60537, 60723, 62804, 65467, 67728, 67999, 68801, 72418, 73238, 76273,
    78015, 79916, 80950, 81357, 82280, 82957, 83173, 83581, 84830, 86674, 89534, 91814, 92933, 95060, 177177, 180201,
    184142, 197005, 200228, 211741, 216119, 216120, 230118, 236392, 242602,
)  # fmt: skip


class OpenAICompatibleProvider:
    """The Mac's mlx_lm.server (OpenAI-compatible); never used in CI or the cloud. Requests are sent as built, plus the
    dash ban (`logit_bias`), which is model-specific and so not part of the request hash."""

    name = "openai"
    model = "Qwen3.6-27B (mlx-community/Qwen3.6-27B-4bit, mlx_lm.server)"
    sampling_note = {
        "logit_bias": {
            "bias": -100,
            "tokens": len(NO_DASH_TOKEN_IDS),
            "why": "en and em dash tokens banned at sampling time (public hygiene tier)",
        }
    }

    def __init__(self, url: str = "http://127.0.0.1:8186/v1/chat/completions", timeout: float = 600.0) -> None:
        self.url = url
        self.timeout = timeout

    async def complete(self, req: dict) -> dict:
        import httpx

        body = {**req, "logit_bias": {str(i): -100.0 for i in NO_DASH_TOKEN_IDS}}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            r = await client.post(self.url, json=body)
            r.raise_for_status()
            return r.json()


class CachedProvider:
    """A request cache in front of a live provider (SPEC 15.5: an interrupted run resumes where it stopped). A replicate
    is deterministic given its responses, so rerunning `lab:record` reaches the same requests and answers them from
    the cache until the first new one. Identical requests share one response, in flight or cached. The cache lives
    under var/ (never committed); delete it, or pass `--fresh`, to record anew."""

    def __init__(self, inner: Provider, path: Path) -> None:
        self.inner = inner
        self.name = inner.name
        self.model = getattr(inner, "model", None)
        self.sampling_note = getattr(inner, "sampling_note", {})
        self.path = path
        self.entries: dict[str, dict] = {}
        self.inflight: dict[str, asyncio.Future] = {}
        self.hits = 0
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    e = json.loads(line)
                    self.entries[e["request_sha256"]] = e

    def latency_ms(self, sha: str) -> int | None:
        e = self.entries.get(sha)
        return e["latency_ms"] if e else None

    async def complete(self, req: dict) -> dict:
        sha = request_sha(req)
        if sha in self.entries:
            self.hits += 1
            return self.entries[sha]["response"]
        if sha in self.inflight:
            return await self.inflight[sha]
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.inflight[sha] = fut
        try:
            t0 = time.perf_counter()
            resp = await self.inner.complete(req)
            entry = {"request_sha256": sha, "response": resp, "latency_ms": round((time.perf_counter() - t0) * 1000)}
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, sort_keys=True, ensure_ascii=False) + "\n")
            self.entries[sha] = entry
            fut.set_result(resp)
            return resp
        except BaseException as e:
            fut.set_exception(e)
            fut.exception()  # mark retrieved when nobody else awaits it
            raise
        finally:
            del self.inflight[sha]


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
        cached = getattr(self.provider, "latency_ms", None)
        if cached is not None and cached(sha) is not None:
            latency = cached(sha)  # a resumed run keeps the latency of the call that produced the response
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

    def write(self, run_dir: Path, name: str = "calls.jsonl.gz", systems: bool = True) -> None:
        # mtime 0 keeps the gzip header, and so the committed file, identical for identical calls
        with (
            gzip.GzipFile(run_dir / name, "wb", compresslevel=9, mtime=0) as raw,
            io.TextIOWrapper(raw, encoding="utf-8") as fh,
        ):
            for c in self.calls:
                fh.write(json.dumps(c, sort_keys=True, ensure_ascii=False) + "\n")
        if systems:
            (run_dir / "systems.json").write_text(json.dumps(self.systems, indent=1, sort_keys=True) + "\n")


__all__ = [
    "MAX_TOKENS",
    "NO_DASH_TOKEN_IDS",
    "SAMPLING",
    "TOOLS",
    "CachedProvider",
    "OpenAICompatibleProvider",
    "RecordedProvider",
    "Recorder",
    "StubProvider",
    "build_request",
    "request_sha",
    "system_message",
    "user_message",
]
