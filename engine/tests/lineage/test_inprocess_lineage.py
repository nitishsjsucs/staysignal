"""ADR 0012 spike: OpenLineage events captured in process (dbtRunner on the engine's own DuckDB connection, then the
artifact processor) equal `dbt-ol build`'s, apart from run IDs, times and the dataset namespace (which embeds the
absolute database path). If this ever fails, the engine falls back to the subprocess path of ADR 0012."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from staysignal.duck import open_duckdb
from staysignal.lineage.capture import build, column_edges

TOY = Path(__file__).parent / "toy_project"


def normalize(events: list[dict]) -> list[tuple]:
    out = []
    for e in events:
        if e.get("eventType") != "COMPLETE" or not e.get("outputs"):
            continue
        cols = {}
        for o in e["outputs"]:
            fields = ((o.get("facets") or {}).get("columnLineage") or {}).get("fields") or {}
            for col, spec in fields.items():
                cols[f"{o['name']}.{col}"] = sorted((i["name"], i["field"]) for i in spec.get("inputFields", []))
        out.append(
            (
                e["job"]["name"],
                tuple(sorted(i["name"] for i in e.get("inputs", []))),
                tuple(sorted(o["name"] for o in e["outputs"])),
                json.dumps(cols, sort_keys=True),
            )
        )
    return sorted(out)


@pytest.mark.dbt
def test_inprocess_events_equal_dbt_ol(tmp_path):
    a = tmp_path / "subprocess"
    shutil.copytree(TOY, a / "project")
    events_file = a / "openlineage.jsonl"
    (a / "openlineage.yml").write_text(
        f"transport:\n  type: file\n  log_file_path: {json.dumps(str(events_file))}\n  append: true\n"
    )
    bindir = Path(sys.executable).parent
    env = {
        **os.environ,
        "PATH": f"{bindir}{os.pathsep}{os.environ.get('PATH', '')}",
        "SS_WAREHOUSE": str(a / "toy.duckdb"),
        "OPENLINEAGE_CONFIG": str(a / "openlineage.yml"),
        "OPENLINEAGE_NAMESPACE": "staysignal",
        "DBT_SEND_ANONYMOUS_USAGE_STATS": "false",
        "DO_NOT_TRACK": "1",
    }
    proj = a / "project"
    subprocess.run(
        [
            str(bindir / "dbt-ol"),
            "build",
            "--project-dir",
            str(proj),
            "--profiles-dir",
            str(proj),
            "--target-path",
            str(a / "target"),
        ],
        env=env,
        cwd=proj,
        check=True,
        capture_output=True,
    )
    from_subprocess = [json.loads(line) for line in events_file.read_text().splitlines() if line.strip()]

    b = tmp_path / "inprocess"
    shutil.copytree(TOY, b / "project")
    db = b / "toy.duckdb"
    con = open_duckdb(db)  # the engine's connection stays open during the build (ADR 0012)
    res = build(db, b / "target", project_dir=b / "project", profiles_dir=b / "project")
    assert res.success
    assert con.execute("SELECT count(*) FROM main.fct_position").fetchone()[0] == 3
    con.close()

    assert normalize(res.events) == normalize(from_subprocess)
    edges = column_edges(res.events)
    assert ("main.int_annual.annual_base", "main.fct_position.compa_ratio") in edges
    assert ("main.stg_lines.pay_basis_code", "main.int_annual.pay_basis_code") in edges
