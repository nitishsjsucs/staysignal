# Build progress

Builder log for the commit plan in SPEC.md section 24. Updated in every commit.

## Demo date and schedule variant

- Demo date: **not known yet** (1 to 2 weeks from 2026-10-11; the operator has not given a date to the builders).
- Active variant: **7-day** (SPEC 24: the 7-day variant applies while the date is unknown). Gate B (demo-ready on real data) is due at the end of day 5, 2026-10-16.
- Freeze: 2 days before the demo once the date is known; if the demo is on 2026-10-18, the freeze is Gate B itself.
- Day 1 is 2026-10-12.

## Position

M0, commit 3 of 7 (`docs: ADRs 0001 to 0007 and 0012`).

## Done

1. `chore: scaffold`: `git init -b main`, repository identity, MIT license, NOTICE, `.gitignore`, `.editorconfig`, `.nvmrc` (24), `.python-version` (3.12), a first README.
2. `docs: README with status table, mermaid and local setup; CONTEXT.md; PROGRESS.md`.
3. `docs: ADRs 0001 to 0007 and 0012` under `docs/adr/`.

## Next

M0: pinned Node toolchain with generated Worker types; engine uv project and lock; prose and hygiene gates with the pre-commit hook and CI; 27B measurement on agent-shaped prompts.

## Check status

No code yet. `check:prose` does not exist yet; the Markdown files were checked by hand for em and en dashes (none).

## Deviations from SPEC.md

- `origin` is set to `https://github.com/nitishsjsucs/staysignal.git` because the builder task asked for it; SPEC 22.5 says to add no remote. Nothing is ever pushed from this repository; the operator's publisher owns publishing.
