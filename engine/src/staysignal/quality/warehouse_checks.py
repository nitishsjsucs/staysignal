"""Phase-1 checks on the warehouse (SPEC 13.1): the registry's singular checks are dbt tests (`warehouse/tests/dq`,
one row per failing unit), and its engine checks (F01 freshness, U01 new duplicates, C03 pay distribution) run here
as SQL on the engine's connection after the build. Results have the same shape as `quality.run_checks`, which is the
pure-Python reference; `engine/tests/quality/test_warehouse_checks.py` asserts both agree on the canonical world,
including the payroll defect pattern. Counts only: no failing row leaves the engine.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta

import duckdb

from staysignal.lineage.capture import BuildResult
from staysignal.quality.run_checks import phase1, psi


def _status(severity: str, failing: int) -> str:
    return "pass" if failing == 0 else ("fail" if severity == "error" else "warn")


def dbt_failures(build: BuildResult) -> dict[str, int]:
    """Failing-unit counts of the dq tests, by check ID (from each test's meta)."""
    out: dict[str, int] = {}
    for r in build.results_by_name().values():
        node = r["node"]
        meta = (node.get("config") or {}).get("meta") or node.get("meta") or {}
        cid = meta.get("check_id")
        if cid:
            if r["status"] == "error":
                raise RuntimeError(f"check {cid} did not run: {r.get('message')}")
            out[cid] = int(r.get("failures") or 0)
    return out


def engine_checks(con: duckdb.DuckDBPyConnection, v: datetime) -> dict[str, tuple[int, str]]:
    out: dict[str, tuple[int, str]] = {}
    newest = con.execute(
        "SELECT max(delivered_at) FROM raw._deliveries WHERE source = 'hris' AND delivered_at <= ?", [v]
    ).fetchone()[0]
    stale = newest is None or v - newest > timedelta(hours=36)
    out["F01"] = (1 if stale else 0, f"newest HRIS batch {newest.isoformat() if newest else 'none'}")

    latest, total = con.execute(
        "SELECT max(recorded_at), count(*) FILTER (WHERE copy_no > 1) FROM staging.stg_hris__records "
        "WHERE recorded_at <= ?",
        [v],
    ).fetchone()
    new_dups = con.execute(
        "SELECT count(*) FROM staging.stg_hris__records WHERE copy_no > 1 AND recorded_at = ?", [latest]
    ).fetchone()[0]
    out["U01"] = (int(new_dups), f"{total} duplicates removed in total")

    periods = [
        r[0] for r in con.execute("SELECT DISTINCT pay_period FROM staging.int_comp__annualized ORDER BY 1").fetchall()
    ]
    worst = 0.0
    if len(periods) >= 2:
        cur, prev = periods[-1], periods[-2]
        vals: dict[tuple[str, str], list[float]] = defaultdict(list)
        for entity, period, annual in con.execute(
            "SELECT entity_code, pay_period, annual_base FROM staging.int_comp__annualized "
            "WHERE pay_period IN (?, ?) AND annual_base IS NOT NULL",
            [cur, prev],
        ).fetchall():
            vals[(entity, period)].append(float(annual))
        entities = sorted({e for e, p in vals if p == cur})
        worst = max(
            (psi(vals[(e, prev)], vals[(e, cur)]) for e in entities if vals.get((e, prev))),
            default=0.0,
        )
    out["C03"] = (1 if worst >= 0.25 else 0, f"max PSI {worst:.3f}")
    return out


def phase1_results(con: duckdb.DuckDBPyConnection, build: BuildResult, v: datetime) -> list[dict]:
    """Phase-1 results at vintage v after a build at that vintage, in `run_checks` format."""
    reg = {c["id"]: c for c in phase1()}
    counts: dict[str, tuple[int, str]] = {cid: (n, "") for cid, n in dbt_failures(build).items()}
    counts.update(engine_checks(con, v))
    missing = sorted(set(reg) - set(counts))
    if missing:
        raise RuntimeError(f"phase-1 checks without an implementation: {missing}")
    out = []
    for cid in sorted(reg):
        c = reg[cid]
        failing, detail = counts[cid]
        out.append(
            {
                "check_id": cid,
                "name": c["name"],
                "date": v.date().isoformat(),
                "status": _status(c["severity"], failing),
                "severity": c["severity"],
                "failing_rows": failing,
                "node": c["node"],
                "source": c["sources"][0],
                "detail": detail,
            }
        )
    return out


__all__ = ["dbt_failures", "engine_checks", "phase1_results"]
