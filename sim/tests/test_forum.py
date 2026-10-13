"""The forum is deterministic (SPEC 15.4): time is the round, so the same actions give a byte-identical database; and
the igraph shim behaves like igraph on the calls OASIS makes."""

from staysignal_sim.forum import START, Forum, db_hash
from staysignal_sim.igraph_shim import Graph


async def scripted(path):
    f = await Forum.open(path, ["P01", "P02"])
    await f.apply(0, "create_post", {"content": "What does the June window change?"})
    await f.end_round()
    await f.apply(1, "create_comment", {"post_id": 1, "content": "Timing for IC3s."})
    await f.apply(1, "like_post", {"post_id": 1})
    await f.end_round()
    await f.close()


def test_the_same_actions_give_the_same_database(tmp_path, run):
    run(scripted(tmp_path / "a.db"))
    run(scripted(tmp_path / "b.db"))
    assert db_hash(tmp_path / "a.db") == db_hash(tmp_path / "b.db")


def test_time_is_the_round_not_the_wall_clock(tmp_path, run):
    import sqlite3

    run(scripted(tmp_path / "a.db"))
    con = sqlite3.connect(tmp_path / "a.db")
    post = con.execute("SELECT created_at FROM post").fetchone()[0]
    comment = con.execute("SELECT created_at FROM comment").fetchone()[0]
    assert post == START.strftime("%Y-%m-%d %H:%M:%S") and comment == "2026-10-05 10:00:00"


def test_the_igraph_shim():
    g = Graph(directed=True)
    for i in range(3):
        g.add_vertex(i)
    g.add_edge(0, 1)
    g.add_edge(1, 2)
    assert g.are_connected(0, 1) and not g.are_connected(1, 0)
    g.delete_edges([(0, 1)])
    assert g.ecount() == 1
    g.delete_vertices(0)
    assert g.vcount() == 2 and [(e.source, e.target) for e in g.es] == [(0, 1)]
    assert [v.index for v in g.vs] == [0, 1]
