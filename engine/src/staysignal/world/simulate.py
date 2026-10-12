"""Monthly simulation of Larkspur Systems from the migration baseline (SPEC 6.2, 6.3).

Calendar-month steps: at the start of each month every active employee's cause-specific hazards are computed from the
true state (with the latent propensity, team and organization shocks per calendar quarter, contagion and drift), one
outcome is drawn per person, and the month's scheduled events are applied: reorganizations, promotion and merit
cycles, transfers, exits with manager succession, fixed-term contract ends and exactly `hires_per_month` hires.

Every true change is written as a bitemporal HRIS record (effective date plus `recorded_at`) carrying the assignment
snapshot after the change. Planted data problems are added afterwards by `defects.py`; this module is the truth.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from staysignal.clock import add_months, batch_time, days_in_month, months_between, quarter_of
from staysignal.prng import SplitMix64, stream
from staysignal.world import hazards
from staysignal.world.spec import IC_LEVELS, JOB_FAMILIES, LEVELS, M_LEVELS, Profile, level_band

DRIFT_START = date(2025, 10, 1)

BASE_MID_USD = {
    "IC1": 75_000,
    "IC2": 92_000,
    "IC3": 115_000,
    "IC4": 140_000,
    "IC5": 170_000,
    "IC6": 205_000,
    "M1": 165_000,
    "M2": 195_000,
    "M3": 235_000,
    "M4": 290_000,
}
FAMILY_PAY = {
    "SWE": 1.10,
    "INF": 1.10,
    "DAT": 1.10,
    "SEC": 1.12,
    "PM": 1.08,
    "DES": 0.98,
    "AE": 0.95,
    "SDR": 0.72,
    "SE": 1.05,
    "CSM": 0.85,
    "TS": 0.75,
    "MKT": 0.92,
    "FIN": 0.95,
    "PPL": 0.88,
    "LGL": 1.15,
    "ITS": 0.82,
    "OPS": 0.85,
}
BASELINE_IC_WEIGHTS = [("IC1", 10), ("IC2", 22), ("IC3", 28), ("IC4", 22), ("IC5", 12), ("IC6", 6)]
HIRE_IC_WEIGHTS = [("IC1", 25), ("IC2", 30), ("IC3", 25), ("IC4", 12), ("IC5", 6), ("IC6", 2)]


@dataclass
class Team:
    id: str
    name: str
    group: str
    org: str
    location: str
    families: tuple[tuple[str, int], ...]
    manager: str | None
    valid_from: date
    valid_to: date | None = None
    reorg_dates: list[date] = field(default_factory=list)
    vol_exits: list[date] = field(default_factory=list)


@dataclass
class Person:
    num: int
    en: str
    latent: float
    birth: date
    active: bool
    spell_start: date
    family: str
    level: str
    team: str
    manager: str | None
    location: str
    emp_type: str
    pay: int  # annual base, integer cents, local currency
    role_start: date
    level_since: date
    last_promo: date | None = None
    first_promo: date | None = None
    ft_end: date | None = None
    ft_extended: bool = False
    mgr_history: list[tuple[date, str | None]] = field(default_factory=list)
    spells: list[tuple[date, date | None, str | None, str | None]] = field(
        default_factory=list
    )  # start, end, cause, reason
    legacy_hire: date | None = None
    legacy_first_promo: date | None = None
    legacy_last_promo: date | None = None
    pending_exit: tuple[date, str, str] | None = None  # end_date, cause, reason

    def job_code(self) -> str:
        return f"{self.family}-{self.level}"


@dataclass
class Requisition:
    id: str
    team: str
    family: str
    level: str
    req_type: str  # backfill | growth
    opened: date
    status: str = "open"  # open | filled | cancelled
    closed: date | None = None
    hire_en: str | None = None


@dataclass
class Record:
    record_id: str
    employee_number: str
    record_type: str
    effective_date: date
    recorded_at: datetime
    job_code: str
    level: str
    team_id: str
    manager_employee_number: str | None
    location_code: str
    employment_type: str
    contract_end_date: date | None = None
    termination_reason_code: str | None = None
    corrects_record_id: str | None = None
    source_batch_id: str = ""
    legacy_hire_date: date | None = None
    legacy_first_promotion_date: date | None = None
    legacy_last_promotion_date: date | None = None
    true: bool = True  # false for planted erroneous records (never part of the truth)


@dataclass
class World:
    profile: Profile
    teams: dict[str, Team]
    people: dict[str, Person]
    records: list[Record]
    org_events: list[dict]
    team_rows: list[dict]  # org_teams SCD2 rows
    payroll: list[dict]
    reqs: list[Requisition]
    offers: list[dict]
    outcomes: list[dict]
    monthly: list[dict]
    counts: dict[str, int]
    shocks: dict[str, dict[str, float]]

    @property
    def end(self) -> date:
        return add_months(self.profile.start, self.profile.months)


def band_mid_cents(family: str, level: str, location_factor: float) -> int:
    mid = BASE_MID_USD[level] * FAMILY_PAY[family] * location_factor
    return int(round(mid / 100.0)) * 100 * 100


class Simulator:
    def __init__(self, profile: Profile) -> None:
        self.p = profile
        self.knobs = hazards.WorldKnobs(profile.interaction, profile.promo_effect, profile.drift, profile.contagion)
        self.loc = {loc.code: loc for loc in profile.locations}
        self.teams: dict[str, Team] = {}
        self.people: dict[str, Person] = {}
        self.records: list[Record] = []
        self.org_events: list[dict] = []
        self.reqs: list[Requisition] = []
        self.offers: list[dict] = []
        self.payroll: list[dict] = []
        self.outcomes: list[dict] = []
        self.monthly: list[dict] = []
        self.team_seq = 0
        self.person_seq = 0
        self.record_seq = 0
        self.req_seq = 0
        self.offer_seq = 0
        self.event_seq = 0
        self.headcount_snap: dict[int, dict[str, int]] = {}
        self.org_snap: dict[int, dict[str, int]] = {}
        self.org_vol_exits: dict[str, list[date]] = defaultdict(list)
        self.shocks: dict[str, dict[str, float]] = {"org": {}, "team": {}}
        self.ft_hires = 0
        self.new_hires = 0
        self.counts: dict[str, int] = defaultdict(int)
        self.team_rows: list[dict] = []
        self.month_hc: dict[str, int] = {}
        self.cycle_rates: dict[str, float] = {}
        s = profile.seed
        self.r_org = stream(s, "org")
        self.r_people = stream(s, "people")
        self.r_latent = stream(s, "latent")
        self.r_hazard = stream(s, "hazards")
        self.r_days = stream(s, "days")
        self.r_lags = stream(s, "lags")
        self.r_promo = stream(s, "promotions")
        self.r_transfer = stream(s, "transfers")
        self.r_hire = stream(s, "hires")
        self.r_pay = stream(s, "pay")
        self.r_ft = stream(s, "fixed_term")
        self.r_succ = stream(s, "succession")
        self.r_reqs = stream(s, "requisitions")

    # ---------- ids and records ----------
    def new_team_id(self) -> str:
        self.team_seq += 1
        return f"T{self.team_seq:03d}"

    def new_en(self) -> str:
        self.person_seq += 1
        return f"E{self.person_seq:06d}"

    def band_mid(self, family: str, level: str, location: str) -> int:
        return band_mid_cents(family, level, self.loc[location].pay_factor)

    def lag_days(self) -> int:
        return self.r_lags.weighted([(0, 30), (1, 40), (2, 20), (3, 10)])

    def emit(self, person: Person, record_type: str, effective: date, lag: int | None = None, **extra) -> Record:
        self.record_seq += 1
        lag = self.lag_days() if lag is None else lag
        rec = Record(
            record_id=f"H{self.record_seq:08d}",
            employee_number=person.en,
            record_type=record_type,
            effective_date=effective,
            recorded_at=batch_time(effective + timedelta(days=lag)),
            job_code=person.job_code(),
            level=person.level,
            team_id=person.team,
            manager_employee_number=person.manager,
            location_code=person.location,
            employment_type=person.emp_type,
            contract_end_date=person.ft_end if person.emp_type == "fixed_term" else None,
            **extra,
        )
        self.records.append(rec)
        self.counts[f"record:{record_type}"] += 1
        return rec

    def org_event(self, kind: str, team_id: str, effective: date) -> None:
        self.event_seq += 1
        self.org_events.append(
            {
                "event_id": f"OE{self.event_seq:04d}",
                "effective_date": effective,
                "recorded_at": batch_time(effective - timedelta(days=14)),
                "kind": kind,
                "team_id": team_id,
            }
        )
        self.teams[team_id].reorg_dates.append(effective)

    # ---------- organization and baseline ----------
    def build_org(self) -> None:
        p = self.p
        lo, hi = p.team_size_range
        team_sizes: dict[str, int] = {}
        for org in p.orgs:
            n_teams = sum(g.teams for g in org.groups)
            sizes = self._partition(org.headcount, n_teams, lo, hi)
            i = 0
            for g in org.groups:
                for k in range(g.teams):
                    stem = g.stems[k % len(g.stems)]
                    uses = sum(1 for j in range(g.teams) if g.stems[j % len(g.stems)] == stem)
                    name = stem if uses == 1 else f"{stem} {k // len(g.stems) + 1}"
                    tid = self.new_team_id()
                    self.teams[tid] = Team(tid, name, g.name, org.name, "RAL", g.families, None, p.start)
                    team_sizes[tid] = sizes[i]
                    i += 1
        self._assign_locations(team_sizes)
        self.team_sizes = team_sizes

    def _partition(self, total: int, n: int, lo: int, hi: int) -> list[int]:
        """n sizes in [lo, hi] summing to total, with some teams under 10 when lo allows it."""
        if not (n * lo <= total <= n * hi):
            raise ValueError(f"cannot split {total} into {n} teams of {lo}..{hi}")
        sizes = [lo] * n
        rest = total - n * lo
        while rest > 0:
            i = self.r_org.below(n)
            if sizes[i] < hi:
                step = min(rest, 1 + self.r_org.below(3), hi - sizes[i])
                sizes[i] += step
                rest -= step
        return sizes

    def _assign_locations(self, sizes: dict[str, int]) -> None:
        """Each team gets a primary location; per-person locations hit the exact baseline totals by location."""
        weights = [(loc.code, loc.baseline) for loc in self.p.locations]
        for tid in sorted(self.teams):
            self.teams[tid].location = self.r_org.weighted(weights)
        self.person_locations: dict[str, list[str]] = {}
        remaining = {loc.code: loc.baseline for loc in self.p.locations}
        # first pass: members at the team's primary location while slots remain
        pending: list[tuple[str, int]] = []
        for tid in sorted(self.teams):
            want = sizes[tid]
            primary = self.teams[tid].location
            take = min(want, remaining[primary])
            remaining[primary] -= take
            self.person_locations[tid] = [primary] * take
            if want > take:
                pending.append((tid, want - take))
        pool = [code for code, n in sorted(remaining.items()) for _ in range(n)]
        self.r_org.shuffle(pool)
        for tid, k in pending:
            self.person_locations[tid] += [pool.pop() for _ in range(k)]
        assert not pool

    def draw_level(self, weights: list[tuple[str, int]]) -> str:
        return self.r_people.weighted(weights)

    def draw_family(self, team: Team, rng: SplitMix64) -> str:
        return rng.weighted(list(team.families))

    def draw_compa(self, rng: SplitMix64) -> float:
        while True:
            x = rng.normal(0.98, 0.09)
            if 0.75 <= x <= 1.30:
                return x

    def build_baseline(self) -> None:
        p = self.p
        start = p.start
        tids = sorted(self.teams)
        # fixed-term baseline: exact count, an Engineering share by the knob
        slots: list[tuple[str, int]] = [(tid, k) for tid in tids for k in range(1, self.team_sizes[tid])]
        eng_slots = [s for s in slots if self.teams[s[0]].org == "Engineering"]
        other_slots = [s for s in slots if self.teams[s[0]].org != "Engineering"]
        n_eng_ft = min(len(eng_slots), int(round(p.baseline_fixed_term * p.engineering_fixed_term_share)))
        ft_slots = set(self.r_ft.sample(eng_slots, n_eng_ft)) | set(
            self.r_ft.sample(other_slots, p.baseline_fixed_term - n_eng_ft)
        )
        for tid in tids:
            team = self.teams[tid]
            members: list[Person] = []
            for k in range(self.team_sizes[tid]):
                en = self.new_en()
                tenure_m = min(240.0, -math.log(1.0 - self.r_people.uniform()) * 42.0)
                age = 22.0 + 42.0 * (self.r_people.uniform() ** 1.4)
                age = max(age, 21.0 + tenure_m / 12.0 + 0.5)
                birth = start - timedelta(days=int(age * 365.25))
                spell_start = start - timedelta(days=int(tenure_m * 30.4375))
                family = self.draw_family(team, self.r_people)
                level = "M1" if k == 0 else self.draw_level(BASELINE_IC_WEIGHTS)
                if k == 0:
                    level = self.r_people.weighted([("M1", 70), ("M2", 20), ("M3", 10)])
                fixed = (tid, k) in ft_slots and k != 0
                has_promo = LEVELS.index(level) >= 1 and tenure_m >= 9 and self.r_people.uniform() < 0.85
                last_promo = first_promo = None
                if has_promo:
                    back = 1 + self.r_people.below(int(min(tenure_m - 3, 36)))
                    last_promo = start - timedelta(days=int(back * 30.4375))
                    span = max(1, int((last_promo - spell_start).days / 30.4375) - 3)
                    first_promo = (
                        spell_start + timedelta(days=int((3 + self.r_people.below(span + 1)) * 30.4375))
                        if span > 3
                        else last_promo
                    )
                    if first_promo > last_promo:
                        first_promo = last_promo
                location = self.person_locations[tid][k]
                pay = int(round(self.draw_compa(self.r_pay) * self.band_mid(family, level, location)))
                role_start = last_promo or spell_start
                person = Person(
                    num=int(en[1:]),
                    en=en,
                    latent=self.r_latent.normal(0.0, p.latent_sd) if p.latent_sd > 0 else 0.0,
                    birth=birth,
                    active=True,
                    spell_start=spell_start,
                    family=family,
                    level=level,
                    team=tid,
                    manager=None,
                    location=location,
                    emp_type="fixed_term" if fixed else "regular",
                    pay=pay,
                    role_start=role_start,
                    level_since=role_start,
                    last_promo=last_promo,
                    first_promo=first_promo,
                    legacy_hire=spell_start,
                    legacy_first_promo=first_promo,
                    legacy_last_promo=last_promo,
                )
                if fixed:
                    person.spell_start = start - timedelta(days=int(min(tenure_m, 12.0) * 30.4375))
                    person.legacy_hire = person.spell_start
                    person.last_promo = person.first_promo = person.legacy_first_promo = person.legacy_last_promo = None
                    person.role_start = person.level_since = person.spell_start
                    person.ft_end = start + timedelta(days=int((3 + self.r_ft.below(19)) * 30.4375))
                    if LEVELS.index(person.level) > 3:
                        person.level = "IC3"
                        person.pay = int(
                            round(self.draw_compa(self.r_pay) * self.band_mid(family, person.level, location))
                        )
                person.spells.append((person.spell_start, None, None, None))
                self.people[en] = person
                members.append(person)
            team.manager = members[0].en
        # org heads: the manager of each organization's first team, at M4
        self.org_heads: dict[str, str] = {}
        for org in p.orgs:
            first = min(t for t in tids if self.teams[t].org == org.name)
            head = self.people[self.teams[first].manager or ""]
            head.level = "M4"
            head.pay = int(round(self.draw_compa(self.r_pay) * self.band_mid(head.family, "M4", head.location)))
            self.org_heads[org.name] = head.en
        for en in sorted(self.people):
            person = self.people[en]
            person.manager = self.manager_of(person)
            person.mgr_history.append((p.start, person.manager))
            self.emit(
                person,
                "migration_baseline",
                p.start,
                lag=0,
                legacy_hire_date=person.legacy_hire,
                legacy_first_promotion_date=person.legacy_first_promo,
                legacy_last_promotion_date=person.legacy_last_promo,
            )
        for tid in tids:
            self.team_row_open(tid, p.start)

    def manager_of(self, person: Person) -> str | None:
        team = self.teams[person.team]
        if team.manager and team.manager != person.en:
            return team.manager
        head = self.org_heads.get(team.org)
        return head if head != person.en else None

    # ---------- org_teams SCD2 rows ----------
    def team_row_open(self, tid: str, d: date) -> None:
        t = self.teams[tid]
        self.team_rows.append(
            {"team_id": tid, "team_name": t.name, "group": t.group, "org": t.org, "valid_from": d, "valid_to": None}
        )

    def team_row_close(self, tid: str, d: date) -> None:
        for row in self.team_rows:
            if row["team_id"] == tid and row["valid_to"] is None:
                row["valid_to"] = d
        self.teams[tid].valid_to = d

    # ---------- state helpers ----------
    def active_people(self) -> list[Person]:
        return [self.people[en] for en in sorted(self.people) if self.people[en].active]

    def set_manager(self, person: Person, manager: str | None, d: date, record: bool = True) -> None:
        if person.manager == manager:
            return
        person.manager = manager
        person.mgr_history.append((d, manager))
        if record:
            self.emit(person, "manager_change", d)

    def refresh_team_managers(self, tid: str, d: date) -> None:
        for person in self.active_people():
            if person.team == tid:
                self.set_manager(person, self.manager_of(person), d)

    def mgr_changes_180(self, person: Person, c: date) -> int:
        lo = c - timedelta(days=180)
        hist = person.mgr_history
        n = 0
        for i in range(1, len(hist)):
            d, m = hist[i]
            if lo <= d < c and m != hist[i - 1][1]:
                n += 1
        return n

    def team_rate(self, person: Person, m: int, c: date) -> float:
        team = self.teams[person.team]
        lo = c - timedelta(days=180)
        cnt = sum(1 for d in team.vol_exits if lo <= d < c)
        past = self.headcount_snap.get(max(0, m - 6), {})
        hc = past.get(person.team, self.month_hc.get(person.team, 0))
        org_past = self.org_snap.get(max(0, m - 6), {})
        org_hc = max(1, org_past.get(team.org, 1))
        org_cnt = sum(1 for d in self.org_vol_exits[team.org] if lo <= d < c)
        org_rate = org_cnt / org_hc
        return (cnt + 10.0 * org_rate) / (hc + 10.0)

    def team_headcount(self, tid: str) -> int:
        return sum(1 for p in self.people.values() if p.active and p.team == tid)

    def shock_org(self, q: str) -> float:
        if q not in self.shocks["org"]:
            self.shocks["org"][q] = stream(self.p.seed, f"shock:org:{q}").lognormal_mean_one(self.p.sigma_org)
        return self.shocks["org"][q]

    def shock_team(self, tid: str, q: str) -> float:
        key = f"{tid}:{q}"
        if key not in self.shocks["team"]:
            self.shocks["team"][key] = stream(self.p.seed, f"shock:team:{key}").lognormal_mean_one(self.p.sigma_team)
        return self.shocks["team"][key]

    def hazard_inputs(self, person: Person, m: int, c: date) -> hazards.HazardInputs:
        tenure = months_between(person.spell_start, c)
        since_promo = months_between(person.last_promo or person.spell_start, c)
        first = months_between(person.spell_start, person.first_promo) if person.first_promo else None
        compa = person.pay / self.band_mid(person.family, person.level, person.location)
        reorg = any(c - timedelta(days=90) <= d < c for d in self.teams[person.team].reorg_dates)
        q = quarter_of(c)
        return hazards.HazardInputs(
            tenure_months=tenure,
            level_band=level_band(person.level),
            time_in_role_months=months_between(person.role_start, c),
            months_since_promotion=since_promo,
            first_promotion_months=first,
            manager_changes_180d=self.mgr_changes_180(person, c),
            compa_ratio=compa,
            prior_team_rate=self.team_rate(person, m, c),
            reorg_90d=reorg,
            job_family=person.family,
            fixed_term=person.emp_type == "fixed_term",
            calendar_month=c.month,
            months_since_drift_start=months_between(DRIFT_START, c),
            latent=person.latent,
            log_team_shock=math.log(self.shock_team(person.team, q)),
            log_org_shock=math.log(self.shock_org(q)),
            age_years=(c - person.birth).days / 365.25,
        )

    # ---------- monthly loop ----------
    def run(self) -> World:
        self.build_org()
        self.build_baseline()
        p = self.p
        rehire_months = self._rehire_schedule()
        for m in range(p.months):
            c = add_months(p.start, m)
            nxt = add_months(c, 1)
            self.headcount_snap[m] = defaultdict(int)
            self.org_snap[m] = defaultdict(int)
            for person in self.active_people():
                self.headcount_snap[m][person.team] += 1
                self.org_snap[m][self.teams[person.team].org] += 1
            self.month_hc = dict(self.headcount_snap[m])
            start_active = self.active_people()
            # 1. hazards from the state at the start of the month
            exits: list[tuple[Person, date, str, str]] = []
            for person in start_active:
                x = self.hazard_inputs(person, m, c)
                pv, pi, pr = hazards.cause_probabilities(
                    hazards.eta_voluntary(x, self.knobs), hazards.eta_involuntary(x), hazards.eta_retirement(x)
                )
                u = self.r_hazard.uniform()
                day = 1 + self.r_days.below(days_in_month(c))
                end = c + timedelta(days=day)
                if u < pv:
                    exits.append((person, end, "voluntary", "VOL_RESIGN"))
                elif u < pv + pi:
                    reason = "INVOL_POSITION" if self.r_hazard.uniform() < 0.4 else "INVOL_PERFORMANCE"
                    exits.append((person, end, "involuntary", reason))
                elif u < pv + pi + pr:
                    exits.append((person, end, "retirement", "RETIRE"))
            exiting = {e[0].en for e in exits}
            # fixed-term contract ends in this month
            for person in start_active:
                if person.en in exiting or person.emp_type != "fixed_term" or person.ft_end is None:
                    continue
                if c <= person.ft_end < nxt:
                    self.contract_end(person, exits, exiting)
            # 2. scheduled day-one events
            for r in p.reorgs:
                if c <= r.effective < nxt:
                    self.apply_reorg(r)
            if c in p.promotion_cycles:
                self.promotion_cycle(c, exiting, cycle=True)
            if c in p.merit_cycles:
                self.merit_cycle(c)
            # 3. off-cycle promotions and transfers
            self.promotion_cycle(c, exiting, cycle=False)
            self.transfers(c, exiting)
            # 4. exits, in date order, with manager succession
            for person, end, cause, reason in sorted(exits, key=lambda e: (e[1], e[0].en)):
                self.exit(person, end, cause, reason)
            # 5. hires
            self.hires(c, m, rehire_months.get(m, 0))
            # 6. payroll lines for the month
            self.payroll_month(c, nxt)
            self.monthly.append(
                {"month": c, "headcount_start": len(start_active), "exits": len(exits), "hires": self.p.hires_per_month}
            )
        self.finish_requisitions()
        self.counts_extra = {"cycle_promotion_rates": self.cycle_rates}
        world = World(
            self.p,
            self.teams,
            self.people,
            self.records,
            self.org_events,
            self.team_rows,
            self.payroll,
            self.reqs,
            self.offers,
            self.outcomes,
            self.monthly,
            dict(self.counts),
            self.shocks,
        )
        world.cycle_rates = self.cycle_rates  # type: ignore[attr-defined]
        return world

    def contract_end(self, person: Person, exits: list, exiting: set[str]) -> None:
        end = person.ft_end
        assert end is not None
        u = self.r_ft.uniform()
        convert, extend = (0.30, 0.20) if not person.ft_extended else (0.375, 0.0)
        if u < convert:
            person.emp_type = "regular"
            person.ft_end = None
            self.emit(person, "employment_type_change", end)
            self.counts["ft_converted"] += 1
        elif u < convert + extend:
            person.ft_extended = True
            person.ft_end = end + timedelta(days=int((6 + self.r_ft.below(7)) * 30.4375))
            self.emit(person, "employment_type_change", end)
            self.counts["ft_extended"] += 1
        else:
            exits.append((person, end + timedelta(days=1), "involuntary", "FT_END"))
            exiting.add(person.en)
            self.counts["ft_ended"] += 1

    def promotion_cycle(self, c: date, exiting: set[str], cycle: bool) -> None:
        eligible = promoted = 0
        for person in self.active_people():
            if person.en in exiting or person.emp_type == "fixed_term" and not cycle:
                continue
            months_in_level = months_between(person.level_since, c)
            prob = hazards.promotion_probability(months_in_level, person.level)
            if person.level not in IC_LEVELS and self.teams[person.team].manager != person.en:
                prob *= 0.5  # managers without a team
            if not cycle:
                prob /= 50.0
            elif prob > 0:
                eligible += 1
            if self.r_promo.uniform() < prob:
                promoted += cycle
                eff = c if cycle else c + timedelta(days=self.r_days.below(days_in_month(c)))
                self.promote(person, eff)
                self.counts["promotions_cycle" if cycle else "promotions_offcycle"] += 1
        if cycle:
            self.cycle_rates[c.isoformat()] = round(promoted / max(1, eligible), 4)

    def promote(self, person: Person, eff: date, to_level: str | None = None) -> None:
        if to_level is None:
            idx = LEVELS.index(person.level)
            to_level = LEVELS[idx + 1]
        person.level = to_level
        person.pay = int(round(person.pay * (1.08 + 0.04 * self.r_pay.uniform())))
        person.last_promo = eff
        if person.first_promo is None:
            person.first_promo = eff
        person.level_since = eff
        person.role_start = eff
        self.emit(person, "promotion", eff, lag=self.r_lags.below(8))

    def merit_cycle(self, c: date) -> None:
        for person in self.active_people():
            compa = person.pay / self.band_mid(person.family, person.level, person.location)
            merit = min(0.06, max(0.0, 0.03 + 0.08 * (1.0 - compa) + 0.01 * self.r_pay.normal()))
            person.pay = int(round(person.pay * (1.0 + merit)))
        self.counts["merit_cycles"] += 1

    def transfers(self, c: date, exiting: set[str]) -> None:
        for person in self.active_people():
            if person.en in exiting or self.teams[person.team].manager == person.en:
                continue
            if self.r_transfer.uniform() >= 0.0045:
                continue
            team = self.teams[person.team]
            same_org = self.r_transfer.uniform() < 0.70
            candidates = sorted(
                t.id
                for t in self.teams.values()
                if t.valid_to is None and t.id != team.id and ((t.org == team.org) == same_org)
            )
            if not candidates:
                continue
            dest = self.teams[self.r_transfer.choice(candidates)]
            eff = c + timedelta(days=self.r_days.below(days_in_month(c)))
            job_change = self.r_transfer.uniform() < 0.40
            person.team = dest.id
            if job_change:
                fam = self.draw_family(dest, self.r_transfer)
                if fam != person.family:
                    person.family = fam
                    person.role_start = eff
            new_manager = self.manager_of(person)
            if new_manager != person.manager:
                person.manager = new_manager
                person.mgr_history.append((eff, new_manager))
            self.emit(person, "transfer", eff)
            self.counts["transfers"] += 1

    def exit(self, person: Person, end: date, cause: str, reason: str) -> None:
        team = self.teams[person.team]
        person.active = False
        start, _, _, _ = person.spells[-1]
        person.spells[-1] = (start, end, cause, reason)
        rec = self.emit(person, "termination", end, termination_reason_code=reason)
        rec_id = rec.record_id
        self.outcomes.append(
            {
                "employee_number": person.en,
                "spell_start": start,
                "end_date": end,
                "cause": cause,
                "reason": reason,
                "record_id": rec_id,
                "team_id": person.team,
                "org": team.org,
            }
        )
        self.counts[f"exit:{cause}"] += 1
        if cause == "voluntary":
            team.vol_exits.append(end)
            self.org_vol_exits[team.org].append(end)
        if self.r_reqs.uniform() < 0.70:
            opened = end + timedelta(days=self.r_reqs.below(31))
            self.new_req(
                team.id if team.valid_to is None else self.live_team_in_group(team),
                person.family,
                person.level if person.level in IC_LEVELS else "IC5",
                "backfill",
                opened,
            )
        if team.manager == person.en:
            self.succession(team, end)
        if self.org_heads.get(team.org) == person.en:
            successor = team.manager
            if successor and successor != person.en:
                self.org_heads[team.org] = successor
                succ = self.people[successor]
                if succ.level != "M4":
                    self.promote(succ, end, "M4")
                for other in self.active_people():
                    if self.teams[other.team].org == team.org:
                        self.set_manager(other, self.manager_of(other), end)

    def live_team_in_group(self, team: Team) -> str:
        live = sorted(t.id for t in self.teams.values() if t.valid_to is None and t.org == team.org)
        return live[0]

    def succession(self, team: Team, d: date) -> None:
        members = [p for p in self.active_people() if p.team == team.id]
        internal = self.r_succ.uniform() < 0.60
        successor: Person | None = None
        if internal and members:
            successor = max(members, key=lambda p: (LEVELS.index(p.level) if p.level in IC_LEVELS else -1, -p.num))
        else:
            pool = [
                p
                for p in self.active_people()
                if self.teams[p.team].org == team.org
                and p.team != team.id
                and p.level in ("IC5", "IC6")
                and self.teams[p.team].manager != p.en
            ]
            if pool:
                successor = self.r_succ.choice(pool)
                successor.team = team.id
                self.emit(successor, "transfer", d)
            elif members:
                successor = max(members, key=lambda p: (LEVELS.index(p.level) if p.level in IC_LEVELS else -1, -p.num))
        if successor is None:
            team.manager = None
            return
        team.manager = successor.en
        if successor.level in IC_LEVELS:
            self.promote(successor, d, "M1")
        successor.role_start = d
        self.counts["successions"] += 1
        for member in self.active_people():
            if member.team == team.id:
                self.set_manager(member, self.manager_of(member), d)

    # ---------- reorganizations ----------
    def apply_reorg(self, r) -> None:
        group_teams = sorted(
            t.id for t in self.teams.values() if t.valid_to is None and t.group == r.group and t.org == r.org
        )
        d = r.effective
        if r.kind == "merge" and len(group_teams) >= 2:
            sizes = {tid: self.team_headcount(tid) for tid in group_teams}
            absorbed = min(group_teams, key=lambda t: (sizes[t], t))
            target = min((t for t in group_teams if t != absorbed), key=lambda t: (sizes[t], t))
            old_mgr = self.teams[absorbed].manager
            for person in self.active_people():
                if person.team == absorbed:
                    person.team = target
                    new_manager = self.manager_of(person)
                    if new_manager != person.manager:
                        person.manager = new_manager
                        person.mgr_history.append((d, new_manager))
                    self.emit(person, "team_change", d)
            self.team_row_close(absorbed, d)
            self.org_event("merge", target, d)
            if old_mgr and self.org_heads.get(r.org) == old_mgr:
                self.org_heads[r.org] = self.teams[target].manager or old_mgr
            self.counts["reorg:merge"] += 1
        elif r.kind == "split" and group_teams:
            src = max(group_teams, key=lambda t: (self.team_headcount(t), t))
            members = [p for p in self.active_people() if p.team == src and self.teams[src].manager != p.en]
            moved = members[len(members) // 2 :]
            t0 = self.teams[src]
            nid = self.new_team_id()
            self.teams[nid] = Team(nid, f"{t0.name} B", t0.group, t0.org, t0.location, t0.families, None, d)
            self.team_row_open(nid, d)
            lead = max(moved, key=lambda p: (LEVELS.index(p.level) if p.level in IC_LEVELS else -1, -p.num))
            self.teams[nid].manager = lead.en
            for person in moved:
                person.team = nid
            if lead.level in IC_LEVELS:
                self.promote(lead, d, "M1")
            for person in moved:
                new_manager = self.manager_of(person)
                if new_manager != person.manager:
                    person.manager = new_manager
                    person.mgr_history.append((d, new_manager))
                self.emit(person, "team_change", d)
            self.org_event("split", src, d)
            self.org_event("split", nid, d)
            self.counts["reorg:split"] += 1
        elif r.kind in ("move", "restructure") and group_teams:
            if r.kind == "move":
                movers = [min(group_teams, key=lambda t: (self.team_headcount(t), t))]
            else:
                movers = group_teams[len(group_teams) // 2 :]
            for old in movers:
                t0 = self.teams[old]
                nid = self.new_team_id()
                self.teams[nid] = Team(
                    nid,
                    t0.name,
                    r.target_group or t0.group,
                    t0.org,
                    t0.location,
                    t0.families,
                    t0.manager,
                    d,
                    vol_exits=list(t0.vol_exits),
                )
                self.team_row_close(old, d)
                self.team_row_open(nid, d)
                for person in self.active_people():
                    if person.team == old:
                        person.team = nid
                        self.emit(person, "team_change", d)
                self.org_event(r.kind, nid, d)
            self.counts[f"reorg:{r.kind}"] += 1

    # ---------- hiring ----------
    def new_req(self, team: str, family: str, level: str, req_type: str, opened: date) -> Requisition:
        self.req_seq += 1
        req = Requisition(f"REQ{self.req_seq:05d}", team, family, level, req_type, opened)
        self.reqs.append(req)
        return req

    def _rehire_schedule(self) -> dict[int, int]:
        p = self.p
        months = [m for m in range(p.months) if add_months(p.start, m) >= p.rehire_from]
        out: dict[int, int] = defaultdict(int)
        if not months:
            return out
        for i in range(p.rehires):
            out[months[(i * len(months)) // p.rehires]] += 1
        return out

    def hires(self, c: date, m: int, n_rehires: int) -> None:
        p = self.p
        days = days_in_month(c)
        starts = sorted(c + timedelta(days=self.r_hire.below(days)) for _ in range(p.hires_per_month))
        eligible = sorted(
            (
                r
                for r in self.reqs
                if r.status == "open"
                and r.opened <= starts[0] - timedelta(days=21)
                and self.teams[r.team].valid_to is None
            ),
            key=lambda r: (r.opened, r.id),
        )
        rehire_pool = sorted(
            (
                pp
                for pp in self.people.values()
                if not pp.active
                and pp.spells
                and pp.spells[-1][2] == "voluntary"
                and pp.spells[-1][1] is not None
                and pp.spells[-1][1] <= c - timedelta(days=183)
            ),
            key=lambda pp: pp.num,
        )
        rehire_slots = (
            set(self.r_hire.sample(range(p.hires_per_month), min(n_rehires, p.hires_per_month))) if n_rehires else set()
        )
        live_teams = sorted(t.id for t in self.teams.values() if t.valid_to is None)
        hc: dict[str, int] = defaultdict(int)
        for pp in self.people.values():
            if pp.active:
                hc[pp.team] += 1
        team_weights = [(t, max(1, hc[t])) for t in live_teams]
        assert len(starts) == p.hires_per_month
        for i, start in enumerate(starts):
            if eligible:
                req = eligible.pop(0)
            else:
                tid = self.r_hire.weighted(team_weights)
                fam = self.draw_family(self.teams[tid], self.r_hire)
                req = self.new_req(
                    tid,
                    fam,
                    self.r_hire.weighted(HIRE_IC_WEIGHTS),
                    "growth",
                    start - timedelta(days=30 + self.r_hire.below(61)),
                )
            is_rehire = i in rehire_slots and rehire_pool
            person = self.hire(req, start, rehire_pool.pop(self.r_hire.below(len(rehire_pool))) if is_rehire else None)
            self.fill(req, person, start)

    def hire(self, req: Requisition, start: date, former: Person | None) -> Person:
        team = self.teams[req.team]
        location = (
            team.location
            if self.r_hire.uniform() < 0.85
            else self.r_hire.choice([loc.code for loc in self.p.locations])
        )
        level = req.level
        compa = self.draw_compa(self.r_pay)
        if former is not None:
            person = former
            person.active = True
            person.spell_start = start
            person.family = req.family
            person.level = level
            person.team = team.id
            person.location = location
            person.emp_type = "regular"
            person.ft_end = None
            person.ft_extended = False
            person.last_promo = person.first_promo = None
            person.role_start = person.level_since = start
            person.pay = int(round(compa * self.band_mid(req.family, level, location)))
            person.spells.append((start, None, None, None))
            record_type = "rehire"
            self.counts["rehires"] += 1
        else:
            en = self.new_en()
            age = 22.0 + 30.0 * (self.r_people.uniform() ** 1.6)
            person = Person(
                num=int(en[1:]),
                en=en,
                latent=self.r_latent.normal(0.0, self.p.latent_sd) if self.p.latent_sd > 0 else 0.0,
                birth=start - timedelta(days=int(age * 365.25)),
                active=True,
                spell_start=start,
                family=req.family,
                level=level,
                team=team.id,
                manager=None,
                location=location,
                emp_type="regular",
                pay=int(round(compa * self.band_mid(req.family, level, location))),
                role_start=start,
                level_since=start,
            )
            person.spells.append((start, None, None, None))
            self.people[person.en] = person
            self.new_hires += 1
            want_ft = int(round(self.new_hires * self.p.new_hire_fixed_term_share))
            if self.ft_hires < want_ft:
                in_eng = team.org == "Engineering"
                if in_eng or self.r_ft.uniform() > self.p.engineering_fixed_term_share:
                    person.emp_type = "fixed_term"
                    person.ft_end = start + timedelta(days=int((6 + self.r_ft.below(19)) * 30.4375))
                    if LEVELS.index(person.level) > 3:
                        person.level = "IC3"
                        person.pay = int(round(compa * self.band_mid(req.family, "IC3", location)))
                    self.ft_hires += 1
            record_type = "hire"
            self.counts["new_hires"] += 1
        person.manager = self.manager_of(person)
        person.mgr_history.append((start, person.manager))
        lag = -(3 + self.r_lags.below(18))  # entered before the start date
        self.emit(person, record_type, start, lag=lag)
        return person

    def fill(self, req: Requisition, person: Person, start: date) -> None:
        declined_before = 1 if self.r_reqs.uniform() < 0.11 else 0
        ext = req.opened + timedelta(days=7 + self.r_reqs.below(max(1, (start - req.opened).days - 14)))
        for _ in range(declined_before):
            self.offer_seq += 1
            self.offers.append(
                {
                    "offer_id": f"OF{self.offer_seq:05d}",
                    "requisition_id": req.id,
                    "extended_date": ext - timedelta(days=10),
                    "decision": "declined",
                    "decision_date": ext - timedelta(days=5),
                    "start_date": None,
                }
            )
        self.offer_seq += 1
        self.offers.append(
            {
                "offer_id": f"OF{self.offer_seq:05d}",
                "requisition_id": req.id,
                "extended_date": ext,
                "decision": "accepted",
                "decision_date": ext + timedelta(days=3),
                "start_date": start,
            }
        )
        req.status = "filled"
        req.closed = ext + timedelta(days=3)
        req.hire_en = person.en

    def finish_requisitions(self) -> None:
        """Exact requisition and offer counts for profiles that pin them (SPEC 6.2)."""
        p = self.p
        end = add_months(p.start, p.months)
        if p.exact_requisitions is None:
            return
        filled, cancelled, open_end = p.exact_requisitions
        assert sum(1 for r in self.reqs if r.status == "filled") == filled, "filled requisitions must equal hires"
        unfilled = sorted((r for r in self.reqs if r.status == "open"), key=lambda r: (r.opened, r.id))
        extra = len(unfilled) - open_end
        if extra > cancelled:
            raise ValueError(
                f"{len(unfilled)} unfilled requisitions; cannot keep {open_end} open with {cancelled} cancellations"
            )
        for r in unfilled[: max(0, extra)]:
            r.status = "cancelled"
            r.closed = min(end - timedelta(days=1), r.opened + timedelta(days=45 + self.r_reqs.below(45)))
        if extra < 0:
            for _ in range(-extra):
                live = sorted(t.id for t in self.teams.values() if t.valid_to is None)
                tid = self.r_reqs.choice(live)
                self.new_req(
                    tid,
                    self.draw_family(self.teams[tid], self.r_reqs),
                    self.r_reqs.weighted(HIRE_IC_WEIGHTS),
                    "growth",
                    end - timedelta(days=1 + self.r_reqs.below(25)),
                )
        n_cancel = sum(1 for r in self.reqs if r.status == "cancelled")
        live = sorted(t.id for t in self.teams.values() if t.valid_to is None)
        while n_cancel < cancelled:
            tid = self.r_reqs.choice(live)
            opened = p.start + timedelta(days=self.r_reqs.below((end - p.start).days - 120))
            r = self.new_req(
                tid,
                self.draw_family(self.teams[tid], self.r_reqs),
                self.r_reqs.weighted(HIRE_IC_WEIGHTS),
                "growth",
                opened,
            )
            r.status = "cancelled"
            r.closed = opened + timedelta(days=30 + self.r_reqs.below(60))
            n_cancel += 1
        if p.exact_declined_offers is not None:
            declined = [o for o in self.offers if o["decision"] == "declined"]
            want = p.exact_declined_offers
            while len(declined) > want:
                o = declined.pop()
                self.offers.remove(o)
            candidates = sorted(r.id for r in self.reqs if r.status in ("filled", "open", "cancelled"))
            while len(declined) < want:
                rid = self.r_reqs.choice(candidates)
                req = next(r for r in self.reqs if r.id == rid)
                ext = req.opened + timedelta(days=5 + self.r_reqs.below(20))
                if ext >= end:
                    continue
                self.offer_seq += 1
                o = {
                    "offer_id": f"OF{self.offer_seq:05d}",
                    "requisition_id": rid,
                    "extended_date": ext,
                    "decision": "declined",
                    "decision_date": ext + timedelta(days=4),
                    "start_date": None,
                }
                self.offers.append(o)
                declined.append(o)

    # ---------- payroll ----------
    def payroll_month(self, c: date, nxt: date) -> None:
        """One line per employee active at any point in the pay period (base monthly rate, basis M)."""
        period = f"{c.year:04d}-{c.month:02d}"
        for person in sorted(self.people.values(), key=lambda pp: pp.num):
            spells = person.spells
            if not spells:
                continue
            s, e, _, _ = spells[-1]
            in_period = s < nxt and (e is None or e > c)
            if not in_period and len(spells) > 1:
                s, e, _, _ = spells[-2]
                in_period = s < nxt and (e is None or e > c)
            if not in_period:
                continue
            entity = self.loc[person.location].entity
            self.payroll.append(
                {
                    "entity_code": entity,
                    "employee_number": person.en,
                    "pay_period": period,
                    "monthly_cents": int(round(person.pay / 12)),
                    "annual_cents": person.pay,
                    "currency": self.loc[person.location].currency,
                    "pay_basis_code": "M",
                }
            )


def simulate(profile: Profile) -> World:
    return Simulator(profile).run()


__all__ = ["JOB_FAMILIES", "M_LEVELS", "Record", "World", "simulate", "band_mid_cents"]
