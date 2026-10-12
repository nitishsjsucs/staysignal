"""Replay (SPEC 13.5): rebuild a run from the content-addressed landed files in a fresh process state and compare its
business-result hash. Until the dbt warehouse lands (M2) the "fresh warehouse" is a fresh load of the landed files
into new in-memory structures; nothing is shared with the live state. A replay never moves the published pointer."""

from __future__ import annotations

import time
from datetime import date, datetime
from pathlib import Path

from staysignal.clock import parse_ts
from staysignal.forecast.run import RunInputs, make_run
from staysignal.ingest.landing import Sources, add_file
from staysignal.model import artifact as artifact_io


def load_files(paths: list[Path]) -> Sources:
    src = Sources()
    for p in sorted(paths, key=lambda x: x.name):
        add_file(src, p)
    return src


def replay(brief: dict, landed: list[Path], models_dir: Path, force_mapping: str | None = None) -> dict:
    t0 = time.perf_counter()
    src = load_files(landed)
    model = artifact_io.load(models_dir / brief["model"] / "model.json")
    mapping = force_mapping or brief["mapping"]
    run = make_run(
        src,
        RunInputs(
            brief["run_id"],
            date.fromisoformat(brief["cutoff"]),
            parse_ts(brief["vintage"]),
            model,
            brief["metric_def"],
            mapping,
        ),
    )
    return {
        "replay_hash": run["result_hash"],
        "equal": run["result_hash"] == brief["result_hash"],
        "duration_ms": int((time.perf_counter() - t0) * 1000),
        "mapping": mapping,
        "files": len(landed),
    }


__all__ = ["datetime", "replay"]
