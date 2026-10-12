"""The deterministic mapping proposal (SPEC 13.4): generated from evidence, never by an LLM.

Evidence: the vendor pay-basis code dictionary (sources/schemas/payroll.schema.json) defines ANN as an annual amount,
and the rca_probe shows the entity's lines under that previously unseen code at about 12 times their band midpoints.
Output: the diff from payroll@1 to payroll@2 = {M: x 12, ANN: x 1, any other code: reject}; a test asserts it equals
sources/mappings/payroll.v2.yaml."""

from __future__ import annotations

import json
from pathlib import Path

import yaml


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "sources" / "schemas" / "payroll.schema.json").exists():
            return parent
    raise FileNotFoundError("sources/schemas/payroll.schema.json")


def vendor_dictionary() -> dict[str, dict]:
    schema = json.loads((repo_root() / "sources" / "schemas" / "payroll.schema.json").read_text(encoding="utf-8"))
    return schema["x-pay-basis-codes"]


def load_mapping(version: int) -> dict:
    return yaml.safe_load(
        (repo_root() / "sources" / "mappings" / f"payroll.v{version}.yaml").read_text(encoding="utf-8")
    )


def propose(active: dict, probes: list[dict]) -> dict:
    dictionary = vendor_dictionary()
    unseen = sorted({p["pay_basis_code"] for p in probes if p["pay_basis_code"] not in active["codes"]})
    codes = dict(active["codes"])
    evidence = []
    for code in unseen:
        entry = dictionary.get(code)
        if entry is None:
            continue
        codes[code] = {"multiplier": entry["annual_multiplier"], "meaning": entry["meaning"]}
        for p in probes:
            if p["pay_basis_code"] == code:
                evidence.append(
                    {
                        "entity": p["entity"],
                        "code": code,
                        "median_ratio_under_active_mapping": p["median_ratio"],
                        "n": p["n"],
                        "dictionary": entry["meaning"],
                    }
                )
    proposed = {"source": "payroll", "version": active["version"] + 1, "codes": codes, "unknown_codes": "reject"}
    diff = {
        "added": {c: codes[c] for c in unseen if c in codes},
        "unknown_codes": {"from": active["unknown_codes"], "to": "reject"},
    }
    return {"proposed": proposed, "diff": diff, "evidence": evidence}
