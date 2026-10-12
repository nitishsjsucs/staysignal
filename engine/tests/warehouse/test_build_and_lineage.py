"""The warehouse builds in process on the engine's own connection, every model and structure test passes, and the
captured column lineage follows the compensation path the checks and the root-cause ranking rely on."""

import pytest

from staysignal.lineage.capture import column_edges

pytestmark = pytest.mark.dbt


def test_build_succeeds_with_every_model_and_structure_test(built):
    con, _, _, res = built
    assert res.success
    by_name = res.results_by_name()
    models = [n for n, r in by_name.items() if r["node"].get("resource_type") == "model"]
    assert {
        "stg_hris__records",
        "int_hris__spells",
        "fct_employee_month",
        "fct_comp_position",
        "rpt_workforce_monthly",
    } <= set(models)
    failed = {
        n: r["status"] for n, r in by_name.items() if r["status"] not in ("success", "pass") and not n.startswith("dq_")
    }
    assert failed == {}
    assert con.execute("SELECT count(*) FROM restricted.fct_comp_position").fetchone()[0] > 0


def test_column_lineage_reaches_the_compa_ratio(built):
    edges = column_edges(built[3].events)
    assert ("raw.raw_payroll.pay_basis_code", "staging.stg_payroll__lines.pay_basis_code") in edges
    assert ("staging.stg_payroll__lines.base_amount_cents", "staging.int_comp__annualized.annual_base") in edges
    assert ("staging.stg_map__pay_basis.annual_multiplier", "staging.int_comp__annualized.annual_base") in edges
    assert ("staging.int_comp__annualized.annual_base", "restricted.fct_comp_position.compa_ratio") in edges
    assert ("staging.stg_ref__bands.band_mid", "restricted.fct_comp_position.compa_ratio") in edges


def test_audit_attribute_is_isolated(built):
    """assert_audit_isolated: no model outside the audit schema depends on the audit source (ADR 0013)."""
    manifest = built[3].manifest
    for node in manifest["nodes"].values():
        if node["resource_type"] != "model" or node.get("schema") == "audit":
            continue
        assert not any("source.staysignal.audit." in d for d in node["depends_on"]["nodes"]), node["name"]


def test_no_employee_number_in_any_built_model(built):
    con = built[0]
    tables = con.execute(
        "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('staging', 'restricted', 'published')"
    ).fetchall()
    for schema, table in tables:
        cols = [r[0] for r in con.execute(f"DESCRIBE {schema}.{table}").fetchall()]
        assert "employee_number" not in cols and "manager_employee_number" not in cols, f"{schema}.{table}"
