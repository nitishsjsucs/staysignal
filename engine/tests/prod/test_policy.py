"""Purpose-scoped data access (SPEC 17.2): the compiled policy and the grant plan are current with policy/access.yaml,
and the compiler refuses a policy that breaks the shared-project rules."""

import copy

import pytest
import yaml

from staysignal.prod.policy import SOURCE, PolicyError, build, compile_policy


def test_generated_files_are_current():
    assert build(check=True) == []


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda p: p["datasets"].update({"people_raw": "x"}), "lacks the prefix"),
        (lambda p: p["identities"].update({"worker2": {"reads": [], "max_bytes_billed": 1}}), "lacks the prefix"),
        (
            lambda p: p["identities"]["staysignal-worker"]["reads"].append("staysignal_restricted"),
            "Worker must read exactly",
        ),
        (lambda p: p["identities"]["staysignal-worker"].update({"purposes": ["forecasting"]}), "Worker"),
        (lambda p: p["identities"]["staysignal-runner"].pop("max_bytes_billed"), "max_bytes_billed"),
        (lambda p: p["job_labels"].update({"app": "other"}), "must name the app"),
        (lambda p: p["purposes"]["lab"]["reads"].append("bigquery_public"), "unknown dataset"),
    ],
)
def test_the_compiler_refuses_rule_breaks(change, message):
    src = copy.deepcopy(yaml.safe_load(SOURCE.read_text()))
    change(src)
    with pytest.raises(PolicyError, match=message):
        compile_policy(src)
