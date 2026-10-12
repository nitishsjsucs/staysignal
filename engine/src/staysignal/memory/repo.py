"""Git-backed Markdown memory (SPEC 14.10): a real git repository under `var/memory`, driven by the git CLI.

Only the agent principal writes, as `StaySignal Agent <agent@larkspur.example>`, with author and committer dates from
the synthetic clock, so commit SHAs are reproducible: every call runs git with the global and system configuration
ignored (no signing, hooks, templates or line-ending conversion from the machine), a fixed locale and time zone, and
an explicit `-c` set. Layout: `teams/<org>/<group>.md`, `investigations/INV-*.md`, `decisions/DEC-*.md`,
`timeline/{daily,weekly,monthly}/*.md`, `anchors/YYYY-MM-DD.md`, `index/aliases.yml`. Content is cohort-level at
group level and above, and numbers are cited by result ID. The SHAs live only here and in API responses, never in
committed files (ADR 0017). Synthetic company only.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

AUTHOR_NAME = "StaySignal Agent"
AUTHOR_EMAIL = "agent@larkspur.example"
GIT_OPTS = [
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.autocrlf=false",
    "-c", "core.fileMode=true",
    "-c", "core.hooksPath=/dev/null",
    "-c", "init.templateDir=",
    "-c", "i18n.commitEncoding=UTF-8",
]  # fmt: skip


class MemoryRepoError(RuntimeError):
    pass


def git_date(when: datetime) -> str:
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S+0000")


@dataclass
class Commit:
    sha: str
    date: str
    message: str
    files: list[str]


class MemoryRepo:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)

    def _env(self, when: datetime | None) -> dict[str, str]:
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": str(self.path),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
            "TZ": "UTC",
            "GIT_AUTHOR_NAME": AUTHOR_NAME,
            "GIT_AUTHOR_EMAIL": AUTHOR_EMAIL,
            "GIT_COMMITTER_NAME": AUTHOR_NAME,
            "GIT_COMMITTER_EMAIL": AUTHOR_EMAIL,
        }
        if when is not None:
            env["GIT_AUTHOR_DATE"] = env["GIT_COMMITTER_DATE"] = git_date(when)
        return env

    def git(self, *args: str, when: datetime | None = None, check: bool = True) -> str:
        res = subprocess.run(
            ["git", *GIT_OPTS, *args], cwd=self.path, env=self._env(when), capture_output=True, text=True
        )
        if check and res.returncode != 0:
            raise MemoryRepoError(f"git {' '.join(args)}: {res.stderr.strip()}")
        return res.stdout

    @property
    def exists(self) -> bool:
        return (self.path / ".git").is_dir()

    def init(self, seed: Path, when: datetime, message: str = "memory: seed") -> str:
        """Creates the repository from a seed tree with one commit (removes any existing repository first)."""
        if self.path.exists():
            shutil.rmtree(self.path)
        self.path.mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        for src in sorted(p for p in seed.rglob("*") if p.is_file()):
            dst = self.path / src.relative_to(seed)
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
        sha = self.commit(message, when)
        if sha is None:
            raise MemoryRepoError("the seed is empty")
        return sha

    def write(self, files: dict[str, str], message: str, when: datetime, remove: list[str] | None = None) -> str | None:
        """Writes Markdown files (and removes others) in one commit; returns the SHA, or None if nothing changed."""
        for rel, text in files.items():
            p = self._safe(rel)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
        for rel in remove or []:
            self._safe(rel).unlink(missing_ok=True)
        return self.commit(message, when)

    def commit(self, message: str, when: datetime) -> str | None:
        self.git("add", "-A")
        if not self.git("status", "--porcelain"):
            return None
        self.git("commit", "-q", "-m", message, when=when)
        return self.head()

    def _safe(self, rel: str) -> Path:
        p = (self.path / rel).resolve()
        if self.path.resolve() not in p.parents or not rel.endswith((".md", ".yml")):
            raise MemoryRepoError(f"not a memory file path: {rel}")
        return p

    def head(self) -> str:
        return self.git("rev-parse", "HEAD").strip()

    def files(self) -> list[str]:
        return sorted(self.git("ls-files").split())

    def read(self, rel: str) -> str:
        return self._safe(rel).read_text(encoding="utf-8")

    def last_commit(self, rel: str) -> tuple[str, str]:
        out = self.git("log", "-1", "--format=%H %cI", "--", rel).strip()
        sha, _, date = out.partition(" ")
        return sha, date

    def log(self, limit: int = 50) -> list[Commit]:
        out = self.git("log", f"-{limit}", "--no-renames", "--name-only", "--format=%x1e%H%x1f%cI%x1f%s")
        commits = []
        for block in out.split("\x1e")[1:]:
            head, _, rest = block.partition("\n")
            sha, date, message = head.split("\x1f")
            commits.append(Commit(sha, date, message, [f for f in rest.split("\n") if f]))
        return commits


__all__ = ["AUTHOR_EMAIL", "AUTHOR_NAME", "Commit", "MemoryRepoError", "MemoryRepo", "git_date"]
