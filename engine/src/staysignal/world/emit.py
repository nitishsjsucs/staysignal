"""Writes a simulated world as source extracts plus truth files and a manifest (SPEC 6.4, 6.5).

Layout under the output directory:
  sources/hris_records.csv               HRIS records recorded up to the first delta day
  sources/hris_delta_<YYYY-MM-DD>.csv    daily HRIS deltas (06:00Z batches) through the demo clock, possibly empty
  sources/payroll_<entity>_<YYYY-MM>.csv  monthly vendor files delivered before the demo clock
  sources/org_teams.csv, org_events.csv, ref_bands.csv, ats_requisitions.csv, ats_offers.csv
  held/payroll_<entity>_2026-09.csv      the held-back September 2026 payroll (lands in demo beat 3)
  audit/audit_attributes.csv             the audit-only attribute (ADR 0013)
  future/hris_future.csv                 records recorded after the demo clock (never landed)
  truth/outcomes.csv                     every true departure (oracle and complete-hindsight scoring only)
  manifest.json                          SHA-256 and row counts per file, realized counts, hazard intercepts

Every float is quantized: pay in integer cents written with two decimals, dates as dates, timestamps to the second.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path

from staysignal.canonical import canonical_json
from staysignal.clock import DEMO_CLOCK, add_months, batch_time, iso_z
from staysignal.world import hazards
from staysignal.world.defects import PAYROLL_DEFECT, apply_payroll_defect, plant
from staysignal.world.simulate import World, band_mid_cents, simulate
from staysignal.world.spec import ENTITIES, JOB_FAMILIES, LEVELS, Profile

GENERATOR_VERSION = "1"

HRIS_COLUMNS = [
    "record_id",
    "employee_number",
    "record_type",
    "effective_date",
    "recorded_at",
    "job_code",
    "level",
    "team_id",
    "manager_employee_number",
    "location_code",
    "employment_type",
    "contract_end_date",
    "termination_reason_code",
    "corrects_record_id",
    "source_batch_id",
    "legacy_hire_date",
    "legacy_first_promotion_date",
    "legacy_last_promotion_date",
]
PAYROLL_COLUMNS = [
    "entity_code",
    "employee_number",
    "pay_period",
    "base_amount",
    "currency",
    "pay_basis_code",
    "vendor_file_id",
    "recorded_at",
]
TEAM_COLUMNS = [
    "team_id",
    "team_name",
    "group_id",
    "group_name",
    "org_id",
    "org_name",
    "valid_from",
    "valid_to",
    "recorded_at",
]
ORG_EVENT_COLUMNS = ["event_id", "effective_date", "kind", "team_id", "recorded_at"]
BAND_COLUMNS = ["job_family", "level", "location_code", "currency", "band_min", "band_mid", "band_max"]
REQ_COLUMNS = ["requisition_id", "team_id", "job_code", "req_type", "status", "event_date", "recorded_at"]
OFFER_COLUMNS = [
    "offer_id",
    "requisition_id",
    "extended_date",
    "decision",
    "decision_date",
    "start_date",
    "recorded_at",
]
AUDIT_COLUMNS = ["employee_number", "age40_from"]
OUTCOME_COLUMNS = ["employee_number", "spell_start", "end_date", "cause", "termination_reason_code", "team_id"]

DELTA_FROM = date(2026, 9, 2)


def fmt(v: object) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return iso_z(v)
    if isinstance(v, date):
        return v.isoformat()
    return str(v)


def money(cents: int) -> str:
    return f"{cents // 100}.{cents % 100:02d}"


def to_csv(columns: list[str], rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(columns)
    for row in rows:
        w.writerow([fmt(row.get(c)) for c in columns])
    return buf.getvalue()


def third_business_day(d: date) -> date:
    n, cur = 0, d
    while True:
        if cur.weekday() < 5:
            n += 1
            if n == 3:
                return cur
        cur += timedelta(days=1)


def group_ids(world: World) -> dict[tuple[str, str], str]:
    groups = sorted({(t.org, t.group) for t in world.teams.values()}, key=lambda g: (g[0], g[1]))
    return {g: f"G{i + 1:02d}" for i, g in enumerate(groups)}


def org_ids(world: World) -> dict[str, str]:
    return {o.name: o.code for o in world.profile.orgs}


def build_files(world: World) -> tuple[dict[str, str], dict]:
    p = world.profile
    planted = plant(world)
    files: dict[str, str] = {}
    demo = DEMO_CLOCK

    # HRIS
    def batch_id(rec) -> str:
        if rec.source_batch_id:
            return rec.source_batch_id
        if rec.record_type == "migration_baseline":
            return "HRIS-MIGRATION"
        return f"HRIS-{rec.recorded_at.date().isoformat()}"

    rows = []
    for rec in sorted(world.records, key=lambda r: (r.recorded_at, r.record_id)):
        row = {c: getattr(rec, c) for c in HRIS_COLUMNS if c != "source_batch_id"}
        row["source_batch_id"] = batch_id(rec)
        rows.append(row)
    delta_from_ts = batch_time(DELTA_FROM)
    base = [r for r in rows if r["recorded_at"] < delta_from_ts]
    future = [r for r in rows if r["recorded_at"] > demo]
    files["sources/hris_records.csv"] = to_csv(HRIS_COLUMNS, base)
    day = DELTA_FROM
    while batch_time(day) <= demo:
        ts = batch_time(day)
        files[f"sources/hris_delta_{day.isoformat()}.csv"] = to_csv(
            HRIS_COLUMNS, [r for r in rows if r["recorded_at"] == ts]
        )
        day += timedelta(days=1)
    files["future/hris_future.csv"] = to_csv(HRIS_COLUMNS, future)
    covered = (
        len(base)
        + len(future)
        + sum(
            1
            for r in rows
            if delta_from_ts <= r["recorded_at"] <= demo and r["recorded_at"].hour == 6 and r["recorded_at"].minute == 0
        )
    )
    assert covered == len(rows), "every HRIS record lands in exactly one file"

    # Payroll: vendor files per entity and month; September 2026 is held back and carries the defect.
    defect_lines = apply_payroll_defect(world.payroll)
    by_file: dict[tuple[str, str], list[dict]] = {}
    for line in world.payroll:
        by_file.setdefault((line["entity_code"], line["pay_period"]), []).append(line)
    payroll_files = 0
    for (entity, period), lines in sorted(by_file.items()):
        y, m = (int(x) for x in period.split("-"))
        held = (entity, period) == (PAYROLL_DEFECT["entity"], PAYROLL_DEFECT["period"]) or period == PAYROLL_DEFECT[
            "period"
        ]
        delivered = demo if held else batch_time(third_business_day(add_months(date(y, m, 1), 1)))
        vendor_file_id = f"{entity}-{period}-01"
        out = []
        for line in sorted(lines, key=lambda x: x["employee_number"]):
            amount = line["annual_cents"] if line["pay_basis_code"] == "ANN" else line["monthly_cents"]
            out.append(
                {
                    "entity_code": entity,
                    "employee_number": line["employee_number"],
                    "pay_period": period,
                    "base_amount": money(amount),
                    "currency": line["currency"],
                    "pay_basis_code": line["pay_basis_code"],
                    "vendor_file_id": vendor_file_id,
                    "recorded_at": delivered,
                }
            )
        folder = "held" if held else "sources"
        files[f"{folder}/payroll_{entity}_{period}.csv"] = to_csv(PAYROLL_COLUMNS, out)
        payroll_files += 1

    # Organization tree (SCD2) and reorganization events.
    gids, oids = group_ids(world), org_ids(world)
    team_rows = []
    for row in sorted(world.team_rows, key=lambda r: (r["team_id"], r["valid_from"])):
        team_rows.append(
            {
                "team_id": row["team_id"],
                "team_name": row["team_name"],
                "group_id": gids[(row["org"], row["group"])],
                "group_name": row["group"],
                "org_id": oids[row["org"]],
                "org_name": row["org"],
                "valid_from": row["valid_from"],
                "valid_to": row["valid_to"],
                "recorded_at": batch_time(max(p.start, row["valid_from"] - timedelta(days=14)))
                if row["valid_from"] > p.start
                else batch_time(p.start),
            }
        )
    files["sources/org_teams.csv"] = to_csv(TEAM_COLUMNS, team_rows)
    files["sources/org_events.csv"] = to_csv(ORG_EVENT_COLUMNS, sorted(world.org_events, key=lambda e: e["event_id"]))

    # Reference pay bands (annual, local currency).
    bands = []
    for fam in JOB_FAMILIES:
        for lvl in LEVELS:
            for loc in p.locations:
                mid = band_mid_cents(fam, lvl, loc.pay_factor)
                bands.append(
                    {
                        "job_family": fam,
                        "level": lvl,
                        "location_code": loc.code,
                        "currency": loc.currency,
                        "band_min": money(int(round(mid * 0.8))),
                        "band_mid": money(mid),
                        "band_max": money(int(round(mid * 1.2))),
                    }
                )
    files["sources/ref_bands.csv"] = to_csv(BAND_COLUMNS, bands)

    # ATS: requisition and offer events, recorded on their dates.
    req_rows, future_req = [], 0
    for r in sorted(world.reqs, key=lambda r: r.id):
        job = f"{r.family}-{r.level}"
        events = [("open", r.opened)] + (
            [(r.status, r.closed)] if r.status in ("filled", "cancelled") and r.closed else []
        )
        for status, d in events:
            ts = batch_time(d)
            if ts > demo:
                future_req += 1
                continue
            req_rows.append(
                {
                    "requisition_id": r.id,
                    "team_id": r.team,
                    "job_code": job,
                    "req_type": r.req_type,
                    "status": status,
                    "event_date": d,
                    "recorded_at": ts,
                }
            )
    files["sources/ats_requisitions.csv"] = to_csv(REQ_COLUMNS, req_rows)
    offer_rows = [
        dict(o, recorded_at=batch_time(o["decision_date"]))
        for o in sorted(world.offers, key=lambda o: o["offer_id"])
        if batch_time(o["decision_date"]) <= demo
    ]
    files["sources/ats_offers.csv"] = to_csv(OFFER_COLUMNS, offer_rows)

    # Audit-only attribute: the first day of the month in which the person is 40 or over (ADR 0013).
    audit_rows = []
    end = world.end
    for en in sorted(world.people):
        person = world.people[en]
        forty = date(person.birth.year + 40, person.birth.month, 1)
        if forty <= p.start:
            v = p.start
        elif forty < end:
            v = forty if forty.day == 1 else add_months(forty, 1)
        else:
            v = None
        audit_rows.append({"employee_number": en, "age40_from": v})
    files["audit/audit_attributes.csv"] = to_csv(AUDIT_COLUMNS, audit_rows)

    # Truth: every true departure.
    outcome_rows = [
        {
            "employee_number": o["employee_number"],
            "spell_start": o["spell_start"],
            "end_date": o["end_date"],
            "cause": o["cause"],
            "termination_reason_code": o["reason"],
            "team_id": o["team_id"],
        }
        for o in sorted(world.outcomes, key=lambda o: (o["end_date"], o["employee_number"]))
    ]
    files["truth/outcomes.csv"] = to_csv(OUTCOME_COLUMNS, outcome_rows)

    # Realized counts.
    causes = Counter(o["cause"] for o in world.outcomes)
    years = p.months / 12.0
    avg_hc = sum(m["headcount_start"] for m in world.monthly) / len(world.monthly)
    end_active = [pp for pp in world.people.values() if pp.active]
    eng_ft_end = sum(
        1 for pp in end_active if pp.emp_type == "fixed_term" and world.teams[pp.team].org == "Engineering"
    )
    req_status = Counter(r.status for r in world.reqs)
    offer_decisions = Counter(o["decision"] for o in world.offers)
    promo_counts = {k: v for k, v in world.counts.items() if k.startswith("promotions")}
    realized = {
        "baseline_headcount": p.baseline_headcount,
        "closing_headcount": len(end_active),
        "distinct_people": len(world.people),
        "hires": world.counts.get("new_hires", 0) + world.counts.get("rehires", 0),
        "hires_by_month_min_max": [min(m["hires"] for m in world.monthly), max(m["hires"] for m in world.monthly)],
        "new_hires": world.counts.get("new_hires", 0),
        "rehires": world.counts.get("rehires", 0),
        "departures": {k: causes.get(k, 0) for k in ("voluntary", "involuntary", "retirement")},
        "ft_end_exits": world.counts.get("ft_ended", 0),
        "annual_rates_per_100": {
            k: round(100.0 * causes.get(k, 0) / avg_hc / years, 2) for k in ("voluntary", "involuntary", "retirement")
        },
        "average_headcount": round(avg_hc, 1),
        "transfers": world.counts.get("transfers", 0),
        "promotions": promo_counts,
        "cycle_promotion_rates": getattr(world, "cycle_rates", {}),
        "successions": world.counts.get("successions", 0),
        "reorganizations": {k.split(":")[1]: v for k, v in world.counts.items() if k.startswith("reorg:")},
        "engineering_fixed_term_at_end": eng_ft_end,
        "requisitions": dict(sorted(req_status.items())),
        "requisitions_by_type": dict(sorted(Counter(r.req_type for r in world.reqs).items())),
        "offers": dict(sorted(offer_decisions.items())),
        "payroll_files": payroll_files,
        "payroll_defect_lines": defect_lines,
        "hris_records": len(rows),
        "hris_future_records": len(future),
        "planted": {k: len(v) for k, v in sorted(planted.items())},
        "teams_at_end": sum(1 for t in world.teams.values() if t.valid_to is None),
    }
    return files, {"realized": realized, "planted_ids": {k: sorted(v) for k, v in sorted(planted.items())}}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def generate(profile: Profile, out: Path | None = None) -> dict:
    world = simulate(profile)
    files, extra = build_files(world)
    manifest = {
        "profile": profile.name,
        "seed": profile.seed,
        "generator_version": GENERATOR_VERSION,
        "label": "synthetic",
        "calendar": {"start": profile.start.isoformat(), "months": profile.months, "demo_clock": iso_z(DEMO_CLOCK)},
        "hazard_intercepts": dict(hazards.INTERCEPTS),
        "hazard_intercepts_start": dict(hazards.START_INTERCEPTS),
        "knobs": {
            "latent_sd": profile.latent_sd,
            "interaction": profile.interaction,
            "promo_effect": profile.promo_effect,
            "drift": profile.drift,
            "sigma_team": profile.sigma_team,
            "sigma_org": profile.sigma_org,
            "contagion": profile.contagion,
            "engineering_fixed_term_share": profile.engineering_fixed_term_share,
        },
        "entities": ENTITIES,
        "files": {
            name: {"sha256": sha256_text(text), "rows": text.count("\n") - 1} for name, text in sorted(files.items())
        },
        "realized": extra["realized"],
    }
    manifest["world_sha256"] = sha256_text(canonical_json({k: v["sha256"] for k, v in manifest["files"].items()}))
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            path = out / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        (out / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (out / "planted_ids.json").write_text(
            json.dumps(extra["planted_ids"], indent=1, sort_keys=True) + "\n", encoding="utf-8"
        )
    return manifest
