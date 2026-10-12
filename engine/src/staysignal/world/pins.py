"""SHA-256 pins of the canonical world (SPEC 6, C1). Pattern from PeopleLake pipeline/src/peoplelake/generator/pins.py
(MIT), adapted for StaySignal: the pins are the committed `data/world/manifest.json` rather than constants, and the
comparison names every file, row count and realized count that moved.

The pins are made on macOS and checked on ubuntu-latest by CI (`staysignal world verify`), so a one-ulp libm
difference or a dependency change that alters any emitted byte fails loudly. After an intentional generator change,
regenerate with `staysignal world generate --profile canonical` and copy `var/world/manifest.json` over the pins.
"""

from __future__ import annotations

PINNED_KEYS = ("profile", "seed", "generator_version", "hazard_intercepts", "knobs", "world_sha256")


def compare(pinned: dict, generated: dict) -> list[str]:
    """Differences between the committed pins and a freshly generated manifest; empty when they match."""
    out: list[str] = []
    for key in PINNED_KEYS:
        if pinned.get(key) != generated.get(key):
            out.append(f"{key}: pinned {pinned.get(key)!r}, generated {generated.get(key)!r}")
    pf, gf = pinned.get("files", {}), generated.get("files", {})
    for name in sorted(set(pf) | set(gf)):
        a, b = pf.get(name), gf.get(name)
        if a is None or b is None:
            out.append(f"files/{name}: {'missing from the generated world' if b is None else 'not pinned'}")
        elif a != b:
            out.append(
                f"files/{name}: pinned {a['rows']} rows {a['sha256'][:16]}, generated {b['rows']} rows {b['sha256'][:16]}"
            )
    if pinned.get("realized") != generated.get("realized"):
        pr, gr = pinned.get("realized", {}), generated.get("realized", {})
        for key in sorted(set(pr) | set(gr)):
            if pr.get(key) != gr.get(key):
                out.append(f"realized/{key}: pinned {pr.get(key)!r}, generated {gr.get(key)!r}")
    return out


__all__ = ["PINNED_KEYS", "compare"]
