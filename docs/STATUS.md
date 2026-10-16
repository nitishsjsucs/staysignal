# Status

What works, area by area, as of 2026-10-15. The README keeps a one-line summary of each area; this page has the detail. Work follows the commit plan in [SPEC.md](../SPEC.md) section 24, core path first, and [PROGRESS.md](../PROGRESS.md) logs every commit, every check run and every deviation from the spec.

Only the [public demo](PUBLIC-DEMO.md) is deployed, on Cloudflare Workers Free. Everything else runs locally and in CI. The production path (Cloudflare Access, BigQuery, Workers AI) is built and tested against fakes, and has never run: production BigQuery has never been used.

Everything here runs on the synthetic company Larkspur Systems (`larkspur.example`). The numbers quoted on this page come from the result files under `results/` and `evals/results/`, rendered in [RESULTS.md](RESULTS.md).

## Contents

- [Public demo](#public-demo)
- [Foundations](#foundations)
- [Synthetic world](#synthetic-world)
- [Features, model and forecast](#features-model-and-forecast)
- [Warehouse and data quality](#warehouse-and-data-quality)
- [Worker, agents, workflows and approvals](#worker-agents-workflows-and-approvals)
- [Frontend](#frontend)
- [Agent evals](#agent-evals)
- [Local 27B measurement](#local-27b-measurement)
- [Demo profile](#demo-profile)
- [Memory](#memory)
- [Action audit](#action-audit)
- [Research benchmark](#research-benchmark)
- [Scenario Lab](#scenario-lab)
- [Production path](#production-path)

## Public demo

**Live** at https://staysignal-demo.nitish-ratakonda.workers.dev since 2026-10-15 (ADR 0018). [PUBLIC-DEMO.md](PUBLIC-DEMO.md) has what a visitor sees, the owner's deploy steps, the deploy check and the limits.

- The Worker `staysignal-demo` was deployed from `4376765`. `SS_AUTH_MODE=demo` serves anyone a private sandbox of the whole product from a signed session cookie: one of the seven synthetic principals, at most 4 hours, roles switchable inside the sandbox. Every piece of mutable state is keyed by the sandbox and deleted at its expiry.
- MCP, dev, runner and internal routes answer 404.
- A request another origin starts (a WebSocket upgrade, a write, a read) is refused; the session cookie is `__Host-` prefixed and `SameSite=Strict`; no page can frame the app (ADR 0018, decision 8).
- Caps on new sandboxes per client and per day, on live sandboxes and on each sandbox's request units, with the budget arithmetic against the Workers Free limits pinned by tests (`npm test`, project `worker-public-demo`).
- WebSocket frames pass a guard before the agents SDK: a chat request spends its units before anything is stored, and every other kind a visitor's script could send is dropped. A sandbox already known to refuse costs no Durable Object request.
- Recorded Qwen3.6-27B turns replay for the recorded questions (each role is offered the ones its permissions can run) and the labeled stub answers the rest. No model runs, and engine jobs return results recorded from the engine, which the Data health page says.
- The landing page explains the demo in two sentences, starts a sandbox in the chosen role on a cohort that role may see, and links the source. A persistent banner says it is a public demo with a synthetic company and recorded model and engine output, and when the sandbox resets, with a role switcher, a guided tour of the eleven beats in order (each beat closes the tour and, where it suggests a question, opens the chat) and a reset. The chat's chips say which questions replay a recorded turn and which get the stub. A sandbox that has used its units says so and starts a fresh one.
- `npm run deploy -- --demo [--dry-run] [--yes]` renders the Worker `staysignal-demo`. `npm run test:e2e:public-demo` clicks through the whole tour in Playwright against wrangler dev over https under a non-localhost host name (a CI step).

## Foundations

**Done.**

- Scaffold, license, README, [CONTEXT.md](../CONTEXT.md) and PROGRESS.md.
- ADRs 0001 to 0007, 0012 and 0018 in [adr/](adr/) (0018 is the public demo); the others are summarized in SPEC.md section 2.
- [Model card](model-card.md), [regulatory notes](regulatory-notes.md) and [employee notice template](employee-notice-template.md). The model card carries the proxy strength from the action audit.
- Node toolchain: exact pins (SPEC 25), strict tsconfigs, Vite 8 with the `agents()` plugin, generated Worker types, and the vitest projects `worker`, `worker-demo`, `worker-inline`, `worker-public-demo`, `node` and `web`.
- Engine uv project (Python 3.12): `engine/pyproject.toml` with the SPEC 25 pins, a committed `uv.lock` (157 packages), the `staysignal` CLI, pytest and ruff.
- Prose and hygiene gates, a pre-commit hook and CI:
  - `npm run check:prose`: no em or en dashes and no banned phrasing in Markdown.
  - `npm run check:hygiene`, the public tier: dashes in every tracked file, secrets, no git SHA in pinned paths, and monitoring and special-category terms and a personal-name heuristic over generated text.
  - The pre-commit hook adds the private tier, from a deny-list kept outside the repository, and the operator's secret scan.
  - CI jobs: `node`, `engine`, `challenger`, `e2e`, `sim` and `agent-eval-stub`.

## Synthetic world

**Done** for the canonical and small profiles.

- `staysignal world generate --profile canonical|small` builds Larkspur Systems from a seed (SplitMix64 streams per stage): the exact SPEC 6.2 structure, the SPEC 6.3 hazards with a latent propensity, team and organization shocks per quarter, contagion and drift, bitemporal HRIS records with daily deltas, payroll, ATS, the org tree, bands, the audit-only attribute, truth files and the planted problems of SPEC 6.5.
- The canonical world is pinned by SHA-256 in `data/world/manifest.json`; CI regenerates it on Linux and runs `staysignal world verify` against the macOS-made pins.
- The forward-simulation oracle (`world/oracle.py`) runs the generator forward 2,000 times from the true state at a cutoff. Its coverage check (C5) is recorded in [RESULTS.md](RESULTS.md) and misses the upper bound of its target by one cell.
- The `recovery` profile (40,040 employees, with the latent propensity, the interaction, drift and shocks switched off) shows that the estimator recovers a correctly specified truth (C6, recorded; `engine/tests/model/test_recovery.py` runs it in CI in about 45 seconds).
- The shock-world variant is built too: `engine/tests/model/test_recovery_shock.py` and `results/recovery-shock-2026-10-13.json`, where the slopes pass all three checks against simulated marginal targets on a world with team shocks the model omits.

## Features, model and forecast

**In progress** (the engine).

- Point-in-time features in two implementations pinned to the same values: `features/pit.sql` (one parameterized DuckDB query over the dbt intermediates) and the pure-Python reference with corrections, rescissions, duplicates and vintages.
- The 18 named tests of SPEC 8.4 run on both. A hypothesis property test checks no lookahead, and pit.sql equals the reference exactly on the small world at 6 cutoffs, at the final and at backtest vintages.
- The landmark competing-risks multinomial logit with team-clustered sandwich covariance, the shared-shock estimator, and nested Monte Carlo intervals with an exact variance decomposition.
- Baselines: `hist` (the trailing rate), `aj` (Aalen-Johansen marginal cumulative incidence per organization) and `oracle` (the forward simulation), compared with the model on the six mature quarterly origins by `evaluate/comparison.py`.
- The SurvivalBoost challenger (`hazardous` 0.2.0 in the optional uv extra `challenger`, with Poisson-binomial and shock-aware intervals) and the model refitted on the challenger's 12,000 sampled rows on the same origins (`staysignal eval challenger`, C15; a CI job runs a 3-iteration smoke).
- The `recovery` check (C6), feature effects (partial dependence with parameter bands, `evaluate/effects.py`), a `backtest_summary` tool that answers accuracy questions from the recorded evaluation, run keys and business-result hashes.
- `staysignal demo build` trains `models/m2026.08` and `models/m2026.09` and exports the two published runs as API fixtures (provisional until the world calibration is frozen).

## Warehouse and data quality

**In progress.** The phase-1 checks and three phase-2 checks (F04, R02, R04) are built; the other nine phase-2 checks of SPEC 13.1 are not.

- **Ingestion.** `staysignal ingest land` validates each extract against `sources/schemas/*.schema.json`, stores it once under `var/landing/<source>/<period>/<sha256>.csv` (read-only) and appends it to its `raw_<source>` table. A re-delivery appends nothing, and every delivery is still recorded for freshness.
- **Mappings and snapshots.** Payroll mappings v1 and v2 are hashed and compiled into `raw.map_pay_basis`; `staysignal snapshot conformed --as-of <vintage>` writes pseudonymized Parquet snapshots under a content-addressed ID.
- **dbt.** `staysignal warehouse build --vintage <v> --mapping <m>` runs dbt in process on the engine's own DuckDB connection (ADR 0012, spike recorded there) and captures OpenLineage events with column lineage: staging with `er_` keys; the bitemporal intermediates (corrections, rescissions and duplicates resolved at the vintage, spells, an SCD2 assignment timeline, net manager changes, annualized pay under the run's mapping); restricted employee-month and compensation facts; and published tables with small-cell suppression. Tests compare spells, departures and populations with the Python reference.
- **Checks.** The phase-1 checks run on the warehouse (dbt tests `dq_<id>_*` plus engine SQL for F01, U01 and C03) and give exactly the Python checks' results on the canonical world, including the payroll defect pattern.
- **Fault benchmark** (C53, `staysignal eval dq-faults`). It injects five fault types into five copies of the small world and records which checks catch each, where the root-cause ranking puts its root, and how far the forecast would have moved had the run not been held. On 2026-10-12, with the phase-1 checks only, the pay-basis defect, a missing payroll extract and duplicates were caught every time, late terminations mostly were not (and would have moved the forecast most), and broken manager references were not caught. On 2026-10-13, with F04, R02 and R04 built, late terminations were caught 5 of 5 by F01 and F04 and broken manager references 5 of 5 by R04: 25 of 25 faults detected, every root ranked first (`results/dq-faults-2026-10-13.json`).
- **BigQuery, offline only.** Every model and test routes dialect differences through `warehouse/macros/dialect/`, and `staysignal warehouse compile-bigquery` (also a CI step) compiles them offline with no credentials, scans the SQL for constructs BigQuery rejects and parses it as BigQuery SQL. The production profile (runner only, impersonation, a 1 GiB bytes cap) is written but has never run, because builders create nothing in the cloud.
- **Semantic layer.** Versioned metric definitions frozen once a published run uses them (`semantic/metric_definitions.yaml`), a published monthly flows model that balances exactly, a MetricFlow semantic model with nine metrics, and `staysignal semantic catalog`, which renders every governed query shape for DuckDB and BigQuery ahead of time (`src/worker/generated/catalog.*.json`, checked for freshness in CI). Every DuckDB entry equals an independent Python computation from the reference on the canonical world, and the engine's shim executes only these entries, behind a single-SELECT guard, with parameters the server binds.
- **Fixtures mode.** The default catalog requests are answered from results exported from a fresh canonical warehouse (`staysignal semantic export-fixtures`; a test checks each equals a fresh execution). The forecast documents are still served as engine-exported documents rather than catalog entries.

## Worker, agents, workflows and approvals

**In progress.** Tested end to end in workerd (`npm test`).

- **API and tools.** A Hono API with Access JWT verification (dev keys generated at runtime) and a governed tool registry of 11 tools, with authorization by role and level, rounding by cohort size, hidden-sum suppression and content-addressed result IDs. `workforce_flows` reads the semantic catalog: flows over a window with links under 10 merged, People Partners scoped server-side. The tools are served to the agents and, at `/mcp`, to MCP clients under the same permissions.
- **WorkspaceAgent.** Runs and the published pointer, the hash-chained action log and approval audit with anchors, the `SELF_APPROVAL`, `WRONG_ROLE`, `AGENT_PRINCIPAL` and `STALE_SUBJECT` refusals, review tasks with the pay-equity blocking item, one-click rollback with a reason, and the engine job queue.
- **Routine.** The `source_arrival_refresh` RoutineWorkflow with gates: hold, deterministic mapping proposal, data-engineer approval, repair, publish within tolerance, replay. The repair runs inside this workflow; a separate ReviewWorkflow is not built (reviews are approved directly on the WorkspaceAgent with the same rules).
- **AnalystAgent.** The pre-router, stub and recorded providers, per-turn aliases, numeric grounding with one repair and a template fallback.
- **Multi-agent investigation** when a run is held or changes beyond tolerance: three specialists (data quality, model, workforce composition), each with its own prompt and scoped tools, run one after another as their own workflow steps as the agent principal. Their reports are validated (placeholders only, evidence from their own results) with one repair and a template fallback, then merged deterministically, most severe first, with every finding citing its result IDs and a pointer at the deterministic mapping generator (shown on Data health).
- **Engine mode.** A fixture runner stands in locally; in engine mode the local engine replaces it: `staysignal serve` answers the Worker's published-layer reads and a runner thread leases the routine's jobs (ingest, checks on the warehouse, scoring, probe, mapping proposal, comparison, replay in a fresh DuckDB file) and computes them live. Each equals its committed fixture, and beats 1 to 5 pass end to end in both modes.

## Frontend

**In progress.** A React 19 app with design tokens (light and dark, the palette checked with the dataviz validator for color-vision deficiency), the app shell with cohort, horizon and role controls, the chat dock, and twelve pages, among them:

- **Forecast:** the hero number with ranges and the trailing-rate status quo, a trust strip, a fan chart, a backtest strip, the variance decomposition and a breakdown.
- **Trust:** the monthly backtest timeline with its overlap subtitle, the reliability diagram with team-clustered intervals, coverage against nominal 80% and 95%, the model comparison as small multiples, the count PIT histogram and feature effects with parameter bands, filtered by role.
- **What changed:** the five-factor waterfall.
- **Data health:** the check heatmap, the held run, the routine stepper and the mapping approval.
- **Reviews:** draft, submit, approve or refuse, tasks, the audit chain and rollback.
- **Workforce:** where a cohort's people came from and went over 12 months (tiles and a three-column flow chart from the semantic catalog, small links merged), and a funnel plot of each cohort's observed over expected departures in the latest mature backtest window against its expected count, with 95% and 99.8% Poisson limits, for groups and above with 50 or more people, scoped like every comparison over time.
- **Memory:** search, the notes by kind with the timeline tiers, a note's dated bullets and the commit log.
- **Traces:** each answer's spans as a gantt with tokens and outcomes. Analysts see their own traces, leads every trace, the auditor metadata only.
- **Governance:** the action audit's impact ratios against the four-fifths line, the roles and scopes, and the disclosure rules.

Charts are SVG with d3-scale and d3-shape, each with a hover tooltip and a table view; no page scrolls sideways at phone width.

- `npm run dev:wrangler` serves the built app under wrangler dev with the stub model and the fixture runner; `npm run stop` stops it.
- `npm run test:e2e:local` clicks through beats 1 to 5 in Playwright against that server (Gate A).
- The 12 screenshot baselines (Forecast, Data health and Reviews at 1440 and 390 wide, light and dark) are made in the amd64 Playwright image and compared exactly by the CI `e2e` job. Docker on the Mac emulates amd64 with qemu, where wrangler dev does not start, so after a UI change the baselines are remade on GitHub by the manual `baselines` workflow ([DEVELOPMENT.md](DEVELOPMENT.md#screenshot-baselines)).

## Agent evals

**Partial:** the stub and Qwen3-1.7B runs are recorded and the stub run is a CI job; the Qwen3.6-27B run waits.

- `evals/agent/questions.jsonl` holds exactly 200 synthetic questions (60 routing with cohort aliases and horizons in days, 40 grounding with gold pointers, 40 refusals across six kinds, 30 injection attempts, 30 multi-turn), built by `npm run evals:build`.
- `npm run eval:agent -- --model stub|llama|mlx` runs them through the same turn as the chat dock and records routing, grounding, refusal precision and recall by code, injection successes and latency in `evals/results/`.
- The stub run is a CI job with assertions: every pre-router refusal code fires on its items, and no injection succeeds. The stub refuses 100% of its refusal items too.
- The Qwen3-1.7B run (llama-server, 22 minutes, no infrastructure errors) was rerun on 2026-10-13 after two server-side layers were added before any model call: a cohort guard refuses a question that names a cohort below the size floors with `SMALL_COHORT` (the same rules the tools apply), and the pre-router refuses commands to approve, reject, publish or roll back, requests for raw rows, and requests to drop the rules. Result: routing 51.7%, grounding 50% (22 passed, 2 repaired, 6 template answers), refusal accuracy 100% (recall 1 for every code; out-of-scope refusals still over-fire on answerable questions, precision 0.30), 0 prompt-injection successes, multi-turn 40%, latency p50 6.3 s.
- The earlier run's two injection "successes" were calls to `search_memory`, a read-only tool missing from the injection items' allowed-tool lists at the time; the lists now hold every registry tool, and a test keeps them in step.
- The 27B run waits for a session with enough free memory.

## Local 27B measurement

**Partial.**

- `npm run llm:measure` measured prefill, time to first token and decode for Qwen3.6-27B, then the memory guard stopped it when swap grew by 2 GB with other apps open, before the tool-call probe.
- The same harness ran completely on Qwen3-1.7B, including tool calls through `@ai-sdk/openai-compatible` ([RESULTS.md](RESULTS.md#local-model-and-operations)).
- `npm run llm` starts a server only when the memory budget, the available-memory pre-flight and the no-heavy-work rule allow it, and a guard stops it on swap growth or low disk.

## Demo profile

**Done** for the interview demo of 2026-10-14 (the public demo above replaces it for visitors).

- `npm run demo` serves the built app with the local engine (`SS_DEMO=1`); `npm run demo:snapshots` drives the routine through the API and saves the state at the start of beats 1, 4 and 5 (Workers persistence, warehouse, landing store, published documents); `npm run demo:reset -- --beat N` restores one in about 3 seconds.
- The demo runs no model live (the operator's decision of 2026-10-13). With `SS_DEMO=1` the Worker uses the recorded provider whatever `SS_LLM` says, so chat answers, Scenario Lab sessions and persona interview answers are recordings from Qwen3.6-27B on this laptop, replayed with the line "Recorded from Qwen3.6-27B on this laptop, <date>; replayed", while tools, warehouse queries and numbers compute live.
- A question without a recording gets a short message and the recorded questions as chips, never a stub answer; the Lab hides the stub placeholder sessions; and a test (`test/worker-demo`) fails if demo mode reaches a live provider.
- Recorded on this laptop on 2026-10-13 from Qwen3.6-27B in low-memory mode (the `agent-lowmem` and `lab-lowmem` profiles: no prompt cache, 512-token prefill steps, an 8-bit KV cache; `--allow-swap` with `SS_SWAP_GROWTH_LIMIT_GB=6`, at the operator's request): five chat turns in `demo/recordings` (beats 1, 2 and 5, the coverage and profile questions; each passed grounding; the boundary question is refused before any model call), two Scenario Lab sessions and four persona interview answers.
- A rehearsal of the whole script with a sentinel on the model ports recorded no connection from the app.

## Memory

**Done.**

- A real git repository of Markdown notes under `var/memory` (decisions, investigations, group notes, a timeline coarsened from daily to weekly to monthly, audit anchors), seeded by `staysignal engine prepare` and committed by the agent as itself with dates from the synthetic clock, so commit SHAs are reproducible (a test pins their digests and shows the machine's git configuration cannot change them).
- Search is `git grep` with alias expansion, ranked by hits then recency. The `search_memory` tool answers "what did we decide last time?" with the note's path, commit and date; People Partners see only their organizations' group notes.
- Fixtures mode reads an exported copy with the same search in TypeScript (checked against the engine's results).
- The agent writes through the engine's `POST /memory/note`, which accepts only the runner token and refuses a note that names a person. The source-arrival routine ends with an investigation note citing the held run, the incident, the mapping proposal, the decision and the publish action (or a timeline bullet for a clean run); every approval or rejection becomes a decision note citing its action and the decider's role (never a name or the free-text reason); a rollback becomes a timeline bullet.
- Everywhere else (CI, the fixtures deployment, the public demo) the WorkspaceAgent keeps the same Markdown in SQLite with git-style history, not git. It starts from the committed export and its history, and each write is a commit with git's blob hashes and simplified tree and commit hashes chained to their parent, read back through the same memory API and search.

## Action audit

**Done**, and shown on the Governance page.

- `staysignal audit actions` screens twelve seeded synthetic approved reviews for adverse impact. Each review is a selection opportunity for everyone employed on its date.
- Selection rates by tenure band and location (proxy screens, for leads and the auditor) and by the audit-only age flag (the auditor only) get impact ratios against the highest group, the four-fifths rule of thumb and Fisher's exact test; groups under 10 people are not screened.
- Proxy strength (the AUC of tenure and level band for the audit-only age flag) goes to the model card.
- Only the audit package reads the audit attribute; tests check the import, file and warehouse boundaries.
- Recorded in `results/action-audit-2026-10-12.json` ([RESULTS.md](RESULTS.md#action-audit)).

## Research benchmark

**Done.**

- Pre-registered before any result ([research/PREREGISTRATION.md](../research/PREREGISTRATION.md)). Every result records its SHA-256 and a test checks it; the details fixed while building the runner are logged under its Deviations.
- `npm run research:run` (`staysignal research run --seeds 1-20 --workers N`) builds each seed's research worlds (the canonical structure with no drift and no planted problems), applies the data conditions to what the HRIS recorded (late termination records, a missing termination extract, duplicated departures) or to the generator (team shocks at sigma 0, 0.25 and 0.5 with contagion off), fits the model once per origin and handling (warm-started, the same optimum), scores 3-month intervals with the nested Monte Carlo (shock-aware or independence), and compares with the generator's clean truth. Each seed checkpoints, so a stopped run resumes.
- Equivalence by two one-sided tests on a seed bootstrap. 20 seeds by 8 quarterly origins are recorded and shown on the Research page; CI runs 2 seeds by 2 origins on the small world.
- Result (2026-10-13): H3a and H3b are consistent with the registered predictions (independence intervals lose coverage as shared shocks grow, shock-aware ones hold). H1, H2 and H4 count against them, largely because even the clean base world's O/E sits at about 0.96 to 0.97 (the model over-predicts slightly with no data problem at all), so handling choices that should restore 1 land near or below the 0.95 bound.

## Scenario Lab

**In progress.** Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.

- `staysignal lab cells` exports cohort cells of at least 10 people (`lab/cohort_cells.json`).
- The `sim/` project (Python 3.11, OASIS 0.2.5 with import stubs and an in-repo igraph shim, no GPL distribution) builds 16 personas per replicate (8 under the compact plan) from a proposal's target cells, records every model call, applies actions in a fixed order on a round clock, codes posts in a separate call and analyzes themes, stance by tenure band, item shifts with the acquiescence index, a simulated reply network and draft pilot items with a wording linter. Replay rebuilds each forum with no model and must reproduce its database hash (CI).
- The engine computes the sanity panel (persona agreement against the model's cell rates, a facts-only baseline and two negative controls), and the Lab page serves both proposals.
- **The two committed sessions were recorded from Qwen3.6-27B on this laptop on 2026-10-13** with the compact plan (`npm run lab:record -- --compact`: one main replicate and both negative controls at 8 personas x 4 rounds, against the design's 3 main replicates at 16 x 8; the full plan was about 5 hours per proposal in low-memory mode): `promotion-criteria-third-window` (151 calls, 44 minutes) and `infra-data-merge` (152 calls, 50 minutes).
- With 8 personas the sanity panel pools into few cells and its intervals are very wide (persona agreement 0.20, 95% interval -1.00 to 0.87 over 4 cells for the promotion proposal; 1 cell, not testable, for the merge): underpowered hypothesis generation, not evidence. The hand-coding agreement is not done.
- **The persona interview** is built. On the Lab page one question goes to one persona of the shown session through `POST /api/lab/interview`, which locally in engine mode streams from the engine's `/lab/interview` (the persona's card and own posts from the recorded session, one merged system message, at most 100 tokens from the local 27B, or a scripted stub under the stub model) and otherwise, or when no answer starts within 12 seconds, returns a recorded answer for the same question from `lab/interviews.json` (four answers recorded from the 27B on 2026-10-13) or a labeled placeholder. Every answer carries its source, the "Synthetic persona" chip and the Lab label.
- In demo mode the Lab lists only model-recorded sessions and the interview answers only recorded questions, offered as chips, with no engine or model call.

## Production path

**Built, not deployed.** Builders create, change and deploy nothing in either cloud; the steps the owner would run are in [runbooks/prod-setup.md](runbooks/prod-setup.md).

- `npm run doctor` checks local tools, the Cloudflare login and Workers AI model, the Google project, billing, APIs and datasets, and the secret names, read-only, and reports each gap with its fix.
- `npm run deploy -- --fixtures [--dry-run]` renders the fixtures-mode deployment from `infra/cloudflare/wrangler.fixtures.template.jsonc`, refuses anything Workers Free forbids (a test covers the rules, C42), builds and runs `wrangler deploy --dry-run` with the 8 MiB check (a CI step). In that deployment engine jobs complete inline from the committed fixtures, so no runner is needed.
- The fixtures deployment runs the production model, `@cf/qwen/qwen3-30b-a3b-fp8`, through AI Gateway with metadata-only logging and allowlisted metadata, and a daily neuron budget kept in the WorkspaceAgent (tests mock the gateway; nothing was called).
- `npm run setup:prod -- --phase A|B` prints the owner's plan from read-only probes and the BigQuery grant plan that `npm run policy:compile` compiles from `policy/access.yaml` (dataset-scoped grants, Job User as the only project role, the Worker reading only the published, semantic and lab datasets and one authorized view, bytes caps and the app label on every job), marking steps already done and blocking phase B while billing is disabled. It runs nothing.
- `npm run deploy -- --production [--dry-run]` renders `infra/cloudflare/wrangler.production.template.jsonc` (BigQuery data mode, the `staysignal-worker` key as a secret, an external runner), and the CI dry run builds both templates.
- The Worker's BigQuery client (`src/worker/warehouse/bigquery.ts`) signs a service-account JWT, reads the published documents by key and runs the BigQuery semantic catalog with server-bound named parameters, every job capped at 100 MiB and labeled `app=staysignal` (tested against a mocked BigQuery; nothing was called).
- `npm run prod:validate`, `npm run prod:load` and `npm run runner:prod` exist and print a plan unless the owner passes `--execute`; they are tested against fakes. `npm run prod:smoke` runs its automated checks against fakes and lists the manual ones. Jobs that should write to BigQuery (a production publish) are not wired to the production runner yet, and none of these commands has run against a real project: production BigQuery has never been used (SPEC risk 8).
