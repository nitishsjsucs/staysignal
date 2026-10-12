"""Phase-1 data-quality checks (SPEC 13.1) over the landed sources at a vintage, under a pay-basis mapping.

Engine implementations of the registry's phase-1 checks; the dbt singular tests of M2 implement the same rules and a
test compares them. Freshness runs against the synthetic clock. Results are counts only: no row of a failing check
leaves the engine (record-level inspection is the break-glass path of SPEC 13.7).
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

import yaml

from staysignal.features.reference import MAPPINGS, Vintage
from staysignal.ingest.landing import Sources


@lru_cache(maxsize=1)
def registry() -> list[dict]:
    here = Path(__file__).resolve()
    for parent in here.parents:
        p = parent / "checks" / "registry.yml"
        if p.exists():
            return yaml.safe_load(p.read_text(encoding="utf-8"))["checks"]
    raise FileNotFoundError("checks/registry.yml")


def phase1() -> list[dict]:
    return [c for c in registry() if c["phase"] == 1]


def psi(a: list[float], b: list[float], bins: int = 10) -> float:
    """Population stability index of b against a on a's deciles (log scale for pay)."""
    if len(a) < 20 or len(b) < 20:
        return 0.0
    la = sorted(math.log(max(x, 1.0)) for x in a)
    edges = [la[int(len(la) * k / bins)] for k in range(1, bins)]

    def dist(xs: list[float]) -> list[float]:
        counts = [0] * bins
        for x in xs:
            v = math.log(max(x, 1.0))
            i = sum(1 for e in edges if v > e)
            counts[i] += 1
        return [max(c / len(xs), 1e-4) for c in counts]

    pa, pb = dist(a), dist(b)
    return sum((y - x) * math.log(y / x) for x, y in zip(pa, pb, strict=True))


def _annualized(lines, mapping) -> dict[tuple[str, str], tuple[float | None, str]]:
    out = {}
    for ln in lines:
        out[(ln.employee_number, ln.period)] = (
            mapping.annualize(ln.base_amount_cents / 100.0, ln.pay_basis_code),
            ln.pay_basis_code,
        )
    return out


