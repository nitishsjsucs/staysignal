# Build progress

Builder log for the commit plan in SPEC.md section 24. Updated in every commit.

## Demo date and schedule variant

- Demo date: **not known yet** (1 to 2 weeks from 2026-10-11; the operator has not given a date to the builders).
- Active variant: **7-day** (SPEC 24: the 7-day variant applies while the date is unknown). Gate B (demo-ready on real data) is due at the end of day 5, 2026-10-16.
- Freeze: 2 days before the demo once the date is known; if the demo is on 2026-10-18, the freeze is Gate B itself.
- Day 1 is 2026-10-12.

## Position

M0 done except a clean 27B measurement (commit 7 of 7, `eval: 27B measurement on agent-shaped prompts`, recorded as partial). Next: M1, the walking skeleton.

## Done

1. `chore: scaffold`: `git init -b main`, repository identity, MIT license, NOTICE, `.gitignore`, `.editorconfig`, `.nvmrc` (24), `.python-version` (3.12), a first README.
2. `docs: README with status table, mermaid and local setup; CONTEXT.md; PROGRESS.md`.
3. `docs: ADRs 0001 to 0007 and 0012` under `docs/adr/`.
4. `chore: pinned package.json, ...`: 339 npm packages (518 MB) at the SPEC 25 pins (d3-scale 4.0.2 and d3-shape 3.2.0 confirmed with `npm view`; `@types/d3-scale` 4.0.9, `@types/d3-shape` 3.2.0, `@types/node` 24.19.1 added); `tsconfig.{worker,web,node}.json` (strict, `noUncheckedIndexedAccess`, ES2021 target for TC39 decorators); `vite.config.ts` with `agents()`, `react()`, `cloudflare()`; `vitest.config.ts` with projects `worker` (`@cloudflare/vitest-plugin`), `node`, `web` (happy-dom); `wrangler.jsonc` (vars only, ports 8795 and 9245); generated `worker-configuration.d.ts`; a health-only Worker and a placeholder page.
5. `chore: engine uv project and lock`: `engine/pyproject.toml` (hatchling, Python 3.12, the SPEC 25 engine pins, extra `challenger` with hazardous 0.2.0, dev group pytest, ruff, hypothesis, statsmodels), `uv.lock` resolved to 157 packages, venv 820 MB, CLI skeleton `staysignal`.
6. `test: prose and public hygiene checks, ...`: `scripts/lib/prose.ts` and `scripts/check-prose.ts` (copied from PeopleLake, banned phrasing added), `scripts/lib/hygiene.ts` and `scripts/check-hygiene.ts` (public tier; `--staged`; `--private` fails closed unless `SS_PRIVATE_DENYLIST` names a non-empty file outside the repo), `scripts/hooks/pre-commit` and `npm run hooks:install`, `test/node/hygiene.test.ts` (C46, C68 planted hits), `.github/workflows/ci.yml` with jobs `node` and `engine`. The private deny-list was created at `~/Developer/projects/_staysignal-notes/hygiene-denylist.txt` (outside the repo, mode 600) for Nitish to review and extend.
7. `eval: 27B measurement on agent-shaped prompts`: `scripts/llm.ts` (guarded lifecycle: one server at a time, no heavy work alongside, memory budget, an available-memory pre-flight, a detached guard sampling swap and disk every 0.5 s), `scripts/lib/{pids,guards,memory-budget,results}.ts`, `scripts/llm-measure.ts`, `scripts/results-to-readme.ts`, `src/shared/tools/schemas.ts` (the 13 tool input schemas), tests `memory-budget.test.ts` (C65) and `results-readme.test.ts`. Recorded `results/llm-measure-2026-10-12.json` (27B, partial) and `results/llm-measure-1.7b-2026-10-12.json` (complete). W set to 15.7 GB (wired-memory delta after load); the Lab profile drops to 3 sequences.

## Next

M1 walking skeleton: small-profile world with the final hazards; minimal engine path (features at one cutoff, MNL fit, cohort Monte Carlo, fixtures export); Worker with dev auth, fixtures warehouse, WorkspaceAgent runs, approvals, action log and rollback, fixture runner; AnalystAgent with stub and recorded providers, aliases and grounding; tokens, shell, chat dock and the Forecast, What changed, Data health and Reviews pages in fixtures mode; beats 1 to 5 click-through e2e.

## 27B measurement findings (2026-10-12)

- Three 27B starts this session: two loads grew swap by 2.17 and 4.99 GB before the guard stopped them (the guard then sampled every 2 s; it now samples every 0.5 s and a pre-flight refuses to start with less than 17 GB available); the third measured prefill and decode, then grew swap by 2.01 GB and was stopped before the tool-call probe. Swap was 5.99 GB used before the first start and about 13.4 GB after the last, and free disk fell from 34 to 27 GiB (swap files). Other apps (a browser with many tabs, chat apps, another project's Python service) held about 8 GB. Nitish: close them before any 27B run; then `npm run llm:measure` completes the measurement, including the tool-call probe.
- Measured on the 27B: the system prompt plus 13 tool schemas is 3,700 prompt tokens; prefill about 180 to 200 tokens a second; time to first token 20 s for that prefix cold and 13.7 s for 2,800 new tokens after a cached prefix; decode 7.6 to 7.9 tokens a second single stream. With `--prompt-cache-bytes 512MB` only the tools prefix stays cached (a 6,500-token entry does not fit), so a cold live turn takes 20 s or more to its first token: the 12-second fallback of SPEC 3 would fire unless `demo:reset` warms the prefix, which it must.
- Qwen3-1.7B through `@ai-sdk/openai-compatible`: 4 of 4 questions routed to the right tool, with invented arguments in 2 (run ids for `explain_change`, a node name copied from the tool description). The server must default and validate run ids, never trust them.

## Check status

At commit 4: `npm run typecheck` clean; `npm test` 2 passed (worker health, node scaffold); `npm run build` ok (client 68.7 kB gzip); `npm run typegen:check` up to date. At commit 5: engine `pytest` 1 passed, `ruff check` and `ruff format --check` clean. At commit 6: `npm test` 11 passed (worker 1, node 10); `check:prose` 12 files clean; `check:hygiene` public tier clean; private tier clean over the whole tree; engine pytest 1 passed, ruff clean. CI has not run on GitHub yet (the publisher pushes). At commit 7: `npm test` 20 passed (worker 1, node 19); typecheck clean; check:prose and check:hygiene clean; README Results in sync.

## Deviations from SPEC.md

- M0 exit is not fully met: the 27B measurement is partial (prefill, first token, decode and W measured; tool calls through the AI SDK measured only on the 1.7B) because the memory guard stopped the 27B. The tool-call probe and the 8k cold probe on the 27B wait for a run with other apps closed.
- Files not in SPEC 5's layout: `scripts/llm-measure.ts` (the M0 measurement) and `scripts/lib/results.ts` (README Results rendering).

- `origin` is set to `https://github.com/nitishsjsucs/staysignal.git` because the builder task asked for it; SPEC 22.5 says to add no remote. Nothing is ever pushed from this repository; the operator's publisher owns publishing.
