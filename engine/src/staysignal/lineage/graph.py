"""The lineage graph and an engine-side root-cause ranking (SPEC 13.2).

The graph is declared in features_lineage.yml until the dbt manifest provides the warehouse part (M2). The ranking
scores each upstream candidate by the share of failing checks it reaches (coverage), its own probe anomaly and whether
it changed, the shape of DataTrust's frozen-weight score; the Worker's RCA port from DataTrust replaces it in M2.
"""

from __future__ import annotations

from collections import defaultdict
from functools import lru_cache
from pathlib import Path

import yaml

W_COV, W_ANOM, W_CHG = 0.5, 0.4, 0.1


@lru_cache(maxsize=1)
def declared() -> dict:
    return yaml.safe_load((Path(__file__).resolve().parent / "features_lineage.yml").read_text(encoding="utf-8"))


def downstream(node: str) -> set[str]:
    g = defaultdict(set)
    for e in declared()["edges"]:
        g[e["from"]].add(e["to"])
    out, stack = set(), [node]
    while stack:
        n = stack.pop()
        for m in g[n]:
            if m not in out:
                out.add(m)
                stack.append(m)
    return out


def upstream(node: str) -> set[str]:
    g = defaultdict(set)
    for e in declared()["edges"]:
        g[e["to"]].add(e["from"])
    out, stack = set(), [node]
    while stack:
        n = stack.pop()
        for m in g[n]:
            if m not in out:
                out.add(m)
                stack.append(m)
    return out


def path_between(a: str, b: str) -> list[str]:
    g = defaultdict(list)
    for e in declared()["edges"]:
        g[e["from"]].append(e["to"])
    prev: dict[str, str] = {}
    queue, seen = [a], {a}
    while queue:
        n = queue.pop(0)
        if n == b:
            break
        for m in sorted(g[n]):
            if m not in seen:
                seen.add(m)
                prev[m] = n
                queue.append(m)
    if b not in seen:
        return []
    out = [b]
    while out[-1] != a:
        out.append(prev[out[-1]])
    return list(reversed(out))


def rank(failing_nodes: list[str], anomalies: dict[str, float], changed: set[str]) -> list[dict]:
    candidates = set()
    for n in failing_nodes:
        candidates |= upstream(n) | {n}
    rows = []
    for c in sorted(candidates):
        reach = {c} | downstream(c)
        cov = sum(1 for n in failing_nodes if n in reach) / max(1, len(failing_nodes))
        anom = anomalies.get(c, 0.0)
        chg = 1.0 if c in changed else 0.0
        rows.append(
            {
                "node": c,
                "score": round(W_COV * cov + W_ANOM * anom + W_CHG * chg, 4),
                "parts": {"coverage": round(cov, 4), "own_anomaly": round(anom, 4), "changed": chg},
            }
        )
    return sorted(rows, key=lambda r: (-r["score"], r["node"]))
