"""`npm run lab:record` and `npm run lab:replay` (SPEC 15.3 to 15.6).

record: one session per proposal: three main replicates (seeds 1 to 3, 16 personas x 8 rounds) and the two controls
(facts removed and facts shuffled, 16 x 4, seed 1), the coding pass on each, then `analysis.json`. `--provider stub`
writes a labeled placeholder session (scripted text, no model); `--provider openai` is the Mac's 27B through
`scripts/llm.ts`, the only way real recordings are made. Both hygiene tiers scan the decompressed calls before a
recording is committed (the pre-commit hook does this for every staged file).

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
from staysignal_sim.client import OpenAICompatibleProvider, RecordedProvider, StubProvider
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


def provider_for(name: str, run_dir: Path | None = None):
    if name == "stub":
        return StubProvider()
    if name == "recorded":
        return RecordedProvider(run_dir / "calls.jsonl.gz")  # type: ignore[operator]
    if name == "openai":
        return OpenAICompatibleProvider()
    raise ValueError(f"unknown provider {name}")


async def record(proposal_id: str, provider: str, out: Path, rehearsal: bool = False) -> dict:
    proposal = load_proposals()[proposal_id]
    cells = load_cells()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    plan = [("main", "rehearsal", 1)] if rehearsal else PLAN
    for card_variant, config, seed in plan:
        run_dir = out / f"{card_variant}-s{seed}"
        await run_replicate(proposal, cells, card_variant, seed, config, provider_for(provider), run_dir)
        await code_run(run_dir, provider_for(provider))
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
    r.add_argument("--out", default=None)
    v = sub.add_parser("replay")
    v.add_argument("--session", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "record":
        out = Path(args.out) if args.out else repo_root() / "lab" / "recordings" / f"{args.proposal}-{args.provider}"
        doc = asyncio.run(record(args.proposal, args.provider, out, args.rehearsal))
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
