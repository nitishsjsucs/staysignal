"""Import-time stand-ins for OASIS's heavy dependencies (SPEC 15.1), installed before `import oasis`.

The Lab uses OASIS's Reddit platform with its hot-score recommender, which needs none of torch, transformers,
sentence-transformers, scikit-learn's TF-IDF, neo4j or igraph. Each stub makes the import succeed and raises if
OASIS ever calls into it, so a code path that needs the real library fails loudly instead of quietly computing
something else; `tests/test_stubs_guard.py` checks that the Lab's paths never touch them.
"""

from __future__ import annotations

import sys
import types


class StubUsed(RuntimeError):
    pass


def _refuse(name: str):
    def call(*_args, **_kwargs):
        raise StubUsed(f"{name} is a stub: the Lab's OASIS paths must not call it")

    return call


class _Refusing:
    def __init__(self, name: str) -> None:
        self._name = name

    def __getattr__(self, attr: str):
        raise StubUsed(f"{self._name}.{attr} is a stub: the Lab's OASIS paths must not call it")

    def __call__(self, *_args, **_kwargs):
        raise StubUsed(f"{self._name} is a stub: the Lab's OASIS paths must not call it")


class _TfidfVectorizer:
    """Constructible at import (OASIS builds one at module level); any use raises."""

    def __init__(self, *_args, **_kwargs) -> None:
        pass

    def __getattr__(self, attr: str):
        raise StubUsed(f"TfidfVectorizer.{attr} is a stub")


def _module(name: str, **attrs) -> types.ModuleType:
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    m.__stub__ = True  # type: ignore[attr-defined]
    return m


def install() -> None:
    """Idempotent: registers the stub modules unless the real ones are already importable."""
    if getattr(sys.modules.get("torch"), "__stub__", False):
        return
    from staysignal_sim import igraph_shim

    torch = _module(
        "torch",
        no_grad=lambda *a, **k: lambda f: f,
        device=lambda name: name,
        cuda=_module("torch.cuda", is_available=lambda: False),
        Tensor=object,
    )
    for name in ("matmul", "norm", "rand", "topk", "stack", "tensor", "load", "from_numpy"):
        setattr(torch, name, _refuse(f"torch.{name}"))
    sys.modules["torch"] = torch
    sys.modules["torch.cuda"] = torch.cuda
    sys.modules["transformers"] = _module(
        "transformers",
        AutoModel=_Refusing("transformers.AutoModel"),
        AutoTokenizer=_Refusing("transformers.AutoTokenizer"),
    )
    sys.modules["sentence_transformers"] = _module(
        "sentence_transformers", SentenceTransformer=_Refusing("sentence_transformers.SentenceTransformer")
    )
    sklearn = _module("sklearn")
    fe = _module("sklearn.feature_extraction")
    fe_text = _module("sklearn.feature_extraction.text", TfidfVectorizer=_TfidfVectorizer)
    metrics = _module("sklearn.metrics")
    pairwise = _module(
        "sklearn.metrics.pairwise", cosine_similarity=_refuse("sklearn.metrics.pairwise.cosine_similarity")
    )
    sys.modules.update(
        {
            "sklearn": sklearn,
            "sklearn.feature_extraction": fe,
            "sklearn.feature_extraction.text": fe_text,
            "sklearn.metrics": metrics,
            "sklearn.metrics.pairwise": pairwise,
        }
    )
    sys.modules["neo4j"] = _module("neo4j", GraphDatabase=_Refusing("neo4j.GraphDatabase"))
    sys.modules["igraph"] = igraph_shim


install()
