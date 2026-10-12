"""Cohort profiles (SPEC 7.3 `sem_cohort_profile`, tool `cohort_profile`): pay position, promotion facts and hiring
coverage per published cohort, computed at the run's cutoff from data known at its vintage. Aggregates only."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime
from statistics import median

from staysignal.features.reference import DAYS_PER_MONTH, FeatureRow, Vintage
from staysignal.forecast.cohorts import cohort_index


def _facts(rows: list[FeatureRow]) -> dict:
    compa = [r.compa_ratio for r in rows if r.compa_ratio is not None]
    since = [r.days_since_last_promotion / DAYS_PER_MONTH for r in rows]
    promoted = [1 for r in rows if not r.never_promoted_in_spell and r.days_since_last_promotion < 365]
    return {
        "share_below_midpoint": round(sum(1 for x in compa if x < 1.0) / max(1, len(compa)), 3),
        "median_months_since_promotion": int(round(median(since))) if since else 0,
        "promotion_rate_12m": round(len(promoted) / max(1, len(rows)), 3),
    }


def open_requisitions(vin: Vintage, c: date, v: datetime) -> tuple[dict[str, dict[str, int]], dict[str, int]]:
    """Open requisitions by team and type at v, and pending accepted backfill offers (start after c) by team."""
    state: dict[str, tuple[str, str, str]] = {}
    for ev in sorted((e for e in vin.src.reqs if e.recorded_at <= v), key=lambda e: (e.recorded_at, e.requisition_id)):
        state[ev.requisition_id] = (ev.status, ev.team_id, ev.req_type)
    by_team: dict[str, dict[str, int]] = defaultdict(lambda: {"backfill": 0, "growth": 0})
    for status, team, kind in state.values():
        if status == "open":
            by_team[team][kind] += 1
    req_meta = {e.requisition_id: (e.team_id, e.req_type) for e in vin.src.reqs}
    pending: dict[str, int] = defaultdict(int)
    for o in vin.src.offers:
        if o.recorded_at <= v and o.decision == "accepted" and o.start_date and o.start_date > c:
            team, kind = req_meta.get(o.requisition_id, ("", ""))
            if kind == "backfill":
                pending[team] += 1
    return by_team, pending


def profiles(vin: Vintage, rows: list[FeatureRow], c: date, v: datetime, run_id: str) -> dict:
    reqs, pending = open_requisitions(vin, c, v)
    team_parent: dict[str, tuple[str, str]] = {}
    for team in set(reqs) | set(pending):
        team_parent[team] = vin.team_info(team, c)
    company = _facts(rows)
    out = []
    for cohort, idx in cohort_index(rows).items():
        members = [rows[i] for i in idx]
        f = _facts(members)

        def in_cohort(team: str, cohort=cohort) -> bool:
            group, org = team_parent.get(team, ("", ""))
            if cohort.kind == "company":
                return True
            if cohort.kind == "organization":
                return org == cohort.name
            if cohort.kind == "group":
                return group == cohort.name
            if cohort.kind == "team":
                return team == cohort.name
            return False

        backfill = (
            sum(v_["backfill"] for t, v_ in reqs.items() if in_cohort(t))
            if cohort.kind in ("company", "organization", "group", "team")
            else 0
        )
        growth = (
            sum(v_["growth"] for t, v_ in reqs.items() if in_cohort(t))
            if cohort.kind in ("company", "organization", "group", "team")
            else 0
        )
        offers = (
            sum(n for t, n in pending.items() if in_cohort(t))
            if cohort.kind in ("company", "organization", "group", "team")
            else 0
        )
        out.append(
            {
                "cohort_id": cohort.id,
                "n": len(members),
                **f,
                "open_backfill_reqs": backfill,
                "open_growth_reqs": growth,
                "pending_backfill_offers": offers,
                "company": company,
            }
        )
    return {"label": "synthetic", "run_id": run_id, "profiles": sorted(out, key=lambda p: p["cohort_id"])}
