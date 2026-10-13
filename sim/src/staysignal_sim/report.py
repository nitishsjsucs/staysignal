"""Draft pilot items and the wording linter (SPEC 15.6).

`draft_items` turns the most frequent coded themes that have a construct in `lab/constructs.yaml` into 5 to 8 draft
items, each with its construct, a labeled 5-point scale, a rationale and at least 2 quoted posts from at least 2
cohorts. Wording comes from fixed, neutral templates per construct (`source: "template"`); the model-written report
agent of SPEC 15.6 replaces it once real recordings exist. Where a validated measure exists the item cites it and
recommends it over the draft. Every item is labeled as a draft that needs cognitive pretesting and a properly
sampled, consented pilot. The linter's findings are shown next to each item.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import yaml

from staysignal_sim.personas import repo_root

DRAFT_LABEL = "Draft item: needs cognitive pretesting and a properly sampled, consented pilot"
SCALE = ["Strongly disagree", "Disagree", "Neither agree nor disagree", "Agree", "Strongly agree"]
TEMPLATES = {
    "criteria_clarity": "I understand what is required to be promoted to the next level.",
    "process_fairness": "Promotion decisions are made using consistent criteria.",
    "change_uncertainty": "I understand how the proposed change would affect me.",
    "team_identity": "I feel part of my team.",
    "manager_support": "My manager helps me understand my path to the next level.",
    "career_future": "I can see a future for my career here.",
}
MIN_ITEMS, MAX_ITEMS = 5, 8
LEADING = re.compile(r"\b(obviously|clearly|surely|don't you|wouldn't you|isn't it|agree that|of course)\b", re.I)
DOUBLE = re.compile(r"\b(and|or|as well as)\b", re.I)


def constructs(root: Path | None = None) -> dict[str, dict]:
    return {
        c["id"]: c
        for c in yaml.safe_load(((root or repo_root()) / "lab" / "constructs.yaml").read_text())["constructs"]
    }


def lint(wording: str, scale: list[str]) -> list[str]:
    """Findings for one item: double-barreled or leading wording, and an unlabeled or unbalanced scale."""
    found = []
    if DOUBLE.search(wording):
        found.append("possibly double-barreled: joins two statements")
    if LEADING.search(wording):
        found.append("leading wording")
    if wording.count("?") or len(wording) > 140:
        found.append("not a short statement")
    if len(scale) != 5 or any(not s.strip() for s in scale):
        found.append("scale is not five labeled points")
    elif not (
        scale[0].lower().startswith("strongly")
        and scale[-1].lower().startswith("strongly")
        and "neither" in scale[2].lower()
    ):
        found.append("scale is not balanced around a labeled midpoint")
    return found


def _quotes(runs: list[tuple[dict, Path]], theme: str) -> list[dict]:
    """Posts coded with the theme, at most one per cohort first, so quotes span cohorts."""
    from staysignal_sim.analysis import TENURE_POOL

    found = []
    for m, d in runs:
        acts = [json.loads(line) for line in (d / "actions.jsonl").read_text().splitlines()]
        band = {p["persona_id"]: TENURE_POOL.get(p["tenure_band"], "other") for p in m["personas"]}
        for c in (json.loads(line) for line in (d / "coding.jsonl").read_text().splitlines()):
            if theme in c["themes"]:
                found.append(
                    {
                        "text": acts[c["action"]]["args"]["content"],
                        "cohort": band.get(c["persona"], "other"),
                        "replicate": m["seed"],
                    }
                )
    seen, first, rest = set(), [], []
    for q in found:
        (first if q["cohort"] not in seen else rest).append(q)
        seen.add(q["cohort"])
    return (first + rest)[:3]


def draft_items(runs: list[tuple[dict, Path]]) -> list[dict]:
    cons = constructs()
    counts: Counter = Counter()
    for _, d in runs:
        for line in (d / "coding.jsonl").read_text().splitlines():
            counts.update(json.loads(line)["themes"])
    ranked = [t for t, _ in counts.most_common() if t in cons and t in TEMPLATES]
    chosen = ranked[:MAX_ITEMS]
    for extra in ("career_future", *TEMPLATES):  # pad to the minimum with constructs the study always measures
        if len(chosen) >= MIN_ITEMS:
            break
        if extra not in chosen and extra in cons:
            chosen.append(extra)
    out = []
    total = sum(counts.values()) or 1
    for cid in chosen:
        quotes = _quotes(runs, cid)
        validated = cons[cid].get("validated_measure")
        out.append(
            {
                "construct": cid,
                "construct_label": cons[cid]["label"],
                "wording": TEMPLATES[cid],
                "source": "template",
                "scale": SCALE,
                "rationale": f"{counts[cid]} of {total} theme codes ({counts[cid] / total:.0%}) across the main replicates"
                if counts[cid]
                else "measured in every session (no coded theme)",
                "quotes": quotes,
                "quotes_span_cohorts": len({q["cohort"] for q in quotes}) >= 2,
                "validated_measure": validated,
                "recommendation": f"Use the validated measure ({validated}) instead of this draft wording."
                if validated
                else None,
                "lint": lint(TEMPLATES[cid], SCALE),
                "label": DRAFT_LABEL,
            }
        )
    return out


__all__ = ["DRAFT_LABEL", "SCALE", "TEMPLATES", "constructs", "draft_items", "lint"]
