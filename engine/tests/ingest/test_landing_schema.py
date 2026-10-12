"""Extracts are validated against sources/schemas before anything lands."""

import pytest

from staysignal.ingest.landing import LandingRejected, land
from staysignal.ingest.schemas import KINDS, columns, kind_of


def test_every_world_extract_has_a_kind(small):
    for p in list((small / "sources").glob("*.csv")) + list((small / "held").glob("*.csv")):
        assert kind_of(p.name) is not None, p.name


def test_a_malformed_extract_is_rejected_and_not_landed(small, tmp_path):
    src = next((small / "sources").glob("payroll_US-ENT_*.csv"))
    lines = src.read_text().splitlines()
    head, first = lines[0], lines[1].split(",")
    first[1] = "12345"  # employee_number must look like E000123
    bad = tmp_path / src.name
    bad.write_text("\n".join([head, ",".join(first), *lines[2:]]) + "\n")
    with pytest.raises(LandingRejected) as e:
        land(bad, tmp_path / "landing")
    assert "employee_number" in str(e.value)
    assert not (tmp_path / "landing").exists()


def test_unknown_pay_basis_codes_pass_the_schema(small, tmp_path):
    """The pay-basis defect is a data problem for the checks, not a schema violation."""
    src = next((small / "sources").glob("payroll_CA-ENT_*.csv"))
    text = src.read_text().replace(",M,", ",ANN,")
    path = tmp_path / src.name
    path.write_text(text)
    assert land(path, tmp_path / "landing").rows > 0


def test_schemas_name_the_columns_the_world_emits(small):
    for kind in KINDS:
        files = [p for p in (small / "sources").glob("*.csv") if kind.pattern.match(p.name)]
        for p in files[:1]:
            header = p.read_text().splitlines()[0].split(",")
            assert set(header) <= set(columns(kind)), (p.name, set(header) - set(columns(kind)))
