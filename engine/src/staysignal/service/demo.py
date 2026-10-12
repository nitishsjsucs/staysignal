"""`staysignal demo build`: the canonical demo state and the committed API fixtures (SPEC 22.4).

Steps: load the landed canonical extracts (the September 2026 payroll stays held back), train or load the committed
model artifacts m2026.08 and m2026.09, score the two published runs R-2026-09-01#1 and R-2026-10-01#1, and export
the published layer as API fixtures.
"""

from __future__ import annotations

import time
from datetime import UTC, date, datetime
from pathlib import Path

from staysignal.fixtures.export_api import export_run, write_json
from staysignal.forecast.run import RunInputs, make_run, population
from staysignal.ingest.landing import load_world_sources
from staysignal.model import artifact as artifact_io
from staysignal.model.train import train

START = date(2023, 4, 1)
MODELS = {
    "m2026.08": (date(2026, 9, 1), datetime(2026, 9, 1, 6, tzinfo=UTC)),
    "m2026.09": (date(2026, 10, 1), datetime(2026, 10, 1, 6, tzinfo=UTC)),
}
PUBLISHED = [
    (
        "R-2026-09-01#1",
        date(2026, 9, 1),
        datetime(2026, 9, 1, 6, tzinfo=UTC),
        "m2026.08",
        "voluntary_departures@1",
        "payroll@1",
    ),
    (
        "R-2026-10-01#1",
        date(2026, 10, 1),
        datetime(2026, 10, 1, 6, tzinfo=UTC),
        "m2026.09",
        "voluntary_departures@2",
        "payroll@1",
    ),
]


def log(msg: str) -> None:
    print(f"[demo build] {msg}", flush=True)


def ensure_models(src, models_dir: Path, retrain: bool) -> dict[str, artifact_io.Model]:
    out = {}
    for version, (T, vintage) in MODELS.items():
        path = models_dir / version / "model.json"
        if retrain or not path.exists():
            t0 = time.perf_counter()
            art = train(src, START, T, vintage, version)
            artifact_io.write(art, models_dir)
            log(f"trained {version} in {time.perf_counter() - t0:.1f} s ({art['fit']['rows']} rows)")
        out[version] = artifact_io.load(path)
    return out


def build(world_dir: Path, models_dir: Path, out_dir: Path, retrain: bool = False) -> dict:
    src = load_world_sources(world_dir)
    models = ensure_models(src, models_dir, retrain)
    briefs = []
    prev_rows = None
    for run_id, cutoff, vintage, mv, metric_def, mapping in PUBLISHED:
        t0 = time.perf_counter()
        run = make_run(src, RunInputs(run_id, cutoff, vintage, models[mv], metric_def, mapping), prev_rows)
        briefs.append(export_run(out_dir, run, "published", 1))
        log(
            f"{run_id}: population {run['population']}, result hash {run['result_hash'][:16]}, {time.perf_counter() - t0:.1f} s"
        )
        prev_rows = population(src, cutoff, vintage, metric_def, mapping)
    briefs[0]["status"] = "superseded"
    write_json(out_dir / "runs.json", {"label": "synthetic", "published": briefs[-1]["run_id"], "runs": briefs})
    return {"runs": briefs}
