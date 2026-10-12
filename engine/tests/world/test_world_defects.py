"""C4: planted problems exist exactly as specified (SPEC 6.5)."""

import csv

from tests.conftest import manifest


def test_planted_counts(canonical):
    p = manifest(canonical)["realized"]["planted"]
    assert p == {
        "audit_batch_manager_correction": 9,
        "audit_batch_termination": 12,
        "duplicate": 60,
        "late_termination": 75,
        "manager_change_to_other": 20,
        "manager_revert": 20,
        "reclassified_reason": 25,
        "rescinded_termination": 12,
        "value_correction": 140,
    }


def test_payroll_defect_is_the_ca_entity_september_file(canonical):
    with (canonical / "held" / "payroll_CA-ENT_2026-09.csv").open() as f:
        lines = list(csv.DictReader(f))
    assert lines and all(x["pay_basis_code"] == "ANN" for x in lines)
    assert all(x["recorded_at"] == "2026-10-05T14:00:00Z" for x in lines)
    with (canonical / "sources" / "payroll_CA-ENT_2026-08.csv").open() as f:
        assert {x["pay_basis_code"] for x in csv.DictReader(f)} == {"M"}
    assert manifest(canonical)["realized"]["payroll_defect_lines"] == len(lines)


def test_audit_batch_composition(canonical):
    with (canonical / "sources" / "hris_delta_2026-09-15.csv").open() as f:
        audit = [r for r in csv.DictReader(f) if r["source_batch_id"] == "HRIS-AUDIT-2026-09-15"]
    terms = [r for r in audit if r["record_type"] == "termination"]
    assert len(terms) == 12
    # 9 voluntary and 3 involuntary when July and August have them; the composition knob fills a shortfall
    assert sum(r["termination_reason_code"] == "VOL_RESIGN" for r in terms) >= 9
    assert all("2026-07-01" <= r["effective_date"] < "2026-09-01" for r in terms)
    assert manifest(canonical)["realized"]["audit_batch_mix"] == {"FT_END": 1, "VOL_RESIGN": 11}
    assert all(r["effective_date"] < "2026-09-01" for r in audit)
    assert sum(r["record_type"] == "correction" for r in audit) == 9
