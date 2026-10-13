"""Personas from cohort distributions (SPEC 15.2): templates over the engine's cohort cells, never individuals.

- 16 personas per replicate, allocated to the proposal's target cells in proportion to cell size by largest remainder,
  with at least one for every cell holding 5% or more of the target population.
- Each card states the cell's facts as "In your cohort, ...", the status quo and the proposal; a one-line voice is
  generated once per persona and recorded (it is filled in by the recording client, not here).
- Priors are computed from the cell, never by a model: the activation probability per round by tenure band (0.35 to
  0.65) and an influence weight by level band that orders activation within a round. No predicted risk is ever placed
  in a card.
- Controls for the sanity panel: `facts_removed` (handle, status quo and proposal only) and `facts_shuffled` (the
  cohort facts permuted across the personas' cells by a seeded derangement).
"""

from __future__ import annotations

import json
import random
from dataclasses import asdict, dataclass, replace
from pathlib import Path

import yaml

N_PERSONAS = 16
MIN_SHARE_FOR_ONE = 0.05
LEVEL_DISPLAY = {"early": "IC1-IC2", "mid": "IC3-IC4", "senior": "IC5-IC6", "manager": "M1-M4"}
ACTIVATION = {"<1y": 0.65, "1-3y": 0.55, "3-5y": 0.45, "5y+": 0.35, "other": 0.5}
INFLUENCE = {"early": 1.0, "mid": 2.0, "senior": 3.0, "manager": 4.0}
VARIANTS = ("main", "facts_removed", "facts_shuffled")


@dataclass(frozen=True)
class Persona:
    persona_id: str  # P01 ... P16
    cell_id: str
    handle: str
    job_family: str
    level_band: str
    tenure_band: str
    facts: dict | None  # None in the facts-removed control
    activation: float
    influence: float


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / "lab" / "cohort_cells.json").exists():
            return p
    raise FileNotFoundError("lab/cohort_cells.json")


def load_cells(root: Path | None = None) -> dict:
    return json.loads(((root or repo_root()) / "lab" / "cohort_cells.json").read_text())


def load_proposals(root: Path | None = None) -> dict[str, dict]:
    doc = yaml.safe_load(((root or repo_root()) / "lab" / "proposals.yaml").read_text())
    return {p["id"]: p for p in doc["proposals"]}


def target_cells(cells: list[dict], target: dict) -> list[dict]:
    return [c for c in cells if all(c.get(k) in v for k, v in target.items())]


def allocate(cells: list[dict], n: int = N_PERSONAS) -> dict[str, int]:
    """Largest remainder on n x size share, with at least one seat for every cell holding 5% or more of the target.
    Ties go to the larger cell, then the lower cell ID, so the allocation is stable."""
    total = sum(c["n"] for c in cells)
    if total == 0:
        raise ValueError("no target population")
    quota = {c["cell_id"]: n * c["n"] / total for c in cells}
    floor_ = {c["cell_id"]: 1 if c["n"] / total >= MIN_SHARE_FOR_ONE else 0 for c in cells}
    seats = {k: max(int(q), floor_[k]) for k, q in quota.items()}
    by_remainder = sorted(cells, key=lambda c: (-(quota[c["cell_id"]] % 1), -c["n"], c["cell_id"]))
    i = 0
    while sum(seats.values()) < n:
        seats[by_remainder[i % len(cells)]["cell_id"]] += 1
        i += 1
    for c in reversed(by_remainder):  # the 5% floor can overshoot: take back from the smallest remainders
        if sum(seats.values()) <= n:
            break
        if seats[c["cell_id"]] > floor_[c["cell_id"]]:
            seats[c["cell_id"]] -= 1
    return {k: v for k, v in seats.items() if v}


def family_name(code: str) -> str:
    from staysignal_sim.families import JOB_FAMILIES

    return JOB_FAMILIES.get(code, code)


def personas_for(proposal: dict, cells_doc: dict) -> list[Persona]:
    cells = target_cells(cells_doc["cells"], proposal["target"])
    seats = allocate(cells)
    out: list[Persona] = []
    for c in sorted(cells, key=lambda c: c["cell_id"]):
        for _ in range(seats.get(c["cell_id"], 0)):
            pid = f"P{len(out) + 1:02d}"
            handle = f"{pid} · {family_name(c['job_family'])} · {LEVEL_DISPLAY[c['level_band']]} · {c['tenure_band']}"
            out.append(
                Persona(
                    persona_id=pid,
                    cell_id=c["cell_id"],
                    handle=handle,
                    job_family=c["job_family"],
                    level_band=c["level_band"],
                    tenure_band=c["tenure_band"],
                    facts={**c["facts"], "reorg_90d": c["reorg_90d"]},
                    activation=ACTIVATION[c["tenure_band"]],
                    influence=INFLUENCE[c["level_band"]],
                )
            )
    return out


def derangement(n: int, seed: int) -> list[int]:
    """A seeded permutation with no fixed point (n of at least 2)."""
    rng = random.Random(seed)
    while True:
        p = list(range(n))
        rng.shuffle(p)
        if all(i != j for i, j in enumerate(p)):
            return p


def variant(personas: list[Persona], name: str, seed: int) -> list[Persona]:
    if name == "main":
        return personas
    if name == "facts_removed":
        return [replace(p, facts=None) for p in personas]
    if name == "facts_shuffled":
        perm = derangement(len(personas), seed)
        return [replace(p, facts=personas[perm[i]].facts) for i, p in enumerate(personas)]
    raise ValueError(f"unknown card variant {name}")


def _pct(x: float | None) -> str:
    return "unknown" if x is None else f"about {round(x * 100)}%"


def card(p: Persona, proposal: dict, voice: str | None) -> str:
    lines = [f"You are {p.handle}, a synthetic persona."]
    if p.facts is not None:
        f = p.facts
        lines.append(
            f"In your cohort, {_pct(f['share_below_midpoint'])} are paid below their band midpoint, the median time "
            f"since a last promotion is {f['median_months_since_promotion']} months, and "
            f"{_pct(f['share_manager_change_180d'])} had a manager change in the last 180 days."
        )
        if f.get("reorg_90d"):
            lines.append("Your team was reorganized in the last 90 days.")
    lines.append(f"Today: {proposal['status_quo']}")
    lines.append(f"Proposed: {proposal['change']}")
    if voice:
        lines.append(f"Your voice: {voice}")
    return "\n".join(lines)


def as_dicts(personas: list[Persona]) -> list[dict]:
    return [asdict(p) for p in personas]


__all__ = [
    "ACTIVATION",
    "INFLUENCE",
    "N_PERSONAS",
    "VARIANTS",
    "Persona",
    "allocate",
    "as_dicts",
    "card",
    "derangement",
    "load_cells",
    "load_proposals",
    "personas_for",
    "target_cells",
    "variant",
]
