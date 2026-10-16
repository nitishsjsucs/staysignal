# Development

How to run, test and check StaySignal on your own machine. Everything here runs locally on the synthetic company; nothing downloads model weights, and the local models are optional (they are used only for recorded runs, evals and rehearsal).

## Contents

- [Requirements](#requirements)
- [Fixtures mode in four commands](#fixtures-mode-in-four-commands)
- [The engine path](#the-engine-path)
- [Every command](#every-command)
- [Tests and checks](#tests-and-checks)
- [Recorded demo turns](#recorded-demo-turns)
- [Screenshot baselines](#screenshot-baselines)
- [README media and results](#readme-media-and-results)
- [MCP locally](#mcp-locally)
- [What runs where, in full](#what-runs-where-in-full)

## Requirements

Node 24 or later and npm 11 for the app. uv and Python 3.12 for the engine (`engine/`), and Python 3.11 through uv for the Scenario Lab's `sim/` project. Docker only for the Playwright screenshot baselines. ffmpeg only to rebuild the README's guided-tour animation.

## Fixtures mode in four commands

No Python, no model weights and no cloud account: the app serves committed fixtures exported from the synthetic warehouse and answers the chat with a scripted stub model.

```sh
npm ci                 # dependencies
npm run dev:keys       # local dev keys and the runner token in .dev.vars (gitignored)
npm run dev:wrangler   # builds the app and serves it on http://127.0.0.1:8795 (fixtures, stub model, fixture runner)
npm run stop           # stops every process the repository started
```

Open http://127.0.0.1:8795 and switch roles with the role switcher.

## The engine path

The engine computes every job live from a local DuckDB warehouse built from the synthetic world:

```sh
uv sync --project engine                                    # the engine's locked environment
uv run --project engine staysignal engine prepare --fresh   # land the canonical world, build the warehouse, publish the two runs
npm run dev:engine                                          # engine mode: built app on 8795, the engine on 8196 computes every job live
npm run stop
```

## Every command

The commands are listed as SPEC.md section 22.2 defines them; [STATUS.md](STATUS.md) says what each area does today.

```sh
npm ci && uv sync --project engine && uv sync --project sim   # dependencies (npm run setup is planned, not built)
npm run hooks:install && npm run dev:keys                      # the pre-commit hook and local dev keys
uv run --project engine staysignal engine prepare --fresh      # land the canonical world, build the warehouse, publish the runs
npm run dev:wrangler                                           # fixtures mode: built app on 8795, stub model, fixture runner
npm run dev:engine                                             # engine mode: built app on 8795, the engine on 8196 computes every job live
npm run dev:public-demo                                        # the public demo locally (ADR 0018): built app on 8795, a throwaway session key
npm run demo                                                   # built app under wrangler dev 8795 and the engine; replays recorded model output only (SS_DEMO=1)
npm run demo:snapshots                                         # per-beat snapshots of the demo state under var/snapshots/
npm run demo:reset -- --beat N                                 # restore the start of beat N and start the demo profile
npm run demo:record -- --provider mlx                          # record the demo's chat turns on the local 27B (below)
npm run stop                                                   # stops every recorded process and staysignal-* container
```

Ports: 5175 for Vite in development, 8795 for the built app under wrangler dev, 8196 for the engine, and 8186 and 8187 for the optional local models (Qwen3.6-27B on mlx_lm.server, Qwen3-1.7B on llama-server). `npm run llm` starts a model server only when the memory budget and the available-memory pre-flight allow it, and a guard stops it on swap growth or low disk.

The demo runbook with exact clicks and a Q&A crib is [demo-script.md](demo-script.md); its "Before you start" section covers the cached demo (no model server needed), how to reset, and how the recordings are made once.

## Tests and checks

```sh
npm run test                  # vitest projects: worker, worker-demo, worker-inline, worker-public-demo, node, web
npm run test:py               # engine pytest
npm run test:e2e:local        # Playwright on the local Chromium (20 specs: beats 1 to 5, Trust, Workforce, Memory, Traces, Governance, Research, Lab) against the built app under wrangler dev (stub model, fixture runner)
npm run test:e2e              # the same specs plus the screenshot baselines in the amd64 Playwright container (-- --update writes the baselines)
npm run test:e2e:engine       # beats 1 to 5 against the live engine (prepares a fresh state first)
npm run test:e2e:public-demo  # the public demo's guided tour (ADR 0018) against wrangler dev in SS_AUTH_MODE=demo over https
```

Checks that CI or the pre-commit hook run:

```sh
npm run typecheck        # the Worker, web and node tsconfigs
npm run typegen:check    # generated Worker types are current
npm run check:prose      # Markdown: no em or en dashes, no banned phrasing
npm run check:hygiene    # public tier over every tracked file: dashes, secrets, pinned-path SHAs, generated-text terms and names
npm run results:check    # the README headline, docs/RESULTS.md and the charts are current with results/
npm run evals:check      # the agent eval set is current
npm run fixtures:check   # the API fixtures index is current
npm run deploy:dry-run   # the three Worker configs: Workers Free rules, a production build, wrangler deploy --dry-run
```

The pre-commit hook (`npm run hooks:install`) runs the prose check, both hygiene tiers over the staged files and the operator's secret scan of the staged tree. The private tier reads a deny-list kept outside the repository from `SS_PRIVATE_DENYLIST` and fails closed when it is not set.

## Recorded demo turns

ADR 0010. `npm run demo:record [-- --provider mlx|llama] [--questions demo/questions.json] [--only id,id]` asks each chat question of the demo script (beats 1, 2 and 5, the boundary question and three optional questions, listed in `demo/questions.json`) through the same AnalystAgent turn as the chat dock, with a live local model, and writes the model's steps (tool calls with their arguments, then its text) to `demo/recordings/<id>.json`, labeled with the model and the date; then it regenerates the recordings index.

It needs `npm run dev:wrangler` and the guarded model server (`npm run llm -- start 27b`); restart the server afterwards so the bundle includes the new turns. A turn whose text fails the grounding check is not written, and the boundary question is refused before any model call, so it needs no recording. Only 27B recordings are committed as demo turns; `test/worker/recordings.test.ts` replays every committed recording with the tools running live and requires grounding to pass and the result IDs to match.

## Screenshot baselines

After a UI change, the manual workflow `.github/workflows/baselines.yml` runs the e2e specs with `--update-snapshots` in the same amd64 Playwright image and environment as the CI `e2e` job and uploads `test/e2e/__screenshots__` as the artifact `screenshot-baselines` (a flow failure does not stop the upload):

```sh
gh workflow run baselines.yml --ref main
gh run list --repo nitishsjsucs/staysignal --workflow baselines.yml --limit 1   # the run id
gh run download <id> -n screenshot-baselines -D test/e2e/__screenshots__
git add test/e2e/__screenshots__ && git commit                                # CI e2e then compares exactly
```

## README media and results

```sh
npm run docs:screenshots   # docs/screenshots/*.png and detail/*.png: the public demo served locally, each tour beat clicked in Chromium
npm run docs:tour          # docs/images/tour.gif and tour-poster.png, from seven of those screenshots (needs ffmpeg)
npm run docs:figures       # docs/images/figures/*.svg from results/ and evals/results/, docs/images/diagrams/*.svg and the brand mark
npm run results:readme     # the README's generated sections, docs/RESULTS.md and the figures, from the same files
```

Every chart, the README's proof strip, headline table and limits, and docs/RESULTS.md are generated from the committed result files, never edited by hand; the four diagrams are drawn by `scripts/lib/diagrams.ts`. `npm test` compares each with a fresh render, so a stale one fails CI.

## MCP locally

`/mcp` serves StaySignal's governed tools to MCP clients (stateless `createMcpHandler`, the same registry, authorization, suppression and rounding as the chat dock). Each principal is offered only the tools its role may use; no approval, submission, rollback or mapping action is exposed. Locally, sign in with a dev token (`GET /dev/login?principal=pa-analyst@larkspur.example` on localhost) and send it as `Authorization: Bearer <token>`. Production access through an Access service token is in [runbooks/prod-setup.md](runbooks/prod-setup.md#mcp-clients-in-production); the public demo answers 404 at `/mcp`.

## What runs where, in full

The README's table compares the public demo, local runs and the production design; this is the full local and production matrix of SPEC.md section 18 (ADR 0011: every local stand-in is labeled). Production has not been deployed.

| Concern | Local (stand-in) | Production (designed, not deployed) |
|---|---|---|
| UI hosting | Vite 5175 in development; built assets under wrangler dev 8795 for the demo and e2e | Worker static assets behind Access |
| API, agents, workflows, MCP | Worker in wrangler dev; Durable Objects and Workflows run locally | the same Worker on Workers Free |
| Authentication | dev keys and dev tokens, role switcher | Cloudflare Access (one-time PIN); service tokens for the runner and MCP |
| Chat and investigation model | recorded Qwen3.6-27B turns with live tools (the demo: recordings only, no live model); Qwen3.6-27B on mlx_lm.server 8186 and Qwen3-1.7B on llama-server 8187 for recording and evals; stub in CI | Workers AI `@cf/qwen/qwen3-30b-a3b-fp8` through AI Gateway, best effort under the Free CPU limits |
| AI observability | local trace table with full text | AI Gateway metadata-only logs plus the trace table, metadata only |
| Warehouse | DuckDB via dbt-duckdb in the engine process | BigQuery `staysignal_*` datasets via dbt-bigquery; committed fixtures in a fixtures deployment |
| Python compute | runner embedded in the FastAPI engine | runner on the operator's Mac against BigQuery; none in a fixtures deployment |
| Raw landing | content-addressed files under `var/landing/` | R2 bucket `staysignal-landing` |
| Memory | a real git repository under `var/memory`, read and written through the engine; in fixtures mode the WorkspaceAgent's git-style store, started from the committed export | git-style history in Durable Object SQLite (not git) |
| Action log and audit | WorkspaceAgent SQLite, anchored daily outside the Durable Object | the same, anchored in R2 by the runner |
| CI | fixtures mode, stub model, fixture runner, DuckDB, no secrets | not applicable |

In the local engine the Worker's warehouse reads go through a shim that executes only compiled catalog entries, the embedded runner leases jobs from the Worker, and `POST /sources/arrive` lands a new extract in the immutable landing store and notifies the Worker.
