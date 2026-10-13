"""One recorded replicate (SPEC 15.3 to 15.5) and its replay.

A replicate is one proposal, one card variant and one seed: personas answer the pre items, then each round the
active personas (drawn from their activation priors with `random` seeded from (seed, round), ordered by influence)
refresh their feed, all their model calls go out concurrently through the recorder, and the returned actions are
applied one at a time in persona ID order; the round ends with one recommender update. The program office posts an
FAQ in round 3 and opens a manager AMA in round 5. Post items follow the last round, asked with the persona's own
posts and the last feed it read.

Everything the forum needs to be rebuilt is in `actions.jsonl` (including round ends and the program office's
posts), so `replay` reapplies it to a fresh forum with no model and must reproduce the manifest's database hash.
"""

from __future__ import annotations

import json
import random
from datetime import UTC, datetime
from pathlib import Path

from staysignal_sim import LABEL
from staysignal_sim.client import Provider, Recorder, build_request, system_message, user_message
from staysignal_sim.forum import Forum, db_hash
from staysignal_sim.personas import Persona, card, personas_for, variant

PROGRAM_OFFICE = "Program office"
FAQ_ROUND, AMA_ROUND = 3, 5  # 1-based rounds
AMA_TEXT = "Program office: a manager will answer questions about the proposal in this thread. Ask anything."
SCALE = ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"]
ITEMS = [
    {"id": "support", "text": "I support the proposed change.", "reverse": False},
    {"id": "clarity", "text": "It is clear what it takes to be promoted here.", "reverse": False},
    {"id": "clarity_rev", "text": "It is unclear what it takes to be promoted here.", "reverse": True},
    {"id": "fairness", "text": "Promotion decisions here are made fairly.", "reverse": False},
    {"id": "career", "text": "I can see a future for my career here.", "reverse": False},  # scored as concern
]
CONFIGS = {
    "main": {"personas": 16, "rounds": 8},
    "control": {"personas": 16, "rounds": 4},
    "rehearsal": {"personas": 8, "rounds": 4},
}


def items_prompt(c: str, descending: bool) -> str:
    scale = list(enumerate(SCALE, start=1))
    if descending:
        scale = scale[::-1]
    points = "; ".join(f"{n} = {label}" for n, label in scale)
    lines = [
        c,
        "",
        f"Answer each statement on this scale ({points}).",
        'Reply with JSON only: {"items": [five numbers in order]}.',
    ]
    lines += [f"{i + 1}. {it['text']}" for i, it in enumerate(ITEMS)]
    return "\n".join(lines)


def parse_items(text: str) -> list[int] | None:
    try:
        vals = json.loads(text[text.index("{") : text.rindex("}") + 1])["items"]
        vals = [int(v) for v in vals][: len(ITEMS)]
        return vals if len(vals) == len(ITEMS) and all(1 <= v <= 5 for v in vals) else None
    except (ValueError, KeyError, TypeError):
        return None


def parse_action(resp: dict) -> tuple[str, dict, str | None]:
    """The first tool call, or do_nothing with the reason it could not be used."""
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    calls = msg.get("tool_calls") or []
    if not calls:
        return "do_nothing", {}, "no tool call"
    fn = calls[0].get("function") or {}
    try:
        args = json.loads(fn.get("arguments") or "{}")
    except json.JSONDecodeError:
        return "do_nothing", {}, "arguments are not JSON"
    return fn.get("name") or "do_nothing", args, None


def to_oasis(name: str, args: dict, feed: list[dict]) -> tuple[str, dict, int | None, str | None]:
    """Maps a Lab tool call to an OASIS action, validating it against the persona's feed."""
    posts = {p["post_id"] for p in feed}
    comments = {c["comment_id"] for p in feed for c in p.get("comments", [])}
    stance = args.get("stance")
    stance = int(stance) if isinstance(stance, int | float) and -2 <= stance <= 2 else None
    content = str(args.get("content", ""))[:280]
    if name == "create_post" and content:
        return "create_post", {"content": content}, stance, None
    if name == "create_comment" and content and args.get("post_id") in posts:
        return "create_comment", {"post_id": args["post_id"], "content": content}, stance, None
    if name == "react" and args.get("kind") in ("like", "dislike"):
        kind, target = args.get("target_kind"), args.get("target_id")
        if kind == "post" and target in posts:
            return f"{args['kind']}_post", {"post_id": target}, None, None
        if kind == "comment" and target in comments:
            return f"{args['kind']}_comment", {"comment_id": target}, None, None
    if name == "do_nothing":
        return "do_nothing", {}, None, None
    return "do_nothing", {}, None, f"invalid {name}"


