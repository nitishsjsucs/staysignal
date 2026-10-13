"""The data-quality fault benchmark (SPEC 13.6, C53), adapted from DataTrust's fault-injection harness: inject each
planted problem type into copies of the small world (5 seeds each), then measure detection (which phase-1 checks
fire that did not fire on the clean copy), localization (the rank of the true root node in the root-cause ranking)
and the forecast impact had the run not been held (the company's expected 3-month voluntary departures from the
faulty sources against the clean ones, under a model trained on the clean world).

Faults, all applied to what the sources recorded, never to the generator's truth:
- pay_basis: one entity's latest payroll period paid under a new code `ANN` with annual amounts (the demo's defect);
- duplicates: 5% of the HRIS records re-sent in the latest batch with new record IDs and the same content;
- late_terminations: the terminations of the last three months recorded 60 days after their effective date;
- missing_extract: one entity's latest payroll extract missing;
- broken_manager: manager references in 5% of recent records point at an employee who does not exist.
Synthetic worlds only.
"""

from __future__ import annotations

import time
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta

from staysignal.clock import add_months, as_cutoff_datetime
from staysignal.features.reference import Vintage, features_at
from staysignal.forecast.score import score
from staysignal.ingest.landing import Sources, add_text
from staysignal.model import artifact as artifact_io
from staysignal.model.train import train
from staysignal.prng import stream
from staysignal.quality.probes import rca_probe
from staysignal.quality.run_checks import run_checks
from staysignal.world.emit import build_files
from staysignal.world.simulate import simulate
from staysignal.world.spec import SMALL

FAULTS = ("pay_basis", "duplicates", "late_terminations", "missing_extract", "broken_manager")
# the true root of each fault: where the bad records entered (the source and its staging model), or for the pay-basis
# defect the mapping that reads the new code, as SPEC 13.2 expects
ROOT_NODES = {
    "pay_basis": {"stg_map__pay_basis", "stg_payroll__lines"},
    "duplicates": {"src_hris", "stg_hris__records"},
    "late_terminations": {"src_hris", "stg_hris__records"},
    "missing_extract": {"src_payroll", "stg_payroll__lines"},
    "broken_manager": {"src_hris", "stg_hris__records", "int_hris__manager_timeline"},
}
CUTOFF = date(2026, 9, 1)
SEEDS = (1, 2, 3, 4, 5)


def clean_world(seed: int) -> Sources:
    profile = replace(
        SMALL,
        seed=seed,
        planted=None,
        exact_requisitions=None,
        exact_declined_offers=None,
        min_engineering_fixed_term_at_end=0,
    )
    files, _ = build_files(simulate(profile))
    src = Sources()
    for name in sorted(files):
        if name.startswith("sources/"):
            add_text(src, name.split("/", 1)[1], files[name])
    return src


def _copy(src: Sources) -> Sources:
    return replace(src, hris=list(src.hris), payroll=list(src.payroll), hris_batches=list(src.hris_batches))


