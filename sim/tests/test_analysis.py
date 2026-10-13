"""Analysis of a recorded session (SPEC 15.6) on a stub session: the shapes the Lab page reads, PageRank and the
seeded layout, the pilot items' quotes and labels, and the wording linter."""

import asyncio
import json

import pytest

from staysignal_sim.analysis import layout, pagerank
from staysignal_sim.cli import record
from staysignal_sim.report import DRAFT_LABEL, SCALE, lint


@pytest.fixture(scope="module")
def session(tmp_path_factory):
    out = tmp_path_factory.mktemp("session") / "s"
    doc = asyncio.run(record("promotion-criteria-third-window", "stub", out))
    return out, doc


def test_the_analysis_is_labeled_and_marks_a_placeholder(session):
    _, doc = session
    assert doc["label"].startswith("Hypothesis generation with synthetic personas") and doc["placeholder"] is True
    assert doc["replicates"] == {"main": [1, 2, 3], "facts_removed": [1], "facts_shuffled": [1]}
    assert set(doc["controls"]) == {"facts_removed", "facts_shuffled"}


def test_themes_are_ranked_with_replicate_ranges(session):
    _, doc = session
    shares = doc["themes"]["shares"]
    assert [s["mean"] for s in shares] == sorted((s["mean"] for s in shares), reverse=True)
    assert all(s["min"] <= s["mean"] <= s["max"] for s in shares)
    assert len(doc["themes"]["top_by_round"]) <= 4


def test_trajectories_pool_three_tenure_bands_over_eight_rounds(session):
    _, doc = session
    traj = doc["trajectories"]["stance_by_round"]
    assert list(traj) == ["under 1 year", "1 to 3 years", "3 years or more"]
    assert all(len(v) == 8 for v in traj.values())


def test_the_network_is_anonymous_with_pagerank_and_positions(session):
    _, doc = session
    net = doc["network"]
    assert net["label"] == "Simulated, not organizational network analysis"
    assert all(n["id"].startswith("N") or n["id"] == "PO" for n in net["nodes"])
    assert abs(sum(n["pagerank"] for n in net["nodes"]) - 1) < 1e-4
    assert "P01" not in json.dumps(net)


def test_pilot_items_are_drafts_with_quotes_and_lint(session):
    _, doc = session
    items = doc["pilot_items"]
    assert 5 <= len(items) <= 8
    for it in items:
        assert it["label"] == DRAFT_LABEL and it["scale"] == SCALE and it["source"] == "template"
        assert isinstance(it["lint"], list)
    quoted = [it for it in items if it["quotes"]]
    assert quoted and all(it["quotes_span_cohorts"] for it in quoted if len(it["quotes"]) >= 2)
    fair = next(it for it in items if it["construct"] == "process_fairness")
    assert "Colquitt 2001" in fair["recommendation"]


def test_pagerank_and_layout():
    nodes = ["a", "b", "c"]
    edges = [("a", "b", 1.0), ("c", "b", 1.0)]
    pr = pagerank(nodes, edges)
    assert pr["b"] > pr["a"] == pr["c"] and abs(sum(pr.values()) - 1) < 1e-6
    assert layout(nodes, edges, seed=4) == layout(nodes, edges, seed=4)


def test_the_linter():
    assert lint("I understand what is required to be promoted.", SCALE) == []
    assert "possibly double-barreled: joins two statements" in lint("Pay and promotion are fair.", SCALE)
    assert "leading wording" in lint("Obviously the criteria are unclear.", SCALE)
    assert "scale is not five labeled points" in lint("I feel part of my team.", ["Yes", "No"])
    assert "scale is not balanced around a labeled midpoint" in lint(
        "I feel part of my team.", ["Never", "Rarely", "Sometimes", "Often", "Always"]
    )
