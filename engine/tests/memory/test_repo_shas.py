"""C33: memory commits are reproducible. The agent commits as itself with dates from the synthetic clock, and the
machine's git configuration (signing, hooks, identity) cannot change a SHA. The test pins SHA-256 digests of the commit
SHAs rather than the SHAs themselves, because no committed file may hold a git SHA (ADR 0017)."""

import hashlib
from datetime import UTC, datetime

from staysignal.memory.anchor import anchor
from staysignal.memory.repo import AUTHOR_EMAIL, AUTHOR_NAME, MemoryRepo

from .conftest import SEED, SEEDED_AT

SEED_DIGEST = "82a071e18e904078"


def digest(sha: str) -> str:
    return hashlib.sha256(sha.encode()).hexdigest()[:16]


def test_the_seed_commit_is_reproducible(repo, tmp_path):
    assert digest(repo.head()) == SEED_DIGEST
    again = MemoryRepo(tmp_path / "again")
    assert again.init(SEED, SEEDED_AT) == repo.head()
    log = repo.log()
    assert [c.message for c in log] == ["memory: seed"]
    assert (
        repo.git("log", "-1", "--format=%an <%ae> %cn <%ce>").strip()
        == f"{AUTHOR_NAME} <{AUTHOR_EMAIL}> {AUTHOR_NAME} <{AUTHOR_EMAIL}>"
    )


def test_the_machine_configuration_cannot_change_a_sha(tmp_path, monkeypatch):
    hostile = tmp_path / "gitconfig"
    hostile.write_text(
        "[user]\n\tname = Someone Else\n\temail = x@y.example\n[commit]\n\tgpgsign = true\n[core]\n\thooksPath = /nonexistent\n"
    )
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(hostile))
    monkeypatch.setenv("GIT_AUTHOR_NAME", "Someone Else")
    monkeypatch.setenv("GIT_COMMITTER_DATE", "2030-01-01T00:00:00+0000")
    r = MemoryRepo(tmp_path / "m")
    assert digest(r.init(SEED, SEEDED_AT)) == SEED_DIGEST


def test_a_note_and_an_anchor_commit_deterministically(repo, tmp_path):
    when = datetime(2026, 10, 5, 14, 20, tzinfo=UTC)
    files = {
        "timeline/daily/2026-10-05.md": "---\naliases: []\nid: TL-2026-10-05\nlinks: []\ntype: timeline_daily\n---\n# Timeline 2026-10-05\n\n- 2026-10-05: Run R-2026-10-01#2 held: checks C01, C02 and C03 failed on the payroll arrival.\n"
    }
    a = repo.write(files, "memory: routine source_arrival_refresh", when)
    b_repo = MemoryRepo(tmp_path / "b")
    b_repo.init(SEED, SEEDED_AT)
    assert b_repo.write(files, "memory: routine source_arrival_refresh", when) == a
    assert repo.write(files, "memory: nothing new", when) is None  # no change, no commit
    heads = {"action_log": {"seq": 7, "hash": "ab" * 32}, "approval_audit": {"seq": 2, "hash": "cd" * 32}}
    sha = anchor(repo, datetime(2026, 10, 5).date(), heads, when)
    assert sha and "anchors/2026-10-05.md" in repo.files()
    assert "action_log head at sequence 7" in repo.read("anchors/2026-10-05.md")


def test_only_memory_files_inside_the_repository_can_be_written(repo):
    import pytest

    from staysignal.memory.repo import MemoryRepoError

    for bad in ("../outside.md", "notes.txt", "/etc/passwd.md"):
        with pytest.raises(MemoryRepoError):
            repo.write({bad: "x"}, "memory: bad", SEEDED_AT)
