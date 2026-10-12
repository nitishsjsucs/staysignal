# Build progress

Builder log for the commit plan in SPEC.md section 24. Updated in every commit.

## Demo date and schedule variant

- Demo date: **not known yet** (1 to 2 weeks from 2026-10-11; the operator has not given a date to the builders).
- Active variant: **7-day** (SPEC 24: the 7-day variant applies while the date is unknown). Gate B (demo-ready on real data) is due at the end of day 5, 2026-10-16.
- Freeze: 2 days before the demo once the date is known; if the demo is on 2026-10-18, the freeze is Gate B itself.
- Day 1 is 2026-10-12.

## Position

M0, commit 6 of 7 (`test: prose and public hygiene checks, pre-commit hook with the private tier, CI node and engine jobs`).

## Done

1. `chore: scaffold`: `git init -b main`, repository identity, MIT license, NOTICE, `.gitignore`, `.editorconfig`, `.nvmrc` (24), `.python-version` (3.12), a first README.
2. `docs: README with status table, mermaid and local setup; CONTEXT.md; PROGRESS.md`.
3. `docs: ADRs 0001 to 0007 and 0012` under `docs/adr/`.
4. `chore: pinned package.json, ...`: 339 npm packages (518 MB) at the SPEC 25 pins (d3-scale 4.0.2 and d3-shape 3.2.0 confirmed with `npm view`; `@types/d3-scale` 4.0.9, `@types/d3-shape` 3.2.0, `@types/node` 24.19.1 added); `tsconfig.{worker,web,node}.json` (strict, `noUncheckedIndexedAccess`, ES2021 target for TC39 decorators); `vite.config.ts` with `agents()`, `react()`, `cloudflare()`; `vitest.config.ts` with projects `worker` (`@cloudflare/vitest-plugin`), `node`, `web` (happy-dom); `wrangler.jsonc` (vars only, ports 8795 and 9245); generated `worker-configuration.d.ts`; a health-only Worker and a placeholder page.
5. `chore: engine uv project and lock`: `engine/pyproject.toml` (hatchling, Python 3.12, the SPEC 25 engine pins, extra `challenger` with hazardous 0.2.0, dev group pytest, ruff, hypothesis, statsmodels), `uv.lock` resolved to 157 packages, venv 820 MB, CLI skeleton `staysignal`.
6. `test: prose and public hygiene checks, ...`: `scripts/lib/prose.ts` and `scripts/check-prose.ts` (copied from PeopleLake, banned phrasing added), `scripts/lib/hygiene.ts` and `scripts/check-hygiene.ts` (public tier; `--staged`; `--private` fails closed unless `SS_PRIVATE_DENYLIST` names a non-empty file outside the repo), `scripts/hooks/pre-commit` and `npm run hooks:install`, `test/node/hygiene.test.ts` (C46, C68 planted hits), `.github/workflows/ci.yml` with jobs `node` and `engine`. The private deny-list was created at `~/Developer/projects/_staysignal-notes/hygiene-denylist.txt` (outside the repo, mode 600) for Nitish to review and extend.

## Next

M0: 27B measurement on agent-shaped prompts.

## Check status

At commit 4: `npm run typecheck` clean; `npm test` 2 passed (worker health, node scaffold); `npm run build` ok (client 68.7 kB gzip); `npm run typegen:check` up to date. At commit 5: engine `pytest` 1 passed, `ruff check` and `ruff format --check` clean. At commit 6: `npm test` 11 passed (worker 1, node 10); `check:prose` 12 files clean; `check:hygiene` public tier clean; private tier clean over the whole tree; engine pytest 1 passed, ruff clean. CI has not run on GitHub yet (the publisher pushes).

## Deviations from SPEC.md

- `origin` is set to `https://github.com/nitishsjsucs/staysignal.git` because the builder task asked for it; SPEC 22.5 says to add no remote. Nothing is ever pushed from this repository; the operator's publisher owns publishing.
