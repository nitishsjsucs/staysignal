"""16: no lookahead (hypothesis). For random micro-worlds, the feature table at (c, v) is unchanged by adding any record
recorded after v, or any non-correcting record effective after the cutoff. Two cases are excluded by definition, not
by convenience: a correction or rescission known at v legitimately rewrites the past it refers to, and a termination
effective on the cutoff itself ends the spell at c (the first day not employed), so that person is not employed at
c. Runs on the reference; test_pit_sql.py ties pit.sql to the reference."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from hypothesis import given, settings
from hypothesis import strategies as st

from staysignal.features.reference import Vintage, features_at
from tests.features.micro import build

C = date(2026, 1, 1)
V = datetime(2026, 1, 1, 6, tzinfo=UTC)
LEVELS = ["IC1", "IC2", "IC3", "IC4", "IC5"]
TYPES = ["promotion", "transfer", "manager_change", "team_change", "termination"]


@st.composite
def worlds(draw):
    records = []
    n_people = draw(st.integers(1, 4))
    rid = 0
    for p in range(n_people):
        en = f"E{p + 1:06d}"
        start = date(2024, 1, 1) + timedelta(days=draw(st.integers(0, 600)))
        rid += 1
        level = draw(st.sampled_from(LEVELS))
        records.append(
            {
                "record_id": f"H{rid:08d}",
                "employee_number": en,
                "record_type": "hire",
                "effective_date": start.isoformat(),
                "level": level,
            }
        )
        for _ in range(draw(st.integers(0, 3))):
            rid += 1
            kind = draw(st.sampled_from(TYPES))
            eff = start + timedelta(days=draw(st.integers(1, 650)))
            rec = {
                "record_id": f"H{rid:08d}",
                "employee_number": en,
                "record_type": kind,
                "effective_date": eff.isoformat(),
                "level": draw(st.sampled_from(LEVELS)),
                "team_id": draw(st.sampled_from(["T001", "T002"])),
                "manager": draw(st.sampled_from(["E000900", "E000901"])),
                "recorded_at": (
                    datetime(eff.year, eff.month, eff.day, 6, tzinfo=UTC) + timedelta(days=draw(st.integers(0, 40)))
                ).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
            if kind == "termination":
                rec["reason"] = draw(st.sampled_from(["VOL_RESIGN", "INVOL_POSITION", "RETIRE"]))
            records.append(rec)
    extra_kind = draw(st.sampled_from(["late", "future"]))
    rid += 1
    extra = {
        "record_id": f"H{rid:08d}",
        "employee_number": draw(st.sampled_from([f"E{p + 1:06d}" for p in range(n_people)] + ["E000777"])),
        "record_type": draw(st.sampled_from(TYPES + ["hire"])),
        "level": draw(st.sampled_from(LEVELS)),
        "team_id": draw(st.sampled_from(["T001", "T002"])),
        "manager": draw(st.sampled_from(["E000900", "E000902"])),
        "reason": "VOL_RESIGN",
    }
    if extra_kind == "late":  # any effective date, recorded after the vintage
        eff = date(2024, 6, 1) + timedelta(days=draw(st.integers(0, 700)))
        extra["recorded_at"] = (V + timedelta(days=draw(st.integers(1, 60)))).strftime("%Y-%m-%dT%H:%M:%SZ")
    else:  # effective after the cutoff, recorded before the vintage
        eff = C + timedelta(days=draw(st.integers(1, 120)))
        extra["recorded_at"] = (V - timedelta(days=draw(st.integers(1, 30)))).strftime("%Y-%m-%dT%H:%M:%SZ")
    extra["effective_date"] = eff.isoformat()
    teams = [{"team_id": "T001"}, {"team_id": "T002"}]
    return {"teams": teams, "records": records}, extra


@settings(max_examples=150, deadline=None)
@given(worlds())
def test_no_lookahead_property(case):
    spec, extra = case
    before = features_at(Vintage(build(spec), V), C)
    after = features_at(Vintage(build({**spec, "records": [*spec["records"], extra]}), V), C)
    assert before == after
