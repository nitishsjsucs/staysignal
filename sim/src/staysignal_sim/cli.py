"""`npm run lab:record` and `npm run lab:replay` (SPEC 15.3 to 15.6).

record: one session per proposal: three main replicates (seeds 1 to 3, 16 personas x 8 rounds) and the two controls
(facts removed and facts shuffled, 16 x 4, seed 1), the coding pass on each, then `analysis.json`. `--provider stub`
writes a labeled placeholder session (scripted text, no model); `--provider openai` is the Mac's 27B through
`scripts/llm.ts`, the only way real recordings are made; its responses are cached under var/lab/cache, so a rerun
after an interruption (the memory guard, a server error) resumes where it stopped, and `--fresh` records anew. Both
hygiene tiers scan the decompressed calls before a recording is committed (the pre-commit hook does this for every
staged file).

replay: rebuilds every replicate of a session from its actions with no model and checks each database hash against
its manifest; exits non-zero on any mismatch.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

from staysignal_sim.analysis import analyze
from staysignal_sim.client import CachedProvider, OpenAICompatibleProvider, RecordedProvider, StubProvider
from staysignal_sim.coding import code_run
from staysignal_sim.personas import load_cells, load_proposals, repo_root
from staysignal_sim.run import replay, run_replicate

PLAN = [
    ("main", "main", 1),
    ("main", "main", 2),
    ("main", "main", 3),
    ("facts_removed", "control", 1),
    ("facts_shuffled", "control", 1),
]

# The compact plan (2026-10-13) keeps the design's shape at rehearsal size: one main replicate and both negative
# controls, 8 personas x 4 rounds each. It exists for a 27B run in low-memory mode, where the full plan's roughly
# 900 calls per proposal would take about 5 hours; the session's manifest records which plan made it.
COMPACT_PLAN = [
    ("main", "rehearsal", 1),
    ("facts_removed", "rehearsal", 1),
    ("facts_shuffled", "rehearsal", 1),
]


def provider_for(name: str, run_dir: Path | None = None):
    if name == "stub":
        return StubProvider()
    if name == "recorded":
        return RecordedProvider(run_dir / "calls.jsonl.gz")  # type: ignore[operator]
    if name == "openai":
        return OpenAICompatibleProvider()
    raise ValueError(f"unknown provider {name}")


def cache_path(proposal_id: str, provider: str, rehearsal: bool = False) -> Path:
    """The live provider's request cache (var/, never committed): a rerun after an interruption resumes from it."""
    suffix = "-rehearsal" if rehearsal else ""
    return repo_root() / "var" / "lab" / "cache" / f"{proposal_id}-{provider}{suffix}.jsonl"


async def record(
    proposal_id: str, provider: str, out: Path, rehearsal: bool = False, fresh: bool = False, compact: bool = False
) -> dict:
    proposal = load_proposals()[proposal_id]
    cells = load_cells()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    plan = [("main", "rehearsal", 1)] if rehearsal else COMPACT_PLAN if compact else PLAN
    live = provider_for(provider)
    if provider == "openai":
        cache = cache_path(proposal_id, provider, rehearsal or compact)
        if fresh and cache.exists():
            cache.unlink()
        live = CachedProvider(live, cache)
    for card_variant, config, seed in plan:
        run_dir = out / f"{card_variant}-s{seed}"
        await run_replicate(proposal, cells, card_variant, seed, config, live, run_dir)
        await code_run(run_dir, live)
        print(json.dumps({"replicate": run_dir.name, "cache_hits": getattr(live, "hits", 0)}), flush=True)
    doc = analyze(out)
    (out / "analysis.json").write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    return doc


async def verify(session: Path) -> list[dict]:
    out = []
    for d in sorted(p for p in session.iterdir() if (p / "manifest.json").exists()):
        m = json.loads((d / "manifest.json").read_text())
        with tempfile.TemporaryDirectory() as tmp:
            h = await replay(d, Path(tmp))
        out.append({"run": d.name, "equal": h == m["db_sha256"], "db_sha256": h})
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="staysignal-sim")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("record")
    r.add_argument("--proposal", required=True)
    r.add_argument("--provider", default="stub", choices=["stub", "openai"])
    r.add_argument("--rehearsal", action="store_true", help="8 personas x 4 rounds, one replicate")
    r.add_argument(
        "--compact", action="store_true", help="one main replicate and both controls, 8 personas x 4 rounds each"
    )
    r.add_argument("--out", default=None)
    r.add_argument("--fresh", action="store_true", help="discard the live provider's request cache first")
    v = sub.add_parser("replay")
    v.add_argument("--session", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "record":
        out = Path(args.out) if args.out else repo_root() / "lab" / "recordings" / f"{args.proposal}-{args.provider}"
        doc = asyncio.run(record(args.proposal, args.provider, out, args.rehearsal, args.fresh, args.compact))
        print(
            json.dumps(
                {
                    "written": str(out),
                    "placeholder": doc["placeholder"],
                    "themes": [x["theme"] for x in doc["themes"]["shares"]][:4],
                }
            )
        )
        return 0
    res = asyncio.run(verify(Path(args.session)))
    print(json.dumps(res, indent=1))
    return 0 if res and all(x["equal"] for x in res) else 1


if __name__ == "__main__":
    sys.exit(main())
