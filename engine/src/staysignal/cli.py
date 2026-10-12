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
