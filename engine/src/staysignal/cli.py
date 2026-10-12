"""Command line entry point: `uv run --project engine staysignal ...`."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from staysignal import __version__


def cmd_world_generate(args: argparse.Namespace) -> int:
    from staysignal.world.emit import generate
    from staysignal.world.spec import PROFILES

    profile = PROFILES[args.profile]
    if args.seed is not None and args.seed != profile.seed:
        from dataclasses import replace

        profile = replace(profile, seed=args.seed)
    t0 = time.perf_counter()
    manifest = generate(profile, Path(args.out))
    dt = time.perf_counter() - t0
    print(
        json.dumps(
            {
                "profile": profile.name,
                "seed": profile.seed,
                "world_sha256": manifest["world_sha256"],
                "seconds": round(dt, 2),
                "realized": manifest["realized"],
            },
            indent=2,
        )
    )
    return 0


def cmd_world_verify(args: argparse.Namespace) -> int:
    """Compares a generated world's manifest with the committed pins (SPEC 6: macOS-made pins checked on Linux)."""
    from staysignal.world.pins import compare

    problems = compare(
        json.loads(Path(args.manifest).read_text()), json.loads((Path(args.dir) / "manifest.json").read_text())
    )
    for p in problems:
        print(p)
    print(f"world verify: {'ok' if not problems else f'{len(problems)} difference(s)'} against {args.manifest}")
    return 0 if not problems else 1


def cmd_eval_oracle_coverage(args: argparse.Namespace) -> int:
    import datetime as dt

    from staysignal.evaluate.oracle_coverage import coverage
    from staysignal.world.spec import PROFILES

    report = coverage(PROFILES[args.profile], n_futures=args.futures, workers=args.workers)
    report = {
        "command": f"uv run --project engine staysignal eval oracle-coverage --futures {args.futures}",
        "date": dt.date.today().isoformat(),
        **report,
    }
    out = Path(args.out or f"results/oracle-coverage-{report['date']}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1, sort_keys=False) + "\n")
    print(json.dumps({k: v for k, v in report.items() if k != "detail"}, indent=2))
    return 0 if report["within_band"] else 1


def cmd_demo_build(args: argparse.Namespace) -> int:
    from staysignal.service.demo import build

    build(Path(args.world), Path(args.models), Path(args.out), retrain=args.retrain)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="staysignal", description="StaySignal engine (synthetic data only)")
    parser.add_argument("--version", action="version", version=f"staysignal {__version__}")
    sub = parser.add_subparsers(dest="command")
    world = sub.add_parser("world", help="synthetic world")
    wsub = world.add_subparsers(dest="world_command", required=True)
    gen = wsub.add_parser("generate", help="generate a world profile")
    gen.add_argument("--profile", default="canonical", choices=["canonical", "small"])
    gen.add_argument("--seed", type=int, default=None)
    gen.add_argument("--out", default="var/world")
    gen.set_defaults(func=cmd_world_generate)
    ver = wsub.add_parser("verify", help="compare a generated world with the committed pins")
    ver.add_argument("--manifest", default="data/world/manifest.json")
    ver.add_argument("--dir", default="var/world")
    ver.set_defaults(func=cmd_world_verify)
    ev = sub.add_parser("eval", help="recorded evaluations (synthetic world)")
    esub = ev.add_subparsers(dest="eval_command", required=True)
    oc = esub.add_parser("oracle-coverage", help="C5: oracle 90% intervals against realized counts")
    oc.add_argument("--profile", default="canonical", choices=["canonical", "small"])
    oc.add_argument("--futures", type=int, default=2000)
    oc.add_argument("--workers", type=int, default=None)
    oc.add_argument("--out", default=None)
    oc.set_defaults(func=cmd_eval_oracle_coverage)
    demo = sub.add_parser("demo", help="demo state")
    dsub = demo.add_subparsers(dest="demo_command", required=True)
    db = dsub.add_parser("build", help="train or load models, score the published runs, export API fixtures")
    db.add_argument("--world", default="var/world")
    db.add_argument("--models", default="models")
    db.add_argument("--out", default="test/fixtures/api")
    db.add_argument("--retrain", action="store_true")
    db.set_defaults(func=cmd_demo_build)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    return int(args.func(args))


if __name__ == "__main__":
    sys.exit(main())
