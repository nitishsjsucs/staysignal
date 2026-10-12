"""Point-in-time features, the pure-Python reference implementation (SPEC 8).

At cutoff `c` and vintage `v`, only records with `recorded_at <= v` are visible; exact duplicates are dropped;
corrections and rescissions visible at `v` are applied; features use records with effective dates before `c`.
`features/pit.sql` implements the same definitions in SQL over the dbt intermediates (M2) and a test compares them.

Nothing here leaves the engine: rows are individual and exist only in memory for training and scoring (ADR 0014).
"""

from __future__ import annotations

import bisect
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta

from staysignal.ingest.landing import HrisRecord, Sources
from staysignal.world.spec import LEVELS, level_band, tenure_band

DAYS_PER_MONTH = 30.4375
CAUSE_OF_REASON = {
    "VOL_RESIGN": "voluntary",
    "INVOL_PERFORMANCE": "involuntary",
    "INVOL_POSITION": "involuntary",
    "FT_END": "involuntary",
    "RETIRE": "retirement",
}
START_TYPES = ("migration_baseline", "hire", "rehire")


def months(a: date, b: date) -> float:
    return (b - a).days / DAYS_PER_MONTH


@dataclass(frozen=True)
class Spell:
    employee_number: str
    start: date
    end: date | None
    cause: str | None
    end_team: str | None
    records: tuple[HrisRecord, ...]  # effective records in the spell, sorted


@dataclass(frozen=True)
class FeatureRow:
    employee_number: str
    org: str
    group: str
    team: str
    job_family: str
    level: str
    level_band: str
    tenure_band: str
    location: str
    employment_type: str
    tenure_days: int
    time_in_role_days: int
    days_since_last_promotion: int
    never_promoted_in_spell: bool
    first_promotion_status: str  # none_yet | le18 | 18to36 | gt36
    manager_changes_180d: int
    compa_ratio: float | None
    prior_team_rate: float
    prior_team_departures_180d: int
    reorg_exposure_90d: bool
    fixed_term_days_remaining: int | None


@dataclass(frozen=True)
class Mapping:
    """A payroll pay-basis mapping version (sources/mappings/payroll.v*.yaml)."""

    version: str
    multipliers: dict[str, int]
    unknown: str  # "monthly" (payroll@1 defaults unknown codes to monthly) or "reject" (payroll@2)

    def annualize(self, amount: float, code: str) -> float | None:
        if code in self.multipliers:
            return amount * self.multipliers[code]
        return amount * 12 if self.unknown == "monthly" else None


PAYROLL_V1 = Mapping("payroll@1", {"M": 12}, "monthly")
PAYROLL_V2 = Mapping("payroll@2", {"M": 12, "ANN": 1}, "reject")
MAPPINGS = {"payroll@1": PAYROLL_V1, "payroll@2": PAYROLL_V2}


