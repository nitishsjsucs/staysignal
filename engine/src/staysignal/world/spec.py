"""World specification: organizations, groups, job families, locations and profile knobs (SPEC 6.2, 6.7).

Names are generic and fictional. The canonical profile reproduces the exact structural counts of SPEC 6.2; the small
profile is a scaled copy for tests and CI.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date

# Job families: code, name. Exactly 17 (SPEC 6.2).
JOB_FAMILIES: dict[str, str] = {
    "SWE": "Software Engineering",
    "INF": "Infrastructure Engineering",
    "DAT": "Data Engineering",
    "SEC": "Security Engineering",
    "PM": "Product Management",
    "DES": "Design",
    "AE": "Account Executive",
    "SDR": "Sales Development",
    "SE": "Solutions Engineering",
    "CSM": "Customer Success",
    "TS": "Technical Support",
    "MKT": "Marketing",
    "FIN": "Finance",
    "PPL": "People",
    "LGL": "Legal",
    "ITS": "IT Services",
    "OPS": "Business Operations",
}

IC_LEVELS = ["IC1", "IC2", "IC3", "IC4", "IC5", "IC6"]
M_LEVELS = ["M1", "M2", "M3", "M4"]
LEVELS = IC_LEVELS + M_LEVELS


def level_band(level: str) -> str:
    if level in ("IC1", "IC2"):
        return "early"
    if level in ("IC3", "IC4"):
        return "mid"
    if level in ("IC5", "IC6"):
        return "senior"
    return "manager"


LEVEL_BANDS = ["early", "mid", "senior", "manager"]
TENURE_BANDS = ["<1y", "1-3y", "3-5y", "5y+"]


def tenure_band(months: float) -> str:
    if months < 12:
        return "<1y"
    if months < 36:
        return "1-3y"
    if months < 60:
        return "3-5y"
    return "5y+"


@dataclass(frozen=True)
class Location:
    code: str
    name: str
    entity: str
    currency: str
    baseline: int
    pay_factor: float  # band midpoint factor in local currency, relative to Raleigh USD


@dataclass(frozen=True)
class GroupSpec:
    name: str
    teams: int
    families: tuple[tuple[str, int], ...]  # (family code, weight)
    stems: tuple[str, ...]  # team name stems


@dataclass(frozen=True)
class OrgSpec:
    name: str
    code: str
    headcount: int
    groups: tuple[GroupSpec, ...]


@dataclass(frozen=True)
class Reorg:
    effective: date
    kind: str  # merge | split | move | restructure
    org: str
    group: str
    target_group: str | None = None  # move: destination group; restructure: the new group name


@dataclass(frozen=True)
class PlantedCounts:
    value_corrections: int
    manager_reverts: int
    manager_changes_to_other: int
    duplicates: int
    late_terminations: int
    reclassified_reasons: int
    rescinded_terminations: int
    audit_batch_terminations: int
    audit_batch_terminations_voluntary: int
    audit_batch_manager_corrections: int


@dataclass(frozen=True)
class Profile:
    name: str
    seed: int
    start: date
    months: int
    orgs: tuple[OrgSpec, ...]
    locations: tuple[Location, ...]
    hires_per_month: int
    rehires: int
    rehire_from: date
    baseline_fixed_term: int
    engineering_fixed_term_share: float  # knob for SPEC 6.5 (share of fixed-term hires placed in Engineering)
    new_hire_fixed_term_share: float
    team_size_range: tuple[int, int]
    reorgs: tuple[Reorg, ...]
    promotion_cycles: tuple[date, ...]
    merit_cycles: tuple[date, ...]
    latent_sd: float = 0.7
    interaction: bool = True
    promo_effect: str = "smooth"  # smooth | step
    drift: bool = True
    sigma_team: float = 0.45
    sigma_org: float = 0.20
    contagion: bool = True
    planted: PlantedCounts | None = None
    exact_requisitions: tuple[int, int, int] | None = None  # filled, cancelled, open at the end (canonical only)
    exact_declined_offers: int | None = None
    min_engineering_fixed_term_at_end: int = 0
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def baseline_headcount(self) -> int:
        return sum(o.headcount for o in self.orgs)


LOCATIONS_CANONICAL = (
    Location("RAL", "Raleigh", "US-ENT", "USD", 990, 1.00),
    Location("PIT", "Pittsburgh", "US-ENT", "USD", 280, 0.95),
    Location("VAN", "Vancouver", "CA-ENT", "CAD", 330, 1.18),
    Location("MAN", "Manchester", "UK-ENT", "GBP", 220, 0.62),
)

ENTITIES = {"US-ENT": "USD", "CA-ENT": "CAD", "UK-ENT": "GBP"}

CANONICAL_ORGS = (
    OrgSpec(
        "Engineering",
        "ENG",
        590,
        (
            GroupSpec(
                "Platform Engineering",
                9,
                (("SWE", 8), ("INF", 2)),
                ("Platform Reliability", "Developer Platform", "Compute Platform", "Service Mesh", "Build Systems"),
            ),
            GroupSpec(
                "Infrastructure",
                7,
                (("INF", 8), ("SWE", 2)),
                ("Network Infrastructure", "Storage Systems", "Edge Operations", "Capacity Planning"),
            ),
            GroupSpec(
                "Data",
                7,
                (("DAT", 8), ("SWE", 2)),
                ("Data Ingestion", "Data Warehouse", "Analytics Platform", "Data Quality"),
            ),
            GroupSpec(
                "Product Engineering",
                8,
                (("SWE", 10),),
                ("Web Experience", "Billing Systems", "Account Services", "Integrations", "Mobile Apps"),
            ),
            GroupSpec(
                "Security Engineering",
                5,
                (("SEC", 9), ("SWE", 1)),
                ("Application Security", "Detection Engineering", "Identity Platform"),
            ),
        ),
    ),
    OrgSpec(
        "Product & Design",
        "PDS",
        135,
        (
            GroupSpec("Product Management", 5, (("PM", 10),), ("Core Product", "Growth Product", "Platform Product")),
            GroupSpec("Design", 4, (("DES", 10),), ("Product Design", "Design Systems", "User Research")),
        ),
    ),
    OrgSpec(
        "Sales",
        "SAL",
        390,
        (
            GroupSpec(
                "Enterprise Sales",
                6,
                (("AE", 9), ("SE", 1)),
                ("Enterprise East", "Enterprise West", "Strategic Accounts"),
            ),
            GroupSpec(
                "Commercial Sales", 7, (("AE", 10),), ("Commercial East", "Commercial West", "Commercial Central")
            ),
            GroupSpec("Sales Development", 5, (("SDR", 10),), ("Inbound Development", "Outbound Development")),
            GroupSpec(
                "Solutions Engineering", 4, (("SE", 10),), ("Solutions Engineering East", "Solutions Engineering West")
            ),
        ),
    ),
    OrgSpec(
        "Customer Success & Support",
        "CSS",
        285,
        (
            GroupSpec(
                "Customer Success",
                7,
                (("CSM", 10),),
                ("Customer Success Enterprise", "Customer Success Commercial", "Onboarding"),
            ),
            GroupSpec(
                "Technical Support",
                9,
                (("TS", 10),),
                ("Support Tier 1", "Support Tier 2", "Support Escalations", "Support Operations"),
            ),
        ),
    ),
    OrgSpec(
        "Marketing",
        "MKT",
        105,
        (
            GroupSpec("Product Marketing", 3, (("MKT", 10),), ("Product Marketing",)),
            GroupSpec("Demand Generation", 2, (("MKT", 10),), ("Demand Generation",)),
            GroupSpec("Brand", 2, (("MKT", 10),), ("Brand and Content",)),
        ),
    ),
    OrgSpec(
        "Finance",
        "FIN",
        90,
        (
            GroupSpec("Planning & Analysis", 3, (("FIN", 10),), ("Financial Planning",)),
            GroupSpec("Accounting", 3, (("FIN", 10),), ("Accounting Operations",)),
        ),
    ),
    OrgSpec(
        "People",
        "PPL",
        70,
        (
            GroupSpec("People Partners", 2, (("PPL", 10),), ("People Partners",)),
            GroupSpec("Talent Acquisition", 2, (("PPL", 10),), ("Talent Acquisition",)),
            GroupSpec("People Analytics & Operations", 1, (("PPL", 10),), ("People Analytics and Operations",)),
        ),
    ),
    OrgSpec(
        "Legal",
        "LGL",
        40,
        (GroupSpec("Legal", 3, (("LGL", 10),), ("Commercial Legal", "Corporate Legal", "Privacy and Compliance")),),
    ),
    OrgSpec(
        "IT & Operations",
        "ITO",
        115,
        (
            GroupSpec("IT Services", 3, (("ITS", 10),), ("IT Support", "Workplace Technology")),
            GroupSpec("Business Operations", 3, (("OPS", 10),), ("Business Operations",)),
        ),
    ),
)

CANONICAL_REORGS = (
    Reorg(date(2023, 11, 1), "merge", "Customer Success & Support", "Customer Success"),
    Reorg(date(2024, 2, 1), "move", "Engineering", "Infrastructure", target_group="Platform Engineering"),
    Reorg(date(2024, 6, 1), "split", "Engineering", "Data"),
    Reorg(date(2024, 10, 1), "merge", "Sales", "Commercial Sales"),
    Reorg(date(2025, 1, 1), "move", "Engineering", "Product Engineering", target_group="Platform Engineering"),
    Reorg(
        date(2025, 4, 1),
        "restructure",
        "Customer Success & Support",
        "Technical Support",
        target_group="Support Engineering",
    ),
    Reorg(date(2025, 9, 1), "split", "Sales", "Sales Development"),
    Reorg(date(2026, 3, 1), "merge", "Engineering", "Platform Engineering"),
    Reorg(date(2026, 7, 1), "move", "Marketing", "Brand", target_group="Demand Generation"),
)

CYCLES = tuple(date(y, m, 1) for y, m in [(2023, 9), (2024, 3), (2024, 9), (2025, 3), (2025, 9), (2026, 3), (2026, 9)])
MERITS = tuple(date(y, 9, 1) for y in (2023, 2024, 2025, 2026))

CANONICAL = Profile(
    name="canonical",
    seed=20261011,
    start=date(2023, 4, 1),
    months=42,
    orgs=CANONICAL_ORGS,
    locations=LOCATIONS_CANONICAL,
    hires_per_month=32,
    rehires=48,
    rehire_from=date(2024, 6, 1),
    baseline_fixed_term=90,
    engineering_fixed_term_share=0.80,
    new_hire_fixed_term_share=0.05,
    team_size_range=(6, 28),
    reorgs=CANONICAL_REORGS,
    promotion_cycles=CYCLES,
    merit_cycles=MERITS,
    planted=PlantedCounts(
        value_corrections=140,
        manager_reverts=20,
        manager_changes_to_other=20,
        duplicates=60,
        late_terminations=75,
        reclassified_reasons=25,
        rescinded_terminations=12,
        audit_batch_terminations=12,
        audit_batch_terminations_voluntary=9,
        audit_batch_manager_corrections=9,
    ),
    exact_requisitions=(1344, 46, 34),
    exact_declined_offers=170,
    min_engineering_fixed_term_at_end=15,
)

SMALL_ORGS = (
    OrgSpec(
        "Engineering",
        "ENG",
        110,
        (
            GroupSpec(
                "Platform Engineering", 3, (("SWE", 8), ("INF", 2)), ("Platform Reliability", "Developer Platform")
            ),
            GroupSpec("Data", 2, (("DAT", 8), ("SWE", 2)), ("Data Ingestion", "Data Warehouse")),
        ),
    ),
    OrgSpec("Product & Design", "PDS", 15, (GroupSpec("Design", 1, (("DES", 10),), ("Product Design",)),)),
    OrgSpec(
        "Sales",
        "SAL",
        60,
        (
            GroupSpec("Commercial Sales", 2, (("AE", 10),), ("Commercial East", "Commercial West")),
            GroupSpec("Sales Development", 1, (("SDR", 10),), ("Inbound Development",)),
        ),
    ),
    OrgSpec(
        "Customer Success & Support",
        "CSS",
        40,
        (GroupSpec("Technical Support", 2, (("TS", 10),), ("Support Tier 1", "Support Tier 2")),),
    ),
    OrgSpec("People", "PPL", 15, (GroupSpec("People Partners", 1, (("PPL", 10),), ("People Partners",)),)),
)

SMALL = Profile(
    name="small",
    seed=7,
    start=date(2025, 4, 1),
    months=18,
    orgs=SMALL_ORGS,
    locations=(
        Location("RAL", "Raleigh", "US-ENT", "USD", 140, 1.00),
        Location("PIT", "Pittsburgh", "US-ENT", "USD", 30, 0.95),
        Location("VAN", "Vancouver", "CA-ENT", "CAD", 45, 1.18),
        Location("MAN", "Manchester", "UK-ENT", "GBP", 25, 0.62),
    ),
    hires_per_month=4,
    rehires=3,
    rehire_from=date(2025, 10, 1),
    baseline_fixed_term=12,
    engineering_fixed_term_share=0.40,
    new_hire_fixed_term_share=0.05,
    team_size_range=(10, 28),
    reorgs=(
        Reorg(date(2025, 9, 1), "move", "Engineering", "Data", target_group="Platform Engineering"),
        Reorg(date(2026, 3, 1), "merge", "Sales", "Commercial Sales"),
    ),
    promotion_cycles=tuple(c for c in CYCLES if c >= date(2025, 4, 1)),
    merit_cycles=tuple(c for c in MERITS if c >= date(2025, 4, 1)),
    planted=PlantedCounts(
        value_corrections=14,
        manager_reverts=3,
        manager_changes_to_other=3,
        duplicates=8,
        late_terminations=8,
        reclassified_reasons=3,
        rescinded_terminations=2,
        audit_batch_terminations=3,
        audit_batch_terminations_voluntary=2,
        audit_batch_manager_corrections=2,
    ),
)

RECOVERY_FACTOR = 22  # 1,820 x 22 = 40,040 employees at the start, about 40,000 at a time (SPEC 6.7)


def scaled(profile: Profile, factor: int) -> Profile:
    """The same company `factor` times larger: every organization, group (by team count), location, hiring and
    fixed-term count multiplied; team sizes, cycles and reorganizations unchanged."""
    orgs = tuple(
        OrgSpec(
            o.name,
            o.code,
            o.headcount * factor,
            tuple(GroupSpec(g.name, g.teams * factor, g.families, g.stems) for g in o.groups),
        )
        for o in profile.orgs
    )
    return replace(
        profile,
        orgs=orgs,
        locations=tuple(replace(loc, baseline=loc.baseline * factor) for loc in profile.locations),
        hires_per_month=profile.hires_per_month * factor,
        rehires=profile.rehires * factor,
        baseline_fixed_term=profile.baseline_fixed_term * factor,
    )


def recovery_profile(factor: int = RECOVERY_FACTOR) -> Profile:
    """Ground-truth recovery (SPEC 6.7, 9.1, C6): a correctly specified world. No latent propensity, no interaction,
    the promotion effect as an exact step at 24 months, no drift, no shocks, contagion on, no planted problems."""
    return replace(
        scaled(CANONICAL, factor),
        name="recovery",
        seed=1011,
        latent_sd=0.0,
        interaction=False,
        promo_effect="step",
        drift=False,
        sigma_team=0.0,
        sigma_org=0.0,
        contagion=True,
        planted=None,
        exact_requisitions=None,
        exact_declined_offers=None,
        min_engineering_fixed_term_at_end=0,
        notes=("ground-truth recovery profile: the model is correctly specified on this world",),
    )


RECOVERY = recovery_profile()

# The shock-world variant of C6 (SPEC 9.1): the same truth with team shocks per quarter. The marginal targets come from
# one 200,200-person world (seed 1012), the tested world is a separate 40,040-person world (seed 1013).
SHOCK_SIGMA_TEAM = 0.45
TARGETS_FACTOR = 110  # 1,820 x 110 = 200,200


def recovery_shock_profile(factor: int = RECOVERY_FACTOR, seed: int = 1013) -> Profile:
    """The recovery world with mean-one lognormal team shocks (sigma 0.45): the model omits the shocks, so its slopes
    estimate marginal effects, which C6's shock-world variant compares with simulated targets, not with the truth."""
    return replace(
        recovery_profile(factor),
        name="recovery-shock",
        seed=seed,
        sigma_team=SHOCK_SIGMA_TEAM,
        notes=("recovery profile with team shocks: the slopes are marginal, compared with simulated targets",),
    )


PROFILES: dict[str, Profile] = {"canonical": CANONICAL, "small": SMALL, "recovery": RECOVERY}
