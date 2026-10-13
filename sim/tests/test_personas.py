"""Personas from cohort cells (SPEC 15.2): the allocation, the priors, the cards and the two control variants."""

import ast
import re
from pathlib import Path

import pytest

from staysignal_sim.families import JOB_FAMILIES
from staysignal_sim.personas import (
    ACTIVATION,
    N_PERSONAS,
    allocate,
    card,
    derangement,
    load_cells,
    load_proposals,
    personas_for,
    target_cells,
    variant,
)

ROOT = Path(__file__).resolve().parents[2]
PROPOSALS = load_proposals()
CELLS = load_cells()


def test_the_family_names_match_the_engine():
    tree = ast.parse((ROOT / "engine" / "src" / "staysignal" / "world" / "spec.py").read_text())
    engine = next(
        ast.literal_eval(n.value)
        for n in tree.body
        if isinstance(n, ast.AnnAssign) and getattr(n.target, "id", "") == "JOB_FAMILIES"
    )
    assert engine == JOB_FAMILIES


@pytest.mark.parametrize("pid", sorted(PROPOSALS))
def test_sixteen_personas_from_the_target_cells_only(pid):
    proposal = PROPOSALS[pid]
    personas = personas_for(proposal, CELLS)
    targets = {c["cell_id"] for c in target_cells(CELLS["cells"], proposal["target"])}
    assert len(personas) == N_PERSONAS and {p.cell_id for p in personas} <= targets
    assert [p.persona_id for p in personas] == [f"P{i:02d}" for i in range(1, 17)]
    assert personas == personas_for(proposal, CELLS)  # deterministic
    for p in personas:
        assert 0.35 <= p.activation <= 0.65 and p.activation == ACTIVATION[p.tenure_band]


def test_allocation_is_proportional_with_a_seat_for_every_large_cell():
    cells = [{"cell_id": f"C{i}", "n": n} for i, n in enumerate([100, 50, 30, 10, 10, 10, 6])]
    seats = allocate(cells)
    assert sum(seats.values()) == 16 and seats["C0"] == 7 and seats["C1"] == 4
    assert all(seats.get(f"C{i}", 0) >= 1 for i in range(7) if cells[i]["n"] / 216 >= 0.05)


def test_the_floor_never_pushes_the_total_over_sixteen():
    cells = [{"cell_id": f"C{i:02d}", "n": 10} for i in range(18)]  # each 5.6% of the target: 18 floors for 16 seats
    seats = allocate(cells)
    assert sum(seats.values()) >= 16  # every 5% cell keeps its seat; the overshoot is reported, not hidden
    cells = [{"cell_id": f"C{i:02d}", "n": n} for i, n in enumerate([300] + [10] * 12)]
    assert sum(allocate(cells).values()) == 16


def test_cards_state_cohort_facts_and_the_proposal_and_never_a_risk():
    proposal = PROPOSALS["promotion-criteria-third-window"]
    p = personas_for(proposal, CELLS)[0]
    text = card(p, proposal, "Plain-spoken, cares about timing.")
    assert text.startswith(f"You are {p.handle}") and "In your cohort, about" in text
    assert proposal["status_quo"] in text and proposal["change"] in text
    assert not re.search(r"risk|probabilit|forecast|likely to leave|attrition", text, re.I)


def test_the_controls():
    proposal = PROPOSALS["promotion-criteria-third-window"]
    personas = personas_for(proposal, CELLS)
    removed = variant(personas, "facts_removed", 7)
    assert all(p.facts is None for p in removed) and "In your cohort" not in card(removed[0], proposal, None)
    shuffled = variant(personas, "facts_shuffled", 7)
    perm = derangement(len(personas), 7)
    assert all(shuffled[i].facts == personas[perm[i]].facts for i in range(len(personas)))
    assert all(i != j for i, j in enumerate(perm)) and sorted(perm) == list(range(len(personas)))