class Vintage:
    """Everything known at vintage `v`: records with duplicates dropped and corrections applied, spells, payroll."""

    def __init__(self, src: Sources, v: datetime) -> None:
        self.src = src
        self.v = v
        visible = [r for r in src.hris if r.recorded_at <= v]
        visible.sort(key=lambda r: (r.recorded_at, r.record_id))
        seen: set[tuple] = set()
        base: list[HrisRecord] = []
        corrections: dict[str, HrisRecord] = {}
        rescinded: set[str] = set()
        self.duplicates_dropped = 0
        for r in visible:
            key = r.content_key()
            if key in seen:
                self.duplicates_dropped += 1
                continue
            seen.add(key)
            if r.record_type == "correction" and r.corrects:
                corrections[r.corrects] = r  # the latest visible correction wins (sorted by recorded_at)
            elif r.record_type == "rescission" and r.corrects:
                rescinded.add(r.corrects)
            else:
                base.append(r)
        effective: list[HrisRecord] = []
        for r in base:
            if r.record_id in rescinded:
                continue
            c = corrections.get(r.record_id)
            if c is not None:
                r = replace(
                    r,
                    effective_date=c.effective_date,
                    job_code=c.job_code,
                    level=c.level,
                    team_id=c.team_id,
                    manager=c.manager,
                    location=c.location,
                    employment_type=c.employment_type,
                    contract_end=c.contract_end,
                    reason=c.reason if r.record_type == "termination" else r.reason,
                )
            effective.append(r)
        self.corrections_applied = len(corrections)
        self.rescissions_applied = len(rescinded)
        by_en: dict[str, list[HrisRecord]] = defaultdict(list)
        for r in effective:
            by_en[r.employee_number].append(r)
        self.spells: dict[str, list[Spell]] = {}
        for en, recs in by_en.items():
            recs.sort(key=lambda r: (r.effective_date, r.recorded_at, r.record_id))
            self.spells[en] = self._spells(en, recs)
        self.payroll: dict[str, list] = defaultdict(list)
        for line in src.payroll:
            if line.recorded_at <= v:
                self.payroll[line.employee_number].append(line)
        for lines in self.payroll.values():
            lines.sort(key=lambda x: (x.period, x.recorded_at, x.vendor_file_id))
        self.teams = [t for t in src.teams if t.recorded_at <= v]
        self.org_events = [e for e in src.org_events if e.recorded_at <= v]
        self.terminations: list[tuple[str, date, str, str | None]] = []
        for en, spells in self.spells.items():
            for sp in spells:
                if sp.end is not None and sp.cause is not None:
                    self.terminations.append((en, sp.end, sp.cause, sp.end_team))
        self._assign_cache: dict[date, dict[str, HrisRecord]] = {}

    @staticmethod
    def _spells(en: str, recs: list[HrisRecord]) -> list[Spell]:
        out: list[Spell] = []
        cur: list[HrisRecord] = []
        start: date | None = None
        for r in recs:
            if r.record_type in START_TYPES and start is None:
                start = r.legacy_hire if (r.record_type == "migration_baseline" and r.legacy_hire) else r.effective_date
                cur = [r]
            elif r.record_type in ("hire", "rehire") and start is not None:
                # a new start while a spell is open: close the open spell without a known end (data issue)
                out.append(Spell(en, start, None, None, None, tuple(cur)))
                start, cur = r.effective_date, [r]
            elif start is None:
                continue  # records before any start are orphans (caught by checks)
            elif r.record_type == "termination":
                cur.append(r)
                out.append(
                    Spell(
                        en,
                        start,
                        r.effective_date,
                        CAUSE_OF_REASON.get(r.reason or "", "involuntary"),
                        r.team_id,
                        tuple(cur),
                    )
                )
                start, cur = None, []
            else:
                cur.append(r)
        if start is not None:
            out.append(Spell(en, start, None, None, None, tuple(cur)))
        return out

    def spell_at(self, en: str, c: date) -> Spell | None:
        for sp in self.spells.get(en, []):
            if sp.start < c and (sp.end is None or sp.end > c):
                return sp
        return None

    def assignment(self, sp: Spell, c: date) -> HrisRecord | None:
        recs = [r for r in sp.records if r.effective_date < c and r.record_type != "termination"]
        return recs[-1] if recs else None

    def assignments_at(self, d: date) -> dict[str, HrisRecord]:
        """Every person employed at the start of day `d` (spell start < d < end or open), with the assignment."""
        if d not in self._assign_cache:
            out: dict[str, HrisRecord] = {}
            for en in self.spells:
                sp = self.spell_at(en, d)
                if sp is not None:
                    a = self.assignment(sp, d)
                    if a is not None:
                        out[en] = a
            self._assign_cache[d] = out
        return self._assign_cache[d]

    def team_info(self, team_id: str, d: date) -> tuple[str, str]:
        """(group name, org name) of a team on day d - 1, as known at the vintage."""
        day = d - timedelta(days=1)
        best = None
        for t in self.teams:
            if t.team_id == team_id and t.valid_from <= day and (t.valid_to is None or t.valid_to > day):
                best = t
        if best is None:
            for t in self.teams:
                if t.team_id == team_id:
                    best = t
        return (best.group_name, best.org_name) if best else ("Unknown", "Unknown")


def _first_promotion_status(spell_start: date, first: date | None) -> str:
    if first is None:
        return "none_yet"
    m = months(spell_start, first)
    if m <= 18:
        return "le18"
    if m <= 36:
        return "18to36"
    return "gt36"


