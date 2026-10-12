"""The action audit (SPEC 17.7, ADR 0013, C77): are the reviews StaySignal's users approve landing unevenly on any
group? It screens actions, not the forecast.

Unit: a person and an approved review. Every review is a selection opportunity for everyone employed on its approval
date; a person "received attention" from it when their group on that date is the reviewed cohort. Screens: tenure
band and location, which can proxy for age and national origin (visible to leads and the auditor), and the audit-only
age-40-or-over flag (the auditor only). Attributes are taken on each review's date. Selection rates, impact ratios
against the highest-rate group, the four-fifths rule of thumb and Fisher's exact test come from `adverse_impact`; the
same people recur across reviews, so the tests are approximate and the result is a screen, never a finding.

This module is the only reader of the audit-only attribute (`audit/audit_attributes.csv`); no forecast, model,
feature, semantic or Lab module imports it (`engine/tests/audit/test_audit_boundary.py`). Synthetic company only.
"""

from __future__ import annotations

import csv
import json
from collections import defaultdict
from datetime import UTC, date, datetime
from pathlib import Path

from staysignal.audit.adverse_impact import GroupCount, adverse_impact
from staysignal.audit.proxies import proxy_strength
from staysignal.features.reference import DAYS_PER_MONTH, Vintage
from staysignal.ingest.landing import load_world_sources
from staysignal.world.spec import TENURE_BANDS, tenure_band

SEEDED = Path(__file__).with_name("seeded_reviews.json")
VINTAGE = datetime(2026, 10, 1, 6, tzinfo=UTC)
AUDIT_DATE = date(2026, 10, 1)
LOCATIONS = {"RAL": "Raleigh", "PIT": "Pittsburgh", "VAN": "Vancouver", "MAN": "Manchester"}
TENURE_LABELS = {"<1y": "under 1 year", "1-3y": "1 to 3 years", "3-5y": "3 to 5 years", "5y+": "5 years or more"}
SCREENS = {"tenure_band": "proxy", "location": "proxy", "age40": "audit_only"}


def load_reviews(path: Path = SEEDED) -> list[dict]:
    return json.loads(path.read_text())["reviews"]


def load_age40(world: Path) -> dict[str, date | None]:
    """The audit-only attribute: the first day each person is 40 or over (None when not within the window)."""
    out: dict[str, date | None] = {}
    with open(world / "audit" / "audit_attributes.csv", newline="") as f:
        for row in csv.DictReader(f):
            out[row["employee_number"]] = date.fromisoformat(row["age40_from"]) if row["age40_from"] else None
    return out


def units(vin: Vintage, reviews: list[dict], age40: dict[str, date | None]) -> list[dict]:
    """One row per person employed on a review's date: their attributes then and whether the review reached them."""
    out = []
    for rv in reviews:
        d = date.fromisoformat(rv["approved_on"])
        group = rv["cohort"].split(":", 1)[1]
        for en, a in vin.assignments_at(d).items():
            sp = vin.spell_at(en, d)
            g, _org = vin.team_info(a.team_id, d)
            since = age40.get(en)
            out.append(
                {
                    "person": en,
                    "review": rv["review_id"],
                    "selected": g == group,
                    "tenure_band": TENURE_LABELS[tenure_band(((d - sp.start).days if sp else 0) / DAYS_PER_MONTH)],
                    "location": LOCATIONS.get(a.location, a.location),
                    "age40": "40 or over" if since is not None and since <= d else "under 40",
                }
            )
    return out


def screen(rows: list[dict], attribute: str) -> list[dict]:
    sel: dict[str, int] = defaultdict(int)
    n: dict[str, int] = defaultdict(int)
    people: dict[str, set[str]] = defaultdict(set)
    for r in rows:
        k = r[attribute]
        n[k] += 1
        sel[k] += int(r["selected"])
        people[k].add(r["person"])
    order = {
        "tenure_band": [TENURE_LABELS[b] for b in TENURE_BANDS],
        "location": list(LOCATIONS.values()),
        "age40": ["under 40", "40 or over"],
    }[attribute]
    groups = [g for g in order if g in n] + sorted(g for g in n if g not in order)
    counts = [GroupCount(g, sel[g], n[g], len(people[g])) for g in groups]
    total_n = sum(n.values())
    total_sel = sum(sel.values())
    out = []
    for row in adverse_impact(counts):
        g = row["group"]
        row["population_share"] = n[g] / total_n if total_n else None
        row["attention_share"] = sel[g] / total_sel if total_sel else None
        out.append(row)
    return out


def run(world: Path, results_dir: Path, today: str | None = None) -> tuple[Path, dict]:
    import hashlib

    src = load_world_sources(world)
    vin = Vintage(src, VINTAGE)
    reviews = load_reviews()
    age40 = load_age40(world)
    rows = units(vin, reviews, age40)
    doc = {
        "kind": "action-audit",
        "command": "uv run --project engine staysignal audit actions",
        "date": today or date.today().isoformat(),
        "label": "synthetic",
        "world_sha256": json.loads((world / "manifest.json").read_text())["world_sha256"],
        "reviews_sha256": hashlib.sha256(SEEDED.read_bytes()).hexdigest(),
        "design": (
            "unit: a person employed on an approved review's date; selected when their group then is the reviewed "
            "cohort; attributes on that date; impact ratio against the highest-rate group, four-fifths rule of thumb "
            "(29 CFR 1607.4(D)), Fisher's exact test against everyone else (approximate: people recur across reviews); "
            "groups under 10 people are too small to screen"
        ),
        "reviews": len(reviews),
        "review_window": [min(r["approved_on"] for r in reviews), max(r["approved_on"] for r in reviews)],
        "units": len(rows),
        "selected_units": sum(int(r["selected"]) for r in rows),
        "screens": {name: {"kind": SCREENS[name], "rows": screen(rows, name)} for name in SCREENS},
        "proxy_strength": proxy_strength(vin, AUDIT_DATE, age40),
        "notes": [
            "A screen of actions taken, not of the forecast; a flag is a reason to look, not a finding.",
            "The age-40-or-over flag is an audit-only synthetic attribute; it is visible to the auditor role only.",
            "The twelve reviews are seeded synthetic records (engine/src/staysignal/audit/seeded_reviews.json).",
        ],
    }
    results_dir.mkdir(parents=True, exist_ok=True)
    path = results_dir / f"action-audit-{doc['date']}.json"
    path.write_text(json.dumps(doc, indent=1) + "\n")
    return path, doc


__all__ = ["AUDIT_DATE", "SCREENS", "load_reviews", "run", "screen", "units"]