def inject(src: Sources, fault: str, seed: int, v: datetime) -> Sources:
    out = _copy(src)
    r = stream(seed, f"faults:{fault}")
    hris = [x for x in out.hris if x.recorded_at <= v]
    latest_batch = max(x.recorded_at for x in hris)
    pay = [ln for ln in out.payroll if ln.recorded_at <= v]
    latest = max(ln.period for ln in pay)
    if fault == "pay_basis":
        out.payroll = [
            replace(ln, pay_basis_code="ANN", base_amount_cents=ln.base_amount_cents * 12)
            if ln.entity == "CA-ENT" and ln.period == latest
            else ln
            for ln in out.payroll
        ]
    elif fault == "missing_extract":
        out.payroll = [ln for ln in out.payroll if not (ln.entity == "US-ENT" and ln.period == latest)]
    elif fault == "duplicates":
        pool = sorted(hris, key=lambda x: x.record_id)
        dups = r.sample(pool, max(1, round(0.05 * len(pool))))
        out.hris += [replace(x, record_id=f"D{i:08d}", recorded_at=latest_batch) for i, x in enumerate(dups)]
    elif fault == "late_terminations":
        lo = add_months(v.date(), -3)
        out.hris = [
            replace(
                x,
                recorded_at=datetime(x.effective_date.year, x.effective_date.month, x.effective_date.day, 6, tzinfo=UTC)
                + timedelta(days=60),
            )
            if x.record_type == "termination" and lo <= x.effective_date < v.date()
            else x
            for x in out.hris
        ]
    elif fault == "broken_manager":
        recent = sorted(
            (x for x in hris if x.manager and x.effective_date >= add_months(v.date(), -6)), key=lambda x: x.record_id
        )
        broken = {x.record_id for x in r.sample(recent, max(1, round(0.05 * len(recent))))}
        out.hris = [replace(x, manager="E999999") if x.record_id in broken else x for x in out.hris]
    else:
        raise ValueError(f"unknown fault {fault}")
    return out


def _flagged(results: list[dict]) -> dict[str, str]:
    return {r["check_id"]: r["status"] for r in results if r["status"] != "pass"}


def _expected(model: artifact_io.Model, src: Sources, v: datetime) -> float:
    rows = features_at(Vintage(src, v), CUTOFF)
    return float(score(model, rows, CUTOFF).F[:, 2, 0].sum())


def run_seed(seed: int, log=print) -> list[dict]:
    t0 = time.perf_counter()
    v = as_cutoff_datetime(CUTOFF)
    src = clean_world(seed)
    model = artifact_io.from_dict(train(src, SMALL.start, CUTOFF, v, f"dq-faults-{seed}"))
    clean_flags = _flagged(run_checks(src, v))
    clean_e = _expected(model, src, v)
    out = []
    for fault in FAULTS:
        bad = inject(src, fault, seed, v)
        results = run_checks(bad, v)
        flags = _flagged(results)
        new = {k: s for k, s in flags.items() if clean_flags.get(k) != s}
        failing = [r for r in results if r["status"] != "pass" and r["check_id"] in new]
        probe = rca_probe(bad, v, failing) if failing else {"ranking": []}
        ranking = [x["node"] for x in probe["ranking"]]
        rank = next((i + 1 for i, n in enumerate(ranking) if n in ROOT_NODES[fault]), None)
        e = _expected(model, bad, v)
        out.append(
            {
                "seed": seed,
                "fault": fault,
                "detected": bool(new),
                "checks": dict(sorted(new.items())),
                "held": any(s == "fail" for s in new.values()),
                "root_rank": rank,
                "ranking": ranking[:5],
                "expected_clean": round(clean_e, 4),
                "expected_faulty": round(e, 4),
                "impact": round(e / clean_e - 1.0, 4) if clean_e > 0 else None,
            }
        )
    log(f"dq-faults seed {seed}: {time.perf_counter() - t0:.1f} s")
    return out


def summarize(rows: list[dict]) -> dict:
    out = {}
    for fault in FAULTS:
        rs = [r for r in rows if r["fault"] == fault]
        ranks = [r["root_rank"] for r in rs if r["root_rank"] is not None]
        impacts = [abs(r["impact"]) for r in rs if r["impact"] is not None]
        checks = sorted({c for r in rs for c in r["checks"]})
        out[fault] = {
            "seeds": len(rs),
            "detected": sum(r["detected"] for r in rs),
            "held": sum(r["held"] for r in rs),
            "checks": checks,
            "root_top1": sum(1 for x in ranks if x == 1),
            "root_found": len(ranks),
            "mean_abs_impact": round(sum(impacts) / len(impacts), 4) if impacts else None,
            "max_abs_impact": round(max(impacts), 4) if impacts else None,
        }
    return out


__all__ = ["FAULTS", "ROOT_NODES", "SEEDS", "clean_world", "inject", "run_seed", "summarize"]
