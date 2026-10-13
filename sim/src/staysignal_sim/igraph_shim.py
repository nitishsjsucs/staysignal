"""An in-repo directed graph with the subset of python-igraph that OASIS's `AgentGraph` calls (SPEC 15.1), because
python-igraph is GPL-2.0-or-later. Vertices are addressed by index, as in igraph, and deleting a vertex renumbers the
later ones and drops its edges. MIT, like the rest of the repository."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Vertex:
    index: int
    name: object


@dataclass(frozen=True)
class Edge:
    source: int
    target: int


class Graph:
    def __init__(self, directed: bool = True) -> None:
        if not directed:
            raise NotImplementedError("the shim is directed only, as OASIS uses it")
        self._names: list[object] = []
        self._edges: list[tuple[int, int]] = []

    def add_vertex(self, name: object = None) -> None:
        self._names.append(name)

    def _index(self, v: object) -> int:
        if isinstance(v, int) and 0 <= v < len(self._names):
            return v
        raise IndexError(f"no vertex {v!r}")

    def add_edge(self, source: object, target: object) -> None:
        self._edges.append((self._index(source), self._index(target)))

    def are_connected(self, source: object, target: object) -> bool:
        return (self._index(source), self._index(target)) in self._edges

    def delete_edges(self, pairs: list[tuple[int, int]]) -> None:
        drop = {(self._index(a), self._index(b)) for a, b in pairs}
        self._edges = [e for e in self._edges if e not in drop]

    def delete_vertices(self, v: object) -> None:
        idx = sorted({self._index(x) for x in (v if isinstance(v, list | tuple) else [v])}, reverse=True)
        for i in idx:
            del self._names[i]
            self._edges = [(a - (a > i), b - (b > i)) for a, b in self._edges if a != i and b != i]

    def vcount(self) -> int:
        return len(self._names)

    def ecount(self) -> int:
        return len(self._edges)

    @property
    def vs(self) -> list[Vertex]:
        return [Vertex(i, n) for i, n in enumerate(self._names)]

    @property
    def es(self) -> list[Edge]:
        return [Edge(a, b) for a, b in self._edges]

    def layout(self, *_args, **_kwargs):
        raise NotImplementedError("plotting is not used by the Lab")


def plot(*_args, **_kwargs):
    raise NotImplementedError("plotting is not used by the Lab")
