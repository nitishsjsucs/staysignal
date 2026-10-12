"""Loading committed model artifacts (`models/<version>/model.json`, SPEC 9.6)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from staysignal.model import mnl
from staysignal.model.design import CAUSES, DesignSpec


@dataclass
class Model:
    version: str
    sha256: str
    spec: DesignSpec
    pk: mnl.Packing
    theta: np.ndarray
    cov: np.ndarray
    shocks: dict
    raw: dict

    @property
    def B(self) -> np.ndarray:
        return self.pk.unpack(self.theta)


def from_dict(d: dict) -> Model:
    des = d["design"]
    spec = DesignSpec(
        knots=des["knots"],
        columns=des["columns"],
        mean=des["mean"],
        scale=des["scale"],
        masks=des["masks"],
        penalized=des["penalized"],
    )
    pk = mnl.Packing(
        p=len(spec.columns), masks=[np.array(spec.masks[c]) for c in CAUSES], penalized=np.array(spec.penalized)
    )
    return Model(
        d["version"],
        d["artifact_sha256"],
        spec,
        pk,
        np.array(d["theta"], dtype=float),
        np.array(d["covariance"], dtype=float),
        d["shocks"],
        d,
    )


def load(path: Path) -> Model:
    return from_dict(json.loads(path.read_text(encoding="utf-8")))


def write(artifact: dict, models_dir: Path) -> Path:
    out = models_dir / artifact["version"] / "model.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(artifact, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    return out
