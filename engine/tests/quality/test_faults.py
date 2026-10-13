"""C53: the data-quality fault benchmark (SPEC 13.6) on one copy of the small world: what the phase-1 checks catch,
where the root-cause ranking puts the root, and how much the forecast would have moved had the run not been held."""

from staysignal.quality.faults import FAULTS, run_seed, summarize


def test_one_seed_of_the_fault_benchmark():
    rows = {r["fault"]: r for r in run_seed(1, log=lambda *_: None)}
    assert set(rows) == set(FAULTS)
    pay = rows["pay_basis"]
    assert pay["held"] and {"C01", "C02", "C03"} <= set(pay["checks"]) and pay["checks"]["C04"] == "warn"
    assert pay["root_rank"] == 1 and pay["ranking"][0] == "stg_map__pay_basis"
    assert abs(pay["impact"]) > 0.05  # annual amounts read as monthly move the compensation features
    dup = rows["duplicates"]
    assert dup["checks"] == {"U01": "warn"} and not dup["held"] and dup["impact"] == 0.0  # staging deduplicates
    assert rows["missing_extract"]["checks"] == {"X01": "fail"}
    # R02 (manager references) is a phase-2 check, so the phase-1 suite misses a broken reference
    assert not rows["broken_manager"]["detected"]
    s = summarize(list(rows.values()))
    assert s["pay_basis"]["root_top1"] == 1 and s["broken_manager"]["detected"] == 0
