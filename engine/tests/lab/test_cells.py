"""The Scenario Lab's cohort cells (SPEC 15.2, ADR 0008): every cell holds at least 10 people, the cells and the
withheld count account for the whole population, and nothing individual or model-derived is exported."""

import json
from dataclasses import replace
from datetime import date

from staysignal.clock import as_cutoff_datetime
from staysignal.features.reference import Vintage, features_at
from staysignal.ingest.landing import load_world_sources
from staysignal.lab.cells import MIN_CELL, OTHER, build_cells, export
from staysignal.world.spec import TENURE_BANDS

CUTOFF = date(2026, 9, 1)


def rows_of(small):
    return features_at(Vintage(load_world_sources(small), as_cutoff_datetime(CUTOFF)), CUTOFF)


def test_every_cell_has_at_least_ten_people_and_the_counts_add_up(small):
    rows = rows_of(small)
    cells, withheld = build_cells(rows)
    assert cells and all(c["n"] >= MIN_CELL for c in cells)
    assert sum(c["n"] for c in cells) + withheld == len(rows)


def test_only_cohort_facts_leave_the_module(small):
    doc = export(rows_of(small), "R-x", CUTOFF)
    text = json.dumps(doc)
    assert "employee_number" not in text and not any(r.employee_number in text for r in rows_of(small)[:50])
    for c in doc["cells"]:
        assert set(c) == {
            "cell_id",
            "job_family",
            "level_band",
            "tenure_band",
            "promotion_band",
            "reorg_90d",
            "n",
            "facts",
        }
        assert set(c["facts"]) == {"share_below_midpoint", "median_months_since_promotion", "share_manager_change_180d"}
        share = c["facts"]["share_manager_change_180d"]
        assert abs(share * 20 - round(share * 20)) < 1e-9  # rounded to 0.05
    assert doc["label"].startswith("Hypothesis generation with synthetic personas")


def test_small_cells_are_coarsened_tenure_first_then_promotion(small):
    rows = rows_of(small)
    other_bands = [b for b in TENURE_BANDS if b != rows[0].tenure_band]

    def people(prefix: str, n: int, tenure: str):
        return [replace(rows[0], employee_number=f"{prefix}{i}", tenure_band=tenure) for i in range(n)]

    a = people("A", 10, rows[0].tenure_band)  # a full cell keeps its own tenure band
    b = people("B", 3, other_bands[0])  # two small siblings that differ only by tenure
    c = people("C", 7, other_bands[1])
    cells, withheld = build_cells(a + b)
    assert [c["n"] for c in cells] == [10] and withheld == 3  # 3 left over: withheld, never shown
    cells, withheld = build_cells(a + b + c)
    assert withheld == 0
    assert sorted((x["tenure_band"] == OTHER, x["n"]) for x in cells) == [(False, 10), (True, 10)]


def test_the_export_is_deterministic(small):
    rows = rows_of(small)
    assert export(rows, "R-x", CUTOFF) == export(list(reversed(rows)), "R-x", CUTOFF)
