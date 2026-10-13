"""Analysis of a recorded session (SPEC 15.6): the main replicates of one proposal, plus its two controls.

- Themes: the share of coded posts per codebook theme, mean and range across replicates, and per-round counts for the
  top 4 themes.
- Trajectories: mean stance per round pooled to three tenure bands (under 1 year, 1 to 3 years, 3 years or more), with
  the replicate range; pre and post item means and shifts, and the acquiescence index per replicate.
- Network: the simulated reply and reaction graph (who replied to or reacted to whom), PageRank by a 20-line power
  iteration and a seeded force layout for stable screenshots. Nodes carry their cohort only, never a handle.
- Draft pilot items from the top themes (`report.py`) with the wording linter's findings.

Variation across replicates is reported; the size of persona sentiment is not interpreted. Synthetic personas only.
"""

from __future__ import annotations

import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

from staysignal_sim import LABEL
from staysignal_sim.run import ITEMS

TENURE_POOL = {"<1y": "under 1 year", "1-3y": "1 to 3 years", "3-5y": "3 years or more", "5y+": "3 years or more"}
POOLS = ("under 1 year", "1 to 3 years", "3 years or more")


def _read(run_dir: Path, name: str) -> list[dict]:
    p = run_dir / name
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


def _band(manifest: dict, persona: str) -> str | None:
    for p in manifest["personas"]:
        if p["persona_id"] == persona:
            return TENURE_POOL.get(p["tenure_band"])
    return None


def _range(xs: list[float]) -> dict:
    xs = [x for x in xs if x is not None]
    if not xs:
        return {"mean": None, "min": None, "max": None}
    return {"mean": round(sum(xs) / len(xs), 4), "min": round(min(xs), 4), "max": round(max(xs), 4)}