async def run_replicate(
    proposal: dict,
    cells_doc: dict,
    card_variant: str,
    seed: int,
    config: str,
    provider: Provider,
    out_dir: Path,
) -> dict:
    cfg = CONFIGS[config]
    personas: list[Persona] = variant(personas_for(proposal, cells_doc), card_variant, seed)[: cfg["personas"]]
    out_dir.mkdir(parents=True, exist_ok=True)
    rec = Recorder(provider)
    system = system_message(proposal)
    forum = await Forum.open(out_dir / "forum.db", [p.handle for p in personas] + [PROGRAM_OFFICE])
    po = len(personas)
    actions: list[dict] = []
    items: list[dict] = []
    digests: dict[str, list[str]] = {p.persona_id: [] for p in personas}

    voices: dict[str, str] = {}
    for p, (resp, _) in zip(
        personas,
        await rec.gather(
            [
                (
                    build_request(
                        system,
                        card(p, proposal, None) + "\n\nDescribe how this persona talks, in one line.",
                        tools=None,
                        max_tokens=40,
                    ),
                    "voice",
                    p.persona_id,
                    None,
                )
                for p in personas
            ]
        ),
        strict=True,
    ):
        voices[p.persona_id] = ((resp["choices"][0]["message"].get("content") or "").strip().splitlines() or [""])[0][
            :160
        ]

    last_feed: dict[str, list[dict]] = {}

    async def ask_items(phase: str) -> None:
        reqs = []
        for p in personas:
            descending = random.Random(f"{seed}:{p.persona_id}:scale").random() < 0.5
            context = card(p, proposal, voices[p.persona_id])
            if phase == "post":
                # after the rounds the persona answers with what it posted and the last feed it read, so the post items
                # can differ from the pre items for a reason (an identical request would also share one cached answer)
                context = (
                    user_message(context, digests[p.persona_id][-3:], last_feed.get(p.persona_id, []))
                    + "\n\nThe discussion has ended."
                )
            reqs.append(
                (
                    build_request(
                        system,
                        items_prompt(context, descending),
                        tools=None,
                        max_tokens=40,
                    ),
                    f"items_{phase}",
                    p.persona_id,
                    None,
                )
            )
        for p, (resp, idx) in zip(personas, await rec.gather(reqs), strict=True):
            vals = parse_items(resp["choices"][0]["message"].get("content") or "")
            items.append(
                {
                    "phase": phase,
                    "persona": p.persona_id,
                    "cell_id": p.cell_id,
                    "tenure_band": p.tenure_band,
                    "values": vals,
                    "call": idx,
                }
            )

    await ask_items("pre")
    for r in range(1, cfg["rounds"] + 1):
        # OASIS's recommender samples feeds with the global `random`: seeded from (seed, round) and logged, so replay
        # seeds it at the same point
        value = f"{seed}:{r}"
        random.seed(value)
        actions.append(
            {
                "round": r,
                "persona": None,
                "action": "seed",
                "args": {"value": value},
                "stance": None,
                "call": None,
                "invalid": None,
            }
        )
        if r == FAQ_ROUND:
            asked = [a["args"]["content"] for a in actions if a["action"] in ("create_post", "create_comment")][-12:]
            faq_req = build_request(
                system,
                "You are the program office. Write one FAQ post (at most 280 characters) answering the questions most asked so far:\n"
                + "\n".join(f"- {q}" for q in asked),
                tools=None,
                max_tokens=120,
            )
            resp, idx = await rec.call(faq_req, "event_faq", PROGRAM_OFFICE, r)
            text = "Program office FAQ: " + (resp["choices"][0]["message"].get("content") or "").strip()[:260]
            await forum.apply(po, "create_post", {"content": text})
            actions.append(
                {
                    "round": r,
                    "persona": PROGRAM_OFFICE,
                    "action": "create_post",
                    "args": {"content": text},
                    "stance": None,
                    "call": idx,
                    "invalid": None,
                }
            )
        if r == AMA_ROUND:
            await forum.apply(po, "create_post", {"content": AMA_TEXT})
            actions.append(
                {
                    "round": r,
                    "persona": PROGRAM_OFFICE,
                    "action": "create_post",
                    "args": {"content": AMA_TEXT},
                    "stance": None,
                    "call": None,
                    "invalid": None,
                }
            )
        rng = random.Random(f"{seed}:{r}")
        active = [p for p in personas if rng.random() < p.activation]
        active.sort(key=lambda p: (-p.influence, p.persona_id))
        feeds = {}
        reqs = []
        for p in active:
            i = personas.index(p)
            feed = (await forum.refresh(i)).get("posts", [])
            feeds[p.persona_id] = feed
            last_feed[p.persona_id] = feed
            # OASIS records each refresh in its trace table, so replay must refresh too
            actions.append(
                {
                    "round": r,
                    "persona": p.persona_id,
                    "action": "refresh",
                    "args": {},
                    "stance": None,
                    "call": None,
                    "invalid": None,
                }
            )
            reqs.append(
                (
                    build_request(
                        system, user_message(card(p, proposal, voices[p.persona_id]), digests[p.persona_id][-3:], feed)
                    ),
                    "action",
                    p.persona_id,
                    r,
                )
            )
        results = await rec.gather(reqs)
        for p, (resp, idx) in sorted(zip(active, results, strict=True), key=lambda x: x[0].persona_id):
            name, args, problem = parse_action(resp)
            action, oargs, stance, invalid = to_oasis(name, args, feeds[p.persona_id])
            await forum.apply(personas.index(p), action, oargs)
            rec.calls[idx]["applied"] = action
            actions.append(
                {
                    "round": r,
                    "persona": p.persona_id,
                    "action": action,
                    "args": oargs,
                    "stance": stance,
                    "call": idx,
                    "invalid": problem or invalid,
                }
            )
            if action in ("create_post", "create_comment"):
                digests[p.persona_id].append(oargs["content"])
        await forum.end_round()
        actions.append(
            {
                "round": r,
                "persona": None,
                "action": "end_round",
                "args": {},
                "stance": None,
                "call": None,
                "invalid": None,
            }
        )
    await ask_items("post")
    await forum.close()

    manifest = {
        "label": LABEL,
        "proposal": proposal["id"],
        "card_variant": card_variant,
        "seed": seed,
        "config": {"name": config, **cfg, "faq_round": FAQ_ROUND, "ama_round": AMA_ROUND},
        "provider": provider.name,
        "model": getattr(provider, "model", None),
        "placeholder": provider.name == "stub",
        "sampling": {"temperature": 0.7, "top_p": 0.95, **getattr(provider, "sampling_note", {})},
        "personas": [
            {
                "persona_id": p.persona_id,
                "cell_id": p.cell_id,
                "handle": p.handle,
                "tenure_band": p.tenure_band,
                "level_band": p.level_band,
                "voice": voices[p.persona_id],
            }
            for p in personas
        ],
        "calls": len(rec.calls),
        "db_sha256": db_hash(out_dir / "forum.db"),
        "recorded_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if provider.name != "stub" else None,
    }
    rec.write(out_dir)
    (out_dir / "actions.jsonl").write_text("".join(json.dumps(a, sort_keys=True) + "\n" for a in actions))
    (out_dir / "items.jsonl").write_text("".join(json.dumps(i, sort_keys=True) + "\n" for i in items))
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    (out_dir / "forum.db").unlink()  # rebuilt by replay; not committed
    return manifest


async def replay(run_dir: Path, work: Path) -> str:
    """Rebuilds the forum from actions.jsonl with no model and returns its database hash."""
    manifest = json.loads((run_dir / "manifest.json").read_text())
    handles = [p["handle"] for p in manifest["personas"]] + [PROGRAM_OFFICE]
    index = {p["persona_id"]: i for i, p in enumerate(manifest["personas"])} | {
        PROGRAM_OFFICE: len(manifest["personas"])
    }
    forum = await Forum.open(work / "replay.db", handles)
    for line in (run_dir / "actions.jsonl").read_text().splitlines():
        a = json.loads(line)
        if a["action"] == "seed":
            random.seed(a["args"]["value"])
        elif a["action"] == "end_round":
            await forum.end_round()
        elif a["action"] == "refresh":
            await forum.refresh(index[a["persona"]])
        else:
            await forum.apply(index[a["persona"]], a["action"], a["args"])
    await forum.close()
    return db_hash(work / "replay.db")


__all__ = ["CONFIGS", "ITEMS", "PROGRAM_OFFICE", "parse_action", "parse_items", "replay", "run_replicate", "to_oasis"]
