"""The Lab's sanity panel (SPEC 15.7) and its boundary (15.9): rank correlation with ties, the panel's parts on a
recorded session, and no forecast, model, feature or change module importing a Lab module."""

import ast
import json
from pathlib import Path

import numpy as np

from staysignal.lab.sanity import BOOTSTRAP, LIMITS, concern_rows, panel, ranks, spearman

ROOT = Path(__file__).resolve().parents[3]
ENGINE = ROOT / "engine" / "src" / "staysignal"
SESSION = ROOT / "lab" / "recordings" / "promotion-criteria-third-window-openai"


def test_ranks_share_ties_and_spearman_matches_known_values():
    assert list(ranks([10, 20, 20, 30])) == [1, 2.5, 2.5, 4]
    assert spearman([1, 2, 3, 4], [10, 20, 30, 40]) == 1.0
    assert spearman([1, 2, 3, 4], [4, 3, 2, 1]) == -1.0
    assert spearman([1, 2], [1, 2]) is None and spearman([1, 1, 1], [1, 2, 3]) is None


def test_concern_is_the_reverse_scored_career_item_from_the_pre_round():
    rows = concern_rows(SESSION, "main")
    items = [json.loads(x) for x in (SESSION / "main-s1" / "items.jsonl").read_text().splitlines()]
    first = next(i for i in items if i["phase"] == "pre" and i["values"])
    assert (
        next(r for r in rows if r["replicate"] == 1 and r["persona"] == first["persona"])["concern"]
        == 6 - first["values"][4]
    )


def test_the_panel_on_a_recorded_session():
    rows = concern_rows(SESSION, "main")
    cells = sorted({r["cell"] for r in rows})
    rates = {c: 0.01 * (i + 1) for i, c in enumerate(cells)}
    facts = {
        c: {"share_below_midpoint": 0.5, "median_months_since_promotion": i, "share_manager_change_180d": 0.1}
        for i, c in enumerate(cells)
    }
    # the compact session has 8 personas, one per cell, so cells pool by tenure band: give them four bands
    bands = ["<1y", "1-3y", "3-5y", "5y+"]
    doc = panel(SESSION, rates, facts, {c: bands[i % 4] for i, c in enumerate(cells)})
    assert doc["label"] == "A consistency check, not validation" and doc["limits"] == LIMITS
    pa = doc["persona_agreement"]
    assert pa["bootstrap"] == BOOTSTRAP and pa["n_cells"] >= 3
    assert pa["ci95"] is None or pa["ci95"][0] <= pa["ci95"][1]
    assert set(doc["negative_controls"]) == {"facts_removed", "facts_shuffled"}
    # one replicate per control: small cells pool by tenure band instead of vanishing
    assert all(v["n_cells"] >= 1 for v in doc["negative_controls"].values())
    # the facts composite rises with the rate by construction here, so the baseline is perfect
    assert doc["facts_only_baseline"]["spearman"] == 1.0
    assert np.isfinite(pa["spearman"]) if pa["spearman"] is not None else True


def test_no_forecast_model_feature_or_change_module_imports_a_lab_module():
    for pkg in ("forecast", "model", "features", "changes"):
        for f in (ENGINE / pkg).rglob("*.py"):
            for node in ast.walk(ast.parse(f.read_text())):
                if isinstance(node, ast.ImportFrom) and node.module:
                    assert not node.module.startswith("staysignal.lab"), f"{f.relative_to(ROOT)} imports {node.module}"
                if isinstance(node, ast.Import):
                    assert not any(a.name.startswith("staysignal.lab") for a in node.names), f
