"""The rca_probe job (SPEC 13.2): probe anomalies rendered from the engine's own templates (the Worker never sends
SQL). The decisive probe for the payroll defect is the ratio of annualized pay to band midpoint by entity and pay-basis
code; every result is an aggregate by entity and code, never a row."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from statistics import median

from staysignal.features.reference import MAPPINGS, Vintage
from staysignal.ingest.landing import Sources
from staysignal.lineage.graph import path_between, rank


def pay_ratio_probe(src: Sources, v: datetime, mapping: str = "payroll@1") -> list[dict]:
    vin = Vintage(src, v)
    m = MAPPINGS[mapping]
    pay = [ln for ln in src.payroll if ln.recorded_at <= v]
    latest = max(ln.period for ln in pay)
    groups: dict[tuple[str, str], list[float]] = defaultdict(list)
    for ln in pay:
        if ln.period != latest:
            continue
        sp = vin.spells.get(ln.employee_number, [])
        recs = [r for s in sp for r in s.records if r.record_type != "termination"]
        if not recs:
            continue
        a = recs[-1]
        band = src.bands.get((a.family, a.level, a.location))
        ann = m.annualize(ln.base_amount_cents / 100.0, ln.pay_basis_code)
        if band and ann:
            groups[(ln.entity, ln.pay_basis_code)].append(ann / band.band_mid)
    out = []
    for (entity, code), ratios in sorted(groups.items()):
        med = median(ratios)
        out.append(
            {
                "probe": "annualized_pay_to_band_mid",
                "node": "stg_payroll__lines",
                "column": "pay_basis_code",
                "entity": entity,
                "pay_basis_code": code,
                "period": latest,
                "n": len(ratios),
                "median_ratio": round(med, 3),
                "anomaly": round(min(1.0, abs(med - 1.0) / 2.0), 3),
            }
        )
    return out


def rca_probe(src: Sources, v: datetime, failing_checks: list[dict]) -> dict:
    probes = pay_ratio_probe(src, v)
    anomalous = [p for p in probes if p["anomaly"] >= 0.9]
    anomalies = {}
    if anomalous:
        anomalies["stg_payroll__lines"] = max(p["anomaly"] for p in anomalous)
        anomalies["stg_map__pay_basis"] = max(p["anomaly"] for p in anomalous)
    nodes = sorted({c["node"] for c in failing_checks})
    ranking = rank(nodes, anomalies, changed={"stg_payroll__lines", "stg_map__pay_basis"} if anomalous else set())
    path = path_between("stg_payroll__lines", "forecast_run")
    return {
        "probes": probes,
        "ranking": ranking[:8],
        "path": path,
        "failing_nodes": nodes,
        "label": "synthetic",
        "ranking_source": "engine-side ranking (the Worker RCA port from DataTrust arrives in M2)",
    }