def themes(runs: list[tuple[dict, Path]]) -> dict:
    per_run: list[Counter] = []
    by_round: dict[str, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
    for _, d in runs:
        coded = _read(d, "coding.jsonl")
        c = Counter(t for x in coded for t in x["themes"])
        per_run.append(c)
        rounds = Counter((t, x["round"]) for x in coded for t in x["themes"])
        for (t, r), n in rounds.items():
            by_round[t][r].append(n)
    names = sorted({t for c in per_run for t in c})
    shares = {}
    for t in names:
        vals = [c[t] / max(1, sum(c.values())) for c in per_run]
        shares[t] = _range(vals)
    ranked = sorted(names, key=lambda t: (-(shares[t]["mean"] or 0), t))
    rounds = max((r for t in by_round for r in by_round[t]), default=0)
    spark = {t: [round(sum(by_round[t].get(r, [0])) / len(runs), 3) for r in range(1, rounds + 1)] for t in ranked[:4]}
    return {"shares": [{"theme": t, **shares[t]} for t in ranked], "top_by_round": spark, "replicates": len(runs)}


def trajectories(runs: list[tuple[dict, Path]]) -> dict:
    per_run: list[dict[str, dict[int, list[int]]]] = []
    for m, d in runs:
        acc: dict[str, dict[int, list[int]]] = defaultdict(lambda: defaultdict(list))
        for a in _read(d, "actions.jsonl"):
            if a.get("stance") is not None and (band := _band(m, a["persona"])):
                acc[band][a["round"]].append(a["stance"])
        per_run.append(acc)
    rounds = max((m["config"]["rounds"] for m, _ in runs), default=0)
    out = {}
    for band in POOLS:
        out[band] = [
            _range([sum(acc[band][r]) / len(acc[band][r]) if acc[band][r] else None for acc in per_run])
            for r in range(1, rounds + 1)
        ]
    return {"stance_by_round": out, "scale": "-2 strongly against the proposal to 2 strongly for"}


def item_shifts(runs: list[tuple[dict, Path]]) -> dict:
    ids = [it["id"] for it in ITEMS]
    pre_means, post_means, acq = defaultdict(list), defaultdict(list), []
    for _, d in runs:
        rows = _read(d, "items.jsonl")
        for phase, target in (("pre", pre_means), ("post", post_means)):
            vals = [r["values"] for r in rows if r["phase"] == phase and r["values"]]
            for k, item in enumerate(ids):
                if vals:
                    target[item].append(sum(v[k] for v in vals) / len(vals))
        pre = [r["values"] for r in rows if r["phase"] == "pre" and r["values"]]
        ci, cr = ids.index("clarity"), ids.index("clarity_rev")
        # agreeing with an item and with its reverse-keyed partner is acquiescence: 0 means none
        acq.append(sum((v[ci] + v[cr]) / 2 - 3 for v in pre) / len(pre) if pre else None)
    out = {}
    for item in ids:
        pre, post = _range(pre_means[item]), _range(post_means[item])
        shift = [b - a for a, b in zip(pre_means[item], post_means[item], strict=False)]
        out[item] = {"pre": pre, "post": post, "shift": _range(shift)}
    return {
        "items": out,
        "acquiescence_index": _range(acq),
        "note": "internal measures of synthetic personas, not survey results",
    }


def pagerank(
    nodes: list[str], edges: list[tuple[str, str, float]], d: float = 0.85, iters: int = 100
) -> dict[str, float]:
    n = len(nodes)
    out_w: dict[str, float] = defaultdict(float)
    for a, _, w in edges:
        out_w[a] += w
    pr = dict.fromkeys(nodes, 1 / n)
    for _ in range(iters):
        nxt = dict.fromkeys(nodes, (1 - d) / n)
        dangling = sum(pr[v] for v in nodes if out_w[v] == 0)
        for v in nodes:
            nxt[v] += d * dangling / n
        for a, b, w in edges:
            nxt[b] += d * pr[a] * w / out_w[a]
        pr = nxt
    return {v: round(x, 6) for v, x in pr.items()}


def layout(
    nodes: list[str], edges: list[tuple[str, str, float]], seed: int, iters: int = 200
) -> dict[str, tuple[float, float]]:
    """Fruchterman-Reingold on the unit square from a seeded start: the same graph always draws the same."""
    rng = random.Random(seed)
    pos = {v: [rng.random(), rng.random()] for v in nodes}
    k = math.sqrt(1 / max(1, len(nodes)))
    for step in range(iters):
        t = 0.1 * (1 - step / iters)
        disp = {v: [0.0, 0.0] for v in nodes}
        for i, a in enumerate(nodes):
            for b in nodes[i + 1 :]:
                dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
                dist = math.hypot(dx, dy) or 1e-6
                f = k * k / dist
                disp[a][0] += dx / dist * f
                disp[a][1] += dy / dist * f
                disp[b][0] -= dx / dist * f
                disp[b][1] -= dy / dist * f
        for a, b, _ in edges:
            dx, dy = pos[a][0] - pos[b][0], pos[a][1] - pos[b][1]
            dist = math.hypot(dx, dy) or 1e-6
            f = dist * dist / k
            disp[a][0] -= dx / dist * f
            disp[a][1] -= dy / dist * f
            disp[b][0] += dx / dist * f
            disp[b][1] += dy / dist * f
        for v in nodes:
            dx, dy = disp[v]
            dist = math.hypot(dx, dy) or 1e-6
            pos[v][0] = min(1.0, max(0.0, pos[v][0] + dx / dist * min(dist, t)))
            pos[v][1] = min(1.0, max(0.0, pos[v][1] + dy / dist * min(dist, t)))
    return {v: (round(x, 4), round(y, 4)) for v, (x, y) in pos.items()}


def network(manifest: dict, run_dir: Path) -> dict:
    """The first main replicate's reply and reaction graph. Node IDs are anonymous (N1, N2, ...) with a cohort label."""
    acts = _read(run_dir, "actions.jsonl")
    author: dict[tuple[str, int], str] = {}
    posts = comments = 0
    edges: Counter = Counter()
    for a in acts:
        if a["action"] == "create_post":
            posts += 1
            author[("post", posts)] = a["persona"]
        elif a["action"] == "create_comment":
            comments += 1
            author[("comment", comments)] = a["persona"]
            target = author.get(("post", a["args"]["post_id"]))
            if target and target != a["persona"]:
                edges[(a["persona"], target)] += 1
        elif a["action"].endswith(("_post", "_comment")) and a["action"].split("_")[0] in ("like", "dislike"):
            kind = "post" if a["action"].endswith("_post") else "comment"
            target = author.get((kind, a["args"][f"{kind}_id"]))
            if target and target != a["persona"]:
                edges[(a["persona"], target)] += 1
    personas = [p["persona_id"] for p in manifest["personas"]]
    anon = {pid: f"N{i + 1}" for i, pid in enumerate(personas)} | {"Program office": "PO"}
    nodes = [anon[p] for p in personas] + ["PO"]
    e = [(anon[a], anon[b], float(w)) for (a, b), w in sorted(edges.items()) if a in anon and b in anon]
    pr = pagerank(nodes, e)
    pos = layout(nodes, e, seed=manifest["seed"])
    cohort = {anon[p["persona_id"]]: TENURE_POOL.get(p["tenure_band"], "other") for p in manifest["personas"]} | {
        "PO": "program office"
    }
    return {
        "label": "Simulated, not organizational network analysis",
        "nodes": [{"id": v, "cohort": cohort[v], "pagerank": pr[v], "x": pos[v][0], "y": pos[v][1]} for v in nodes],
        "edges": [{"source": a, "target": b, "weight": w} for a, b, w in e],
    }


def analyze(session_dir: Path) -> dict:
    """Reads every replicate under `session_dir/<run>/` and writes nothing; `staysignal_sim.cli` writes analysis.json."""
    from staysignal_sim.report import draft_items

    runs = []
    for d in sorted(p for p in session_dir.iterdir() if (p / "manifest.json").exists()):
        runs.append((json.loads((d / "manifest.json").read_text()), d))
    main = [(m, d) for m, d in runs if m["card_variant"] == "main"]
    controls = {v: [(m, d) for m, d in runs if m["card_variant"] == v] for v in ("facts_removed", "facts_shuffled")}
    if not main:
        raise ValueError(f"no main replicate in {session_dir}")
    doc = {
        "label": LABEL,
        "proposal": main[0][0]["proposal"],
        "placeholder": any(m["placeholder"] for m, _ in runs),
        "replicates": {
            "main": [m["seed"] for m, _ in main],
            **{k: [m["seed"] for m, _ in v] for k, v in controls.items()},
        },
        "themes": themes(main),
        "trajectories": trajectories(main),
        "items": item_shifts(main),
        "controls": {k: item_shifts(v) for k, v in controls.items() if v},
        "network": network(*main[0]),
        "pilot_items": draft_items(main),
    }
    return doc


__all__ = ["analyze", "item_shifts", "layout", "network", "pagerank", "themes", "trajectories"]
