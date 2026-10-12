"""C33: search answers "what did we decide last time?" from the memory, with path, commit and date, and uses aliases."""

from staysignal.memory.search import search, terms


def test_what_did_we_decide_about_fixed_term_employees(repo):
    hits = search(repo, "What did we decide last time about fixed-term employees?")
    assert hits[0].path == "decisions/DEC-2026-09-20-01.md"
    assert "voluntary_departures@2" in hits[0].snippet and hits[0].snippet.startswith("- 2026-09-20")
    assert len(hits[0].commit) == 40 and hits[0].date.startswith("2026-10-01")
    assert all(not h.path.startswith("index/") for h in hits)


def test_aliases_expand_the_query(repo):
    # "performance ratings" maps to the decision's ID through index/aliases.yml
    hits = search(repo, "Do we use performance ratings?")
    assert hits and hits[0].path == "decisions/DEC-2026-03-10-01.md"
    hits = search(repo, "why are team level values hidden from partners")
    assert hits[0].path == "decisions/DEC-2026-06-02-01.md"


def test_no_terms_or_no_hits_return_nothing(repo):
    assert terms("what did we") == []
    assert search(repo, "what did we") == []
    assert search(repo, "zebra quantum") == []