def features_at(
    vin: Vintage,
    c: date,
    mapping: Mapping = PAYROLL_V1,
    metric_def: str = "voluntary_departures@1",
    clock: date | None = None,
) -> list[FeatureRow]:
    """Feature rows for the population at (c, v) under a metric definition, sorted by employee number.

    `clock` (default c) is the date that clocks and look-back windows are measured from; population, assignment and
    pay are taken at c. The two differ only inside the change decomposition (SPEC 12), where Composition moves the
    population to the later cutoff while Calendar keeps the clocks and windows at the earlier one."""
    k = clock or c
    lo180 = k - timedelta(days=180)
    lo90 = k - timedelta(days=90)
    past = vin.assignments_at(lo180)
    team_hc_past: dict[str, int] = defaultdict(int)
    org_hc_past: dict[str, int] = defaultdict(int)
    for a in past.values():
        team_hc_past[a.team_id] += 1
        org_hc_past[vin.team_info(a.team_id, lo180)[1]] += 1
    vol_by_team: dict[str, list[tuple[str, date]]] = defaultdict(list)
    vol_by_org: dict[str, int] = defaultdict(int)
    for en, end, cause, team in vin.terminations:
        if cause == "voluntary" and team is not None and lo180 <= end < k:
            vol_by_team[team].append((en, end))
            vol_by_org[vin.team_info(team, end)[1]] += 1
    reorg_teams = {e.team_id for e in vin.org_events if lo90 <= e.effective_date < k}
    rows: list[FeatureRow] = []
    for en in sorted(vin.spells):
        sp = vin.spell_at(en, c)
        if sp is None:
            continue
        a = vin.assignment(sp, c)
        if a is None:
            continue
        if metric_def.endswith("@2") and a.employment_type == "fixed_term":
            continue
        recs = [r for r in sp.records if r.effective_date < c and r.record_type != "termination"]
        role_start = sp.start
        last_promo: date | None = None
        first_promo: date | None = None
        prev = None
        managers: list[tuple[date, str | None]] = []
        for r in recs:
            key = (r.job_code, r.level)
            if r.record_type == "migration_baseline":
                role_start = r.legacy_last_promo or r.legacy_hire or r.effective_date
                last_promo, first_promo = r.legacy_last_promo, r.legacy_first_promo
            elif prev is not None:
                if key != prev[0]:
                    role_start = r.effective_date
                if LEVELS.index(r.level) > LEVELS.index(prev[1]):
                    last_promo = r.effective_date
                    if first_promo is None:
                        first_promo = r.effective_date
            prev = (key, r.level)
            if not managers or managers[-1][1] != r.manager:
                managers.append((r.effective_date, r.manager))
        changes = sum(1 for i in range(1, len(managers)) if lo180 <= managers[i][0] < k)
        compa = _compa(vin, en, c, a, mapping)
        group, org = vin.team_info(a.team_id, c)
        others = [x for x in vol_by_team.get(a.team_id, []) if x[0] != en]
        org_rate = vol_by_org.get(org, 0) / max(1, org_hc_past.get(org, 0))
        shrunk = (len(others) + 10.0 * org_rate) / (team_hc_past.get(a.team_id, 0) + 10.0)
        ft_rem = (a.contract_end - k).days if (a.employment_type == "fixed_term" and a.contract_end) else None
        tenure_days = max(0, (k - sp.start).days)
        rows.append(
            FeatureRow(
                employee_number=en,
                org=org,
                group=group,
                team=a.team_id,
                job_family=a.family,
                level=a.level,
                level_band=level_band(a.level),
                tenure_band=tenure_band(tenure_days / DAYS_PER_MONTH),
                location=a.location,
                employment_type=a.employment_type,
                tenure_days=tenure_days,
                time_in_role_days=max(0, (k - role_start).days),
                days_since_last_promotion=max(0, (k - (last_promo or sp.start)).days),
                never_promoted_in_spell=last_promo is None,
                first_promotion_status=_first_promotion_status(sp.start, first_promo),
                manager_changes_180d=changes,
                compa_ratio=compa,
                prior_team_rate=round(shrunk, 6),
                prior_team_departures_180d=len(others),
                reorg_exposure_90d=a.team_id in reorg_teams,
                fixed_term_days_remaining=ft_rem,
            )
        )
    return rows


def _compa(vin: Vintage, en: str, c: date, a: HrisRecord, mapping: Mapping) -> float | None:
    lines = vin.payroll.get(en, [])
    cutoff_period = f"{c.year:04d}-{c.month:02d}"
    i = bisect.bisect_left([x.period for x in lines], cutoff_period)
    if i == 0:
        return None
    line = lines[i - 1]
    annual = mapping.annualize(line.base_amount_cents / 100.0, line.pay_basis_code)
    band = vin.src.bands.get((a.family, a.level, a.location))
    if annual is None or band is None or band.band_mid <= 0:
        return None
    return round(annual / band.band_mid, 6)


@dataclass(frozen=True)
class Outcome:
    end: date | None
    cause: str | None


def outcomes_at(vin_outcome: Vintage, c: date, people: list[str]) -> dict[str, Outcome]:
    """Departure date and cause of each person's spell covering c, as known at the outcome vintage."""
    out: dict[str, Outcome] = {}
    for en in people:
        sp = vin_outcome.spell_at(en, c)
        if sp is None:
            out[en] = Outcome(None, "not_employed")  # a late record shows the person had left before c
        else:
            out[en] = Outcome(sp.end, sp.cause)
    return out
