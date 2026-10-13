"""Landing and typed source records (SPEC 6.4, 7.1).

`land` copies an arrived extract into immutable, content-addressed storage (`var/landing/<source>/<period>/
<sha256>.csv`) after validating it against its schema; landing the same bytes again is a no-op. A `Sources` object
holds every landed record with its knowledge time (`recorded_at`). Nothing here filters by vintage; the point-in-time
layer does that. Files are read in sorted order so loading is deterministic.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path

from staysignal.clock import parse_ts
from staysignal.ingest.schemas import FileKind, kind_of, validate_rows


def _d(s: str) -> date | None:
    return date.fromisoformat(s) if s else None


def _s(s: str) -> str | None:
    return s if s else None


@dataclass(frozen=True)
class HrisRecord:
    record_id: str
    employee_number: str
    record_type: str
    effective_date: date
    recorded_at: datetime
    job_code: str
    level: str
    team_id: str
    manager: str | None
    location: str
    employment_type: str
    contract_end: date | None
    reason: str | None
    corrects: str | None
    batch: str
    legacy_hire: date | None
    legacy_first_promo: date | None
    legacy_last_promo: date | None

    @property
    def family(self) -> str:
        return self.job_code.rsplit("-", 1)[0]

    def content_key(self) -> tuple:
        """Identity of the content a duplicate re-sends (everything but record_id, batch and recorded_at)."""
        return (
            self.employee_number,
            self.record_type,
            self.effective_date,
            self.job_code,
            self.level,
            self.team_id,
            self.manager,
            self.location,
            self.employment_type,
            self.contract_end,
            self.reason,
            self.corrects,
            self.legacy_hire,
            self.legacy_first_promo,
            self.legacy_last_promo,
        )


@dataclass(frozen=True)
class PayLine:
    entity: str
    employee_number: str
    period: str  # YYYY-MM
    base_amount_cents: int
    currency: str
    pay_basis_code: str
    vendor_file_id: str
    recorded_at: datetime

    @property
    def period_start(self) -> date:
        y, m = self.period.split("-")
        return date(int(y), int(m), 1)


@dataclass(frozen=True)
class TeamRow:
    team_id: str
    team_name: str
    group_id: str
    group_name: str
    org_id: str
    org_name: str
    valid_from: date
    valid_to: date | None
    recorded_at: datetime


@dataclass(frozen=True)
class OrgEvent:
    event_id: str
    effective_date: date
    kind: str
    team_id: str
    recorded_at: datetime


@dataclass(frozen=True)
class Band:
    job_family: str
    level: str
    location: str
    currency: str
    band_min: float
    band_mid: float
    band_max: float


@dataclass(frozen=True)
class ReqEvent:
    requisition_id: str
    team_id: str
    job_code: str
    req_type: str
    status: str
    event_date: date
    recorded_at: datetime


@dataclass(frozen=True)
class Offer:
    offer_id: str
    requisition_id: str
    extended_date: date
    decision: str
    decision_date: date
    start_date: date | None
    recorded_at: datetime


@dataclass
class Sources:
    hris: list[HrisRecord] = field(default_factory=list)
    payroll: list[PayLine] = field(default_factory=list)
    teams: list[TeamRow] = field(default_factory=list)
    org_events: list[OrgEvent] = field(default_factory=list)
    bands: dict[tuple[str, str, str], Band] = field(default_factory=dict)
    reqs: list[ReqEvent] = field(default_factory=list)
    offers: list[Offer] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    file_hashes: dict[str, str] = field(default_factory=dict)
    hris_batches: list[datetime] = field(default_factory=list)  # arrival times of HRIS extracts, empty deltas included


def _cents(s: str) -> int:
    whole, _, frac = s.partition(".")
    return int(whole) * 100 + int((frac + "00")[:2])


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def read_csv_text(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text, newline="")))


def parse_hris(row: dict[str, str]) -> HrisRecord:
    return HrisRecord(
        record_id=row["record_id"],
        employee_number=row["employee_number"],
        record_type=row["record_type"],
        effective_date=date.fromisoformat(row["effective_date"]),
        recorded_at=parse_ts(row["recorded_at"]),
        job_code=row["job_code"],
        level=row["level"],
        team_id=row["team_id"],
        manager=_s(row["manager_employee_number"]),
        location=row["location_code"],
        employment_type=row["employment_type"],
        contract_end=_d(row.get("contract_end_date", "")),
        reason=_s(row["termination_reason_code"]),
        corrects=_s(row["corrects_record_id"]),
        batch=row["source_batch_id"],
        legacy_hire=_d(row["legacy_hire_date"]),
        legacy_first_promo=_d(row["legacy_first_promotion_date"]),
        legacy_last_promo=_d(row["legacy_last_promotion_date"]),
    )


def add_file(src: Sources, path: Path, name: str | None = None) -> None:
    """Parses one extract into `src`. `name` is the delivered file name when `path` is a content-addressed copy."""
    add_text(src, name or path.name, path.read_bytes().decode("utf-8"))


def add_text(src: Sources, name: str, text: str) -> None:
    """Parses one extract given as text (the generator's in-memory output, for the research benchmark)."""
    src.file_hashes[name] = hashlib.sha256(text.encode("utf-8")).hexdigest()
    rows = read_csv_text(text)
    if name.startswith("hris_"):
        parsed = [parse_hris(r) for r in rows]
        src.hris.extend(parsed)
        if name.startswith("hris_delta_"):
            day = date.fromisoformat(name[len("hris_delta_") : -len(".csv")])
            src.hris_batches.append(datetime(day.year, day.month, day.day, 6, tzinfo=UTC))
        elif parsed:
            src.hris_batches.append(max(r.recorded_at for r in parsed))
    elif name.startswith("payroll_"):
        src.payroll.extend(
            PayLine(
                r["entity_code"],
                r["employee_number"],
                r["pay_period"],
                _cents(r["base_amount"]),
                r["currency"],
                r["pay_basis_code"],
                r["vendor_file_id"],
                parse_ts(r["recorded_at"]),
            )
            for r in rows
        )
    elif name == "org_teams.csv":
        src.teams.extend(
            TeamRow(
                r["team_id"],
                r["team_name"],
                r["group_id"],
                r["group_name"],
                r["org_id"],
                r["org_name"],
                date.fromisoformat(r["valid_from"]),
                _d(r["valid_to"]),
                parse_ts(r["recorded_at"]),
            )
            for r in rows
        )
    elif name == "org_events.csv":
        src.org_events.extend(
            OrgEvent(
                r["event_id"],
                date.fromisoformat(r["effective_date"]),
                r["kind"],
                r["team_id"],
                parse_ts(r["recorded_at"]),
            )
            for r in rows
        )
    elif name == "ref_bands.csv":
        for r in rows:
            b = Band(
                r["job_family"],
                r["level"],
                r["location_code"],
                r["currency"],
                _cents(r["band_min"]) / 100,
                _cents(r["band_mid"]) / 100,
                _cents(r["band_max"]) / 100,
            )
            src.bands[(b.job_family, b.level, b.location)] = b
    elif name == "ats_requisitions.csv":
        src.reqs.extend(
            ReqEvent(
                r["requisition_id"],
                r["team_id"],
                r["job_code"],
                r["req_type"],
                r["status"],
                date.fromisoformat(r["event_date"]),
                parse_ts(r["recorded_at"]),
            )
            for r in rows
        )
    elif name == "ats_offers.csv":
        src.offers.extend(
            Offer(
                r["offer_id"],
                r["requisition_id"],
                date.fromisoformat(r["extended_date"]),
                r["decision"],
                date.fromisoformat(r["decision_date"]),
                _d(r["start_date"]),
                parse_ts(r["recorded_at"]),
            )
            for r in rows
        )
    else:
        return
    src.files.append(name)


def load_world_sources(world_dir: Path, include_held: bool = False, extra: list[Path] | None = None) -> Sources:
    """Loads every extract under `sources/` (and `held/` when it has landed)."""
    src = Sources()
    paths = sorted((world_dir / "sources").glob("*.csv"))
    if include_held:
        paths += sorted((world_dir / "held").glob("*.csv"))
    for p in paths + list(extra or []):
        add_file(src, p)
    return src


def max_recorded_at(src: Sources) -> datetime:
    return max(r.recorded_at for r in src.hris)


class LandingRejected(ValueError):
    """An extract that does not match its schema; nothing was landed."""

    def __init__(self, name: str, problems: list[str]):
        super().__init__(f"{name}: {len(problems)} problem(s): " + "; ".join(problems[:5]))
        self.name = name
        self.problems = problems


@dataclass(frozen=True)
class Landed:
    kind: FileKind
    period: str
    name: str  # the delivered file name, kept as provenance
    sha256: str
    path: Path  # the content-addressed copy
    rows: int
    arrived_at: datetime | None  # the newest recorded_at in the file (its delivery time on the synthetic clock)
    new: bool  # false when the same bytes had already landed


def land(path: Path, root: Path) -> Landed:
    """Validates an extract and stores it at <root>/<source>/<period>/<sha256>.csv (read-only, written once)."""
    found = kind_of(path.name)
    if found is None:
        raise LandingRejected(path.name, ["unknown extract name"])
    kind, period = found
    data = path.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    reader = csv.DictReader(io.StringIO(data.decode("utf-8")))
    rows = list(reader)
    problems = validate_rows(kind, list(reader.fieldnames or []), rows)
    if problems:
        raise LandingRejected(path.name, problems)
    dest = root / kind.source / period / f"{sha}.csv"
    new = not dest.exists()
    if new:
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.chmod(tmp, 0o444)
        tmp.replace(dest)
    stamps = [r["recorded_at"] for r in rows if r.get("recorded_at")]
    arrived = parse_ts(max(stamps)) if stamps else None
    if arrived is None and len(period) == 10:  # an empty daily delta arrives at its batch time
        day = date.fromisoformat(period)
        arrived = datetime(day.year, day.month, day.day, 6, tzinfo=UTC)
    return Landed(kind, period, path.name, sha, dest, len(rows), arrived, new)


def load_landed_sources(con, until: datetime | None = None) -> Sources:
    """Every delivery recorded in the warehouse (optionally only those delivered by `until`), parsed from its
    content-addressed landed copy under its delivered name: the same `Sources`, and so the same run keys, as loading
    the delivered files themselves. The audit-only attribute never enters a run (ADR 0013)."""
    rows = con.execute(
        "SELECT d.file_name, l.landed_path FROM raw._deliveries AS d JOIN raw._loads AS l USING (file_sha256) "
        "WHERE d.source <> 'audit_attributes' AND (? IS NULL OR d.delivered_at <= ?) ORDER BY d.file_name",
        [until, until],
    ).fetchall()
    src = Sources()
    for file_name, landed_path in rows:
        add_file(src, Path(landed_path), name=file_name)
    return src
