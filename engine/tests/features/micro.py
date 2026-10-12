"""Micro-worlds for the named feature tests (SPEC 8.4): small YAML fixtures turned into `Sources`.

A micro-world lists teams, bands, HRIS records (with defaults filled in), payroll lines and org events. Record ids,
batches and timestamps default sensibly so each test states only what it is about."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path

import yaml

from staysignal.ingest.landing import Band, HrisRecord, OrgEvent, PayLine, Sources, TeamRow

MICRO_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "micro"


def ts(s: str | date) -> datetime:
    if isinstance(s, date) and not isinstance(s, datetime):
        return datetime(s.year, s.month, s.day, 6, tzinfo=UTC)
    if isinstance(s, datetime):
        return s if s.tzinfo else s.replace(tzinfo=UTC)
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def d(s) -> date | None:
    if s is None or s == "":
        return None
    return s if isinstance(s, date) else date.fromisoformat(str(s))


def build(spec: dict) -> Sources:
    src = Sources()
    for t in spec.get("teams", [{"team_id": "T001"}]):
        src.teams.append(
            TeamRow(
                t["team_id"],
                t.get("team_name", t["team_id"]),
                t.get("group_id", "G01"),
                t.get("group_name", "Group A"),
                t.get("org_id", "ENG"),
                t.get("org_name", "Engineering"),
                d(t.get("valid_from", "2020-01-01")),
                d(t.get("valid_to")),
                ts(d(t.get("recorded_at", "2020-01-01"))),
            )
        )
    for b in spec.get(
        "bands",
        [
            {"job_family": "SWE", "level": lvl, "location": "RAL", "mid": 100000}
            for lvl in ("IC1", "IC2", "IC3", "IC4", "IC5", "IC6", "M1")
        ],
    ):
        mid = float(b["mid"])
        src.bands[(b["job_family"], b["level"], b["location"])] = Band(
            b["job_family"], b["level"], b["location"], "USD", mid * 0.8, mid, mid * 1.2
        )
    for i, r in enumerate(spec.get("records", [])):
        eff = d(r["effective_date"])
        level = r.get("level", "IC3")
        src.hris.append(
            HrisRecord(
                record_id=r.get("record_id", f"H{i + 1:08d}"),
                employee_number=r.get("employee_number", "E000001"),
                record_type=r["record_type"],
                effective_date=eff,
                recorded_at=ts(r["recorded_at"]) if "recorded_at" in r else ts(eff),
                job_code=r.get("job_code", f"SWE-{level}"),
                level=level,
                team_id=r.get("team_id", "T001"),
                manager=r.get("manager", "E000900"),
                location=r.get("location", "RAL"),
                employment_type=r.get("employment_type", "regular"),
                contract_end=d(r.get("contract_end")),
                reason=r.get("reason"),
                corrects=r.get("corrects"),
                batch=r.get("batch", "B"),
                legacy_hire=d(r.get("legacy_hire")),
                legacy_first_promo=d(r.get("legacy_first_promo")),
                legacy_last_promo=d(r.get("legacy_last_promo")),
            )
        )
    for p in spec.get("payroll", []):
        src.payroll.append(
            PayLine(
                p.get("entity", "US-ENT"),
                p.get("employee_number", "E000001"),
                p["period"],
                int(round(float(p["amount"]) * 100)),
                "USD",
                p.get("basis", "M"),
                p.get("file", "F1"),
                ts(p["recorded_at"]) if "recorded_at" in p else ts(date.fromisoformat(p["period"] + "-01")),
            )
        )
    for e in spec.get("org_events", []):
        src.org_events.append(
            OrgEvent(
                e.get("event_id", "OE1"),
                d(e["effective_date"]),
                e.get("kind", "merge"),
                e["team_id"],
                ts(e["recorded_at"]) if "recorded_at" in e else ts(d(e["effective_date"])),
            )
        )
    return src


def load(name: str) -> Sources:
    return build(yaml.safe_load((MICRO_DIR / f"{name}.yaml").read_text()))
