"""The forum (SPEC 15.1, 15.4): OASIS's Reddit platform with its hot-score recommender, driven by StaySignal.

StaySignal owns every model call and applies the resulting actions itself, one at a time in persona order, so a run is
a sequence of `ManualAction`-equivalent calls that replay can feed back without a model. Time is the round, not the
wall clock: `LabClock` returns `start + round x 60 minutes`, because OASIS's Reddit clock reads `datetime.now()` and
hot scores would otherwise depend on inference speed. Agents get a dummy OpenAI-compatible backend on a closed local
port, so camel never builds a default client and nothing can reach a model through OASIS.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from camel.prompts import TextPrompt
from camel.utils import BaseTokenCounter
from oasis import AgentGraph, SocialAgent, UserInfo
from oasis.clock.clock import Clock
from oasis.environment.env import OasisEnv
from oasis.social_platform.channel import Channel
from oasis.social_platform.platform import Platform

PERSONA_TEMPLATE = TextPrompt("You are {handle}, a synthetic persona on an internal discussion forum.")
START = datetime(2026, 10, 5, 9, 0, 0)  # the synthetic clock's demo week; fixed so replays are byte-identical
ACTIONS = (
    "create_post",
    "create_comment",
    "like_post",
    "dislike_post",
    "like_comment",
    "dislike_comment",
    "do_nothing",
)


class LabClock(Clock):
    """Time is `start + round x 60 minutes`; `round` is advanced by the runner, never by wall time."""

    def __init__(self) -> None:
        super().__init__(k=1)
        self.round = 0

    def time_transfer(self, now_time: datetime, start_time: datetime) -> datetime:
        return start_time + timedelta(minutes=60 * self.round)

    def get_time_step(self) -> str:
        return str(self.round)


class CharTokenCounter(BaseTokenCounter):
    """A local estimate (4 characters a token) for camel's agent memory, which the Lab never sends anywhere; the
    default counter would download a tiktoken encoding file at first use."""

    def count_tokens_from_messages(self, messages: list) -> int:
        return sum(len(str(m.get("content", ""))) for m in messages) // 4 + 1

    def encode(self, text: str) -> list[int]:
        return list(range(len(text) // 4 + 1))

    def decode(self, token_ids: list[int]) -> str:
        return ""


def dummy_model():
    """An OpenAI-compatible backend that is never called: the Lab's recording client makes every model call."""
    from camel.models import ModelFactory
    from camel.types import ModelPlatformType

    return ModelFactory.create(
        model_platform=ModelPlatformType.OPENAI_COMPATIBLE_MODEL,
        model_type="default_model",
        url="http://127.0.0.1:9/v1",
        api_key="not-used",
        token_counter=CharTokenCounter(),
    )


class Forum:
    def __init__(self, env: OasisEnv, agents: list[SocialAgent], clock: LabClock, db_path: Path) -> None:
        self.env = env
        self.agents = agents
        self.clock = clock
        self.db_path = db_path

    @classmethod
    async def open(cls, db_path: Path, handles: list[str]) -> Forum:
        db_path.unlink(missing_ok=True)
        clock = LabClock()
        channel = Channel()
        platform = Platform(
            db_path=str(db_path),
            channel=channel,
            sandbox_clock=clock,
            start_time=START,
            recsys_type="reddit",
            allow_self_rating=True,
            show_score=True,
            max_rec_post_len=100,
            refresh_rec_post_count=5,
        )
        graph = AgentGraph()
        model = dummy_model()
        agents = []
        for i, handle in enumerate(handles):
            # OASIS's default Reddit persona prompt asks for gender, age and country; the Lab never uses them, so the
            # agent's own (unused) system message is a fixed template on the handle alone
            info = UserInfo(
                name=handle, description="Synthetic persona", profile={"handle": handle}, recsys_type="reddit"
            )
            agent = SocialAgent(
                agent_id=i,
                user_info=info,
                user_info_template=PERSONA_TEMPLATE,
                channel=channel,
                model=model,
                agent_graph=graph,
            )
            graph.add_agent(agent)
            agents.append(agent)
        env = OasisEnv(agent_graph=graph, platform=platform, database_path=str(db_path))
        await env.reset()
        return cls(env, agents, clock, db_path)

    async def refresh(self, persona: int) -> dict:
        return await self.agents[persona].env.action.refresh()

    async def apply(self, persona: int, action: str, args: dict) -> dict:
        if action not in ACTIONS:
            raise ValueError(f"not a Lab action: {action}")
        if action == "do_nothing":
            return await self.agents[persona].env.action.do_nothing()
        return await self.agents[persona].perform_action_by_data(action, **args)

    async def end_round(self) -> None:
        await self.env.platform.update_rec_table()
        self.clock.round += 1

    async def close(self) -> None:
        await self.env.close()


TABLES_SKIPPED = {"sqlite_sequence"}


def canonical_dump(db_path: Path) -> str:
    """Every table, rows sorted, as canonical JSON: what `test_replay_hash` compares."""
    con = sqlite3.connect(db_path)
    try:
        names = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
        doc = {}
        for name in names:
            if name in TABLES_SKIPPED:
                continue
            cols = [r[1] for r in con.execute(f'PRAGMA table_info("{name}")')]
            rows = [list(r) for r in con.execute(f'SELECT * FROM "{name}"')]
            doc[name] = {"columns": cols, "rows": sorted(rows, key=lambda r: json.dumps(r, default=str))}
        return json.dumps(doc, sort_keys=True, default=str, separators=(",", ":"))
    finally:
        con.close()


def db_hash(db_path: Path) -> str:
    return hashlib.sha256(canonical_dump(db_path).encode()).hexdigest()


__all__ = ["ACTIONS", "START", "Forum", "LabClock", "canonical_dump", "db_hash", "dummy_model"]
