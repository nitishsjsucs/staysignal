"""Payroll mappings v1 and v2: hashed, compiled into raw.map_pay_basis, and the same rule as the reference features."""

from staysignal.features.reference import MAPPINGS
from staysignal.ingest import mappings


def test_both_versions_compile_with_their_unknown_code_rule(loaded):
    con, _, _ = loaded
    rows = con.execute(
        "SELECT mapping_version, code, annual_multiplier, unknown_codes FROM raw.map_pay_basis ORDER BY 1, 2"
    ).fetchall()
    assert ("payroll@1", "*", 12, "monthly") in rows
    assert ("payroll@1", "M", 12, "monthly") in rows
    assert ("payroll@2", "*", None, "reject") in rows
    assert ("payroll@2", "ANN", 1, "reject") in rows
    assert ("payroll@2", "M", 12, "reject") in rows


def test_mapping_hashes_are_stable_and_distinct():
    v = mappings.versions("payroll")
    a, b = mappings.mapping_sha256(v[1]), mappings.mapping_sha256(v[2])
    assert a != b and len(a) == 64
    assert mappings.mapping_sha256(dict(reversed(list(v[1].items())))) == a


def test_yaml_rules_match_the_reference_features():
    v = mappings.versions("payroll")
    for n, ref in ((1, MAPPINGS["payroll@1"]), (2, MAPPINGS["payroll@2"])):
        for code in ("M", "ANN", "XYZ"):
            expected = ref.multipliers.get(code, 12 if ref.unknown == "monthly" else None)
            assert mappings.annual_multiplier(v[n], code) == expected, (n, code)