def run_checks(src: Sources, v: datetime, mapping_name: str = "payroll@1") -> list[dict]:
    """Phase-1 results at vintage v; each result has status pass, warn or fail and a failing-row count."""
    mapping = MAPPINGS[mapping_name]
    vin = Vintage(src, v)
    by_id = {c["id"]: c for c in phase1()}
    results: dict[str, tuple[str, int, str]] = {}

    def put(cid: str, failing: int, detail: str = "") -> None:
        sev = by_id[cid]["severity"]
        status = "pass" if failing == 0 else ("fail" if sev == "error" else "warn")
        results[cid] = (status, failing, detail)

    hris = [r for r in src.hris if r.recorded_at <= v]
    newest = max((r.recorded_at for r in hris), default=v - timedelta(days=99))
    put("F01", 0 if v - newest <= timedelta(hours=36) else 1, f"newest HRIS batch {newest.isoformat()}")

    latest_batch = newest
    seen: set[tuple] = set()
    new_dups = 0
    for r in sorted(hris, key=lambda r: (r.recorded_at, r.record_id)):
        k = r.content_key()
        if k in seen and r.recorded_at == latest_batch:
            new_dups += 1
        seen.add(k)
    put("U01", new_dups, f"{vin.duplicates_dropped} duplicates removed in total")

    pay = [ln for ln in src.payroll if ln.recorded_at <= v]
    periods = sorted({ln.period for ln in pay})
    latest = periods[-1] if periods else None
    prev = periods[-2] if len(periods) > 1 else None
    cur_lines = [ln for ln in pay if ln.period == latest]
    keys = Counter((ln.entity, ln.employee_number, ln.period) for ln in cur_lines)
    put("U02", sum(c - 1 for c in keys.values() if c > 1))

    # R01 and X01: payroll against HRIS spells in the pay period
    if latest:
        y, m = (int(x) for x in latest.split("-"))
        p0 = datetime(y, m, 1).date()
        p1 = (datetime(y + (m == 12), m % 12 + 1, 1)).date()
        active: dict[str, set[str]] = defaultdict(set)
        loc_entity = {"RAL": "US-ENT", "PIT": "US-ENT", "VAN": "CA-ENT", "MAN": "UK-ENT"}
        for en, spells in vin.spells.items():
            for sp in spells:
                if sp.start < p1 and (sp.end is None or sp.end > p0):
                    recs = [r for r in sp.records if r.effective_date < p1 and r.record_type != "termination"]
                    if recs:
                        active[loc_entity.get(recs[-1].location, "US-ENT")].add(en)
        paid: dict[str, set[str]] = defaultdict(set)
        for ln in cur_lines:
            paid[ln.entity].add(ln.employee_number)
        all_active = set().union(*active.values()) if active else set()
        put("R01", sum(1 for ln in cur_lines if ln.employee_number not in all_active))
        put("X01", sum(abs(len(paid[e]) - len(active[e])) for e in sorted(set(paid) | set(active))))
    else:
        put("R01", 0)
        put("X01", 0)

    overlaps = 0
    for spells in vin.spells.values():
        ordered = sorted(spells, key=lambda s: s.start)
        for a, b in zip(ordered, ordered[1:], strict=False):
            if a.end is None or a.end > b.start:
                overlaps += 1
    put("H01", overlaps)

    ids = {r.record_id for r in hris}
    put("H02", sum(1 for r in hris if r.record_type in ("correction", "rescission") and r.corrects not in ids))

    # Compensation checks on the latest period known at v
    ann = _annualized(cur_lines, mapping)
    prev_ann = _annualized([ln for ln in pay if ln.period == prev], mapping) if prev else {}
    bad_compa, big_change, unmapped = 0, 0, 0
    by_entity_cur: dict[str, list[float]] = defaultdict(list)
    by_entity_prev: dict[str, list[float]] = defaultdict(list)
    for ln in cur_lines:
        a, code = ann[(ln.employee_number, ln.period)]
        if code not in mapping.multipliers:
            unmapped += 1
        sp = vin.spell_at(ln.employee_number, p1) if latest else None
        recs = [r for r in sp.records if r.record_type != "termination"] if sp else []
        if a is not None and recs:
            band = src.bands.get((recs[-1].family, recs[-1].level, recs[-1].location))
            if band and not (0.5 <= a / band.band_mid <= 2.0):
                bad_compa += 1
        if a is not None:
            by_entity_cur[ln.entity].append(a)
            p = prev_ann.get((ln.employee_number, prev)) if prev else None
            if p and p[0] and (a / p[0] > 3.0 or p[0] / a > 3.0):
                big_change += 1
    for ln in pay:
        if ln.period == prev:
            a = mapping.annualize(ln.base_amount_cents / 100.0, ln.pay_basis_code)
            if a is not None:
                by_entity_prev[ln.entity].append(a)
    put("C01", bad_compa)
    put("C02", big_change)
    worst = max((psi(by_entity_prev[e], by_entity_cur[e]) for e in by_entity_cur if by_entity_prev.get(e)), default=0.0)
    put("C03", 1 if worst >= 0.25 else 0, f"max PSI {worst:.3f}")
    put("C04", unmapped)

    out = []
    for cid in sorted(results):
        status, failing, detail = results[cid]
        c = by_id[cid]
        out.append(
            {
                "check_id": cid,
                "name": c["name"],
                "date": v.date().isoformat(),
                "status": status,
                "severity": c["severity"],
                "failing_rows": failing,
                "node": c["node"],
                "source": c["sources"][0],
                "detail": detail,
            }
        )
    return out


def summarize(results: list[dict]) -> dict:
    return {
        "failing": sorted(r["check_id"] for r in results if r["status"] == "fail"),
        "warnings": sorted(r["check_id"] for r in results if r["status"] == "warn"),
        "results": results,
    }
