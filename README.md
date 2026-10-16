<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/mark-dark.svg">
    <img alt="StaySignal mark" src="docs/images/mark-light.svg" width="56" height="56">
  </picture>
</p>
<h1 align="center">StaySignal</h1>
<p align="center">
  <b>Forecasts voluntary departures for a team or an organization, shows why the forecast deserves trust,
  and turns it into an accountable review. Cohort-level only: no individual scores.</b>
</p>
<p align="center">
  <a href="https://staysignal-demo.nitish-ratakonda.workers.dev"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/demo-button-dark.svg"><img alt="Open the live demo, no account needed" src="docs/images/demo-button-light.svg"></picture></a>
</p>
<p align="center">
  <a href="#walkthrough-in-screenshots">Walkthrough</a> ·
  <a href="#results-at-a-glance">Results</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="SPEC.md">Spec</a> ·
  <a href="docs/model-card.md">Model card</a> ·
  <a href="docs/research-basis.md">Research basis</a>
</p>
<p align="center">
  <a href="https://github.com/nitishsjsucs/staysignal/actions/workflows/ci.yml"><img alt="CI status" src="https://img.shields.io/github/actions/workflow/status/nitishsjsucs/staysignal/ci.yml?branch=main&label=CI"></a>
  <a href="docs/PUBLIC-DEMO.md"><img alt="Demo: Cloudflare Workers Free" src="https://img.shields.io/static/v1?label=demo&message=Cloudflare%20Workers%20Free&color=f38020&logo=cloudflare&logoColor=white"></a>
  <img alt="Data: synthetic" src="https://img.shields.io/static/v1?label=data&message=synthetic&color=6f42c1">
  <img alt="TypeScript 6.0" src="https://img.shields.io/static/v1?label=TypeScript&message=6.0&color=3178c6&logo=typescript&logoColor=white">
  <img alt="Python 3.12" src="https://img.shields.io/static/v1?label=Python&message=3.12&color=3776ab&logo=python&logoColor=white">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/static/v1?label=license&message=MIT&color=blue"></a>
</p>

<p align="center">
  <a href="https://staysignal-demo.nitish-ratakonda.workers.dev">
    <picture>
      <source media="(prefers-reduced-motion: reduce)" srcset="docs/images/tour-poster.png">
      <img alt="Guided tour of the public demo: a forecast with ranges, what changed, a payroll run held at the gate, its repair and replay, a refused self-approval, and the trust page" src="docs/images/tour.gif" width="800">
    </picture>
  </a>
  <br>
  <em>The public demo's guided tour. Synthetic company Larkspur Systems, recorded model output.</em>
</p>

> [!IMPORTANT]
> **Everything is synthetic.** Larkspur Systems (`larkspur.example`) is a fictional company made by a seeded program: its teams, people, records and proposals are generated, and the demo's chat replays recorded model output. Results test the pipeline, the uncertainty method and the robustness experiments, not real-world accuracy.

## What it does

The statistical model computes the probabilities, the warehouse computes the metrics, server-side rules decide who may see and do what, and LLM agents only route questions, call governed tools and explain computed results ([ADR 0007](docs/adr/0007-numbers-come-from-tools.md)).

- **Forecasts by cohort.** Expected voluntary departures for a team or an organization over 1, 3 or 6 months, with 80% and 95% ranges beside the trailing-rate status quo. A deterministic pre-router refuses individual-level questions before any model call.
- **Explains the change.** An exact Shapley split of the change since the previous run into calendar, composition, input data, model and metric definition.
- **Holds bad data.** When a source fails its checks the candidate run is held and the published forecast does not move; a deterministic mapping fix waits for a Data Engineer, and a replay in a fresh warehouse reproduces the same business-result hash.
- **Governs actions.** Agents draft and people approve: nobody approves their own proposal (`SELF_APPROVAL`), every action is an entry in a hash-chained log, and rollback takes a reason.
- **Shows its evidence.** Pseudo-real-time backtests, calibration, coverage against nominal, a comparison with the trailing rate and a pre-registered study, including the results that count against it.

| Time | Read | You will see |
|---|---|---|
| 1 minute | the tour above and this list | what the product does |
| 5 minutes | [Walkthrough](#walkthrough-in-screenshots), [Results](#results-at-a-glance) | every beat, and how well it works |
| 30 minutes | [How it works](#how-it-works), [SPEC.md](SPEC.md), [ADRs](docs/adr/) | the design and its trade-offs |

## Walkthrough in screenshots

The public demo as a visitor sees it, taken by `npm run docs:screenshots`, which serves the public demo locally and clicks each beat of the guided tour in Chromium. Every number is synthetic, and every chat answer is a recorded Qwen3.6-27B turn replayed with its tools running live in the sandbox, or the labeled stub.

Click a screen to open it full size; [docs/PUBLIC-DEMO.md](docs/PUBLIC-DEMO.md#what-a-visitor-sees) describes each beat in full.

<table>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/03-forecast.png"><img src="docs/screenshots/03-forecast.png" alt="Forecast page: expected voluntary departures with 80% and 95% ranges and a recorded chat answer" width="100%"></a><br><b>1. Forecast</b><br>Ranges beside the trailing-rate status quo; every number in the chat links to its computed result.</td>
<td width="50%" valign="top"><a href="docs/screenshots/04-what-changed.png"><img src="docs/screenshots/04-what-changed.png" alt="What changed: a waterfall of five factors against the width of the 80% range" width="100%"></a><br><b>2. What changed</b><br>An exact Shapley split of the change since the previous run, against the width of the 80% range.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/05-data-health-held.png"><img src="docs/screenshots/05-data-health-held.png" alt="Data health: a held run, failed checks and the routine waiting for a person" width="100%"></a><br><b>3. Data health: held</b><br>A payroll file mixing annual and monthly pay fails the checks; the run is held and the published forecast stays.</td>
<td width="50%" valign="top"><a href="docs/screenshots/06-data-health-repaired.png"><img src="docs/screenshots/06-data-health-repaired.png" alt="Data health: the approved mapping fix, the repaired run published and its replay" width="100%"></a><br><b>3. Data health: repaired</b><br>A Data Engineer approves the mapping fix; the repaired run publishes and replays to the same hash.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/07-reviews-self-approval-refused.png"><img src="docs/screenshots/07-reviews-self-approval-refused.png" alt="Reviews: a self-approval refused with SELF_APPROVAL" width="100%"></a><br><b>4. Reviews: refused</b><br>Approving your own submission is refused with <code>SELF_APPROVAL</code>, and the refusal is logged.</td>
<td width="50%" valign="top"><a href="docs/screenshots/08-reviews-approved-and-rolled-back.png"><img src="docs/screenshots/08-reviews-approved-and-rolled-back.png" alt="Reviews: approved, rolled back, and the verified audit chain" width="100%"></a><br><b>4. Reviews: approved</b><br>A second lead approves, which creates owned tasks; rollback takes a reason and deletes nothing.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/09-trust.png"><img src="docs/screenshots/09-trust.png" alt="Trust page: backtests, reliability, coverage and the model comparison" width="100%"></a><br><b>5. Trust</b><br>Backtests, the reliability diagram, coverage against nominal and the model comparison.</td>
<td width="50%" valign="top"><a href="docs/screenshots/10-research.png"><img src="docs/screenshots/10-research.png" alt="Research page: the pre-registered hypotheses and their verdicts" width="100%"></a><br><b>6. Research</b><br>The pre-registered benchmark: which data problems the ranges survive, with each verdict.</td>
</tr>
</table>

**The boundary.** Asking which engineers in a team are most likely to leave is refused by a deterministic pre-router before any model call: there is no individual score to show.

<details>
<summary><b>Seven more screens</b>: start page, guided tour, Scenario Lab, Workforce, Governance, Memory, Traces</summary>

<table>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/01-landing.png"><img src="docs/screenshots/01-landing.png" alt="The public demo's start page with a role picker" width="100%"></a><br><b>Start</b><br>Two sentences on what this is, a role picker and a private sandbox that resets after 4 hours.</td>
<td width="50%" valign="top"><a href="docs/screenshots/02-guided-tour.png"><img src="docs/screenshots/02-guided-tour.png" alt="The guided tour panel listing the eleven beats" width="100%"></a><br><b>Guided tour</b><br>The eleven beats in order, each with what to look at and the role to see it as.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/11-scenario-lab.png"><img src="docs/screenshots/11-scenario-lab.png" alt="Scenario Lab: a replayed session of synthetic personas" width="100%"></a><br><b>Scenario Lab</b><br>Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated.</td>
<td width="50%" valign="top"><a href="docs/screenshots/12-workforce.png"><img src="docs/screenshots/12-workforce.png" alt="Workforce page: flows over 12 months and a funnel plot" width="100%"></a><br><b>Workforce</b><br>Where a cohort's people came from and went, and a funnel plot for groups of 50 or more.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/13-governance.png"><img src="docs/screenshots/13-governance.png" alt="Governance page: the action audit, roles and disclosure rules" width="100%"></a><br><b>Governance</b><br>The action audit against the four-fifths line, the roles and scopes, and the disclosure rules.</td>
<td width="50%" valign="top"><a href="docs/screenshots/14-memory.png"><img src="docs/screenshots/14-memory.png" alt="Memory page: search, notes and the commit log" width="100%"></a><br><b>Memory</b><br>The agent's git-style Markdown memory: what was decided, and the commits this sandbox wrote.</td>
</tr>
<tr>
<td width="50%" valign="top"><a href="docs/screenshots/15-traces.png"><img src="docs/screenshots/15-traces.png" alt="Traces page: spans of one chat answer as a gantt" width="100%"></a><br><b>Traces</b><br>Each answer's spans: the pre-router, the tool calls, the replayed recording and the grounding check.</td>
<td width="50%" valign="top"><br><b><a href="https://staysignal-demo.nitish-ratakonda.workers.dev">Open the live demo</a></b><br>The same screens in a private sandbox of your own, with no account.</td>
</tr>
</table>

</details>

## Results at a glance

Every number here comes from a result file a repository script wrote, with its command and date. The table below is generated by `npm run results:readme` and checked by `npm test`; every table, and three more charts, are in [docs/RESULTS.md](docs/RESULTS.md).

<!-- results:start -->
_Synthetic world: these numbers test the pipeline and the uncertainty method, not real-world accuracy._

| Question | Result | Command | Recorded |
|---|---|---|---|
| Are planted data faults caught before they publish? | 25 of 25 detected, root ranked first in 25; 20 held (duplicates only warn) | `uv run --project engine staysignal eval dq-faults` | [2026-10-13](results/dq-faults-2026-10-13.json) |
| Do the 80% ranges hold? | organizations 76.6% to 89.3%, company 31.3% to 57.9% of mature windows (nominal 80%) | `uv run --project engine staysignal eval backtest` | [2026-10-12](results/backtest-2026-10-12.json) |
| Does it beat the trailing rate? | company: no, skill -15.1% to -2.0%; organizations: about even, -0.7% to 3.8% | `uv run --project engine staysignal eval backtest` | [2026-10-12](results/backtest-2026-10-12.json) |
| Does the estimator recover a known truth? | 33 of 34 slopes inside their 95% intervals (Wald p = 0.876); with team shocks 32 of 34 (p = 0.386) | `uv run --project engine staysignal eval recovery` and `recovery-shock` | [2026-10-12](results/recovery-2026-10-12.json), [2026-10-13](results/recovery-shock-2026-10-13.json) |
| Which pre-registered hypotheses held? | H3a and H3b consistent; H1, H2 and H4 count against; H5 descriptive | `uv run --project engine staysignal research run --seeds 1-20` | [2026-10-13](results/research-2026-10-13.json) |
| Do the guardrails hold on a small local model (Qwen3-1.7B)? | 0 of 30 injections succeeded; 40 of 40 refusals correct; routing 51.7% | `npm run eval:agent -- --model llama` | [2026-10-13](evals/results/agent-llama-2026-10-13.json) |
<!-- results:end -->

Skill is the reduction in count error against the trailing rate, so above 0 beats it. Every chart below is drawn from the same files by `npm run docs:figures`, follows your light or dark theme, and names its command, date and file.

<table>
<tr>
<td colspan="2">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/backtest-company-3m-dark.svg"><img alt="Company 3-month backtest: forecast ranges, the forecast, the trailing rate and observed departures at each monthly origin" src="docs/images/figures/backtest-company-3m-light.svg" width="100%"></picture>
<br><sub>Model and data as known at each origin, scored against what happened. Company ranges are too narrow (see the limits below).</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/coverage-dark.svg"><img alt="How often the 80% and 95% ranges held, by level and horizon, against nominal" src="docs/images/figures/coverage-light.svg" width="100%"></picture>
<br><sub>Organization ranges sit near nominal; company ranges fall short.</sub>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/model-vs-trailing-dark.svg"><img alt="Count error of the model, the trailing rate and the oracle by horizon, for the company and for organizations" src="docs/images/figures/model-vs-trailing-light.svg" width="100%"></picture>
<br><sub>The oracle knows the hidden truth, so its error is a floor no model can reach.</sub>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/dq-faults-dark.svg"><img alt="Planted data faults detected before publishing, earlier and latest benchmark run" src="docs/images/figures/dq-faults-light.svg" width="100%"></picture>
<br><sub>Three phase-2 checks closed the gaps the first run found.</sub>
</td>
<td width="50%" valign="top">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/agent-eval-dark.svg"><img alt="Share of agent eval questions handled correctly by category, on a small local model" src="docs/images/figures/agent-eval-light.svg" width="100%"></picture>
<br><sub>The guardrails are server-side, so they hold even when a small model routes poorly.</sub>
</td>
</tr>
<tr>
<td colspan="2">
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/figures/research-dark.svg"><img alt="Pre-registered study: observed over expected and 80% coverage with seed intervals against the registered equivalence bounds" src="docs/images/figures/research-light.svg" width="100%"></picture>
<br><sub>Decided by rules registered before any run, including the verdicts that count against the hypotheses.</sub>
</td>
</tr>
</table>

> [!NOTE]
> **Limits, stated plainly.**
> - **Company ranges are too narrow.** Company 80% ranges held 31% to 58% of mature windows, organizations 77% to 89% ([backtest](results/backtest-2026-10-12.json)).
> - **Why: one shared shock, estimated from few windows.** The organization-wide shock is estimated at 0.06 from 11 quarterly windows ([model.json](models/m2026.09/model.json)) against the generator's 0.20 ([spec.py](engine/src/staysignal/world/spec.py)); reported, not tuned away (SPEC 9.3).
> - **No gain over the trailing rate at company level**, and about even for organizations. The oracle's lower error is an unattainable floor: it knows the hidden propensities.
> - **Departures run below forecast late in the window.** Observed over expected is 0.77 to 0.92 for the model and both baselines while the oracle sits at 0.90 to 1.03 ([comparison](results/model-comparison-2026-10-12.json)): the generator's drift lowers departures in the last quarters, which no model trained on the past can see.
> - **Few independent windows.** Overlapping monthly windows overstate the evidence (19 windows, 6 independent at 3 months for the company), so read single coverage figures with that in mind.
> - **Modest individual signal by design.** HR-system features cannot see job search or withdrawal; individual predictions are spread too wide, though the calibration index stays small (ICI 0.7 percentage points, [calibration](results/calibration-2026-10-12.json)).
> - **The small local model is a weak router.** Qwen3-1.7B routes 51.7% of questions correctly and over-refuses out of scope (precision 0.30, [agent eval](evals/results/agent-llama-2026-10-13.json)); the demo replays recorded Qwen3.6-27B turns.

## How it works

A React app talks to one Cloudflare Worker; a Python engine builds the warehouse and fits the model locally, and the public demo and CI serve fixtures exported from it.

```mermaid
flowchart LR
  subgraph Browser
    UI["React 19 app"]
  end
  subgraph Worker["Cloudflare Worker"]
    API["Hono API<br/>job queue"]
    AA["AnalystAgent<br/>chat"]
    WA["WorkspaceAgent<br/>runs, approvals, action log"]
    WF["RoutineWorkflow<br/>hold, repair, publish"]
    REG["Governed tools<br/>authorize, suppress, round"]
  end
  subgraph Served["Data and model text"]
    FIX[("Committed fixtures<br/>public demo and CI")]
    LLM["Model<br/>recorded turns, local Qwen or stub"]
  end
  subgraph Engine["Python engine, local only"]
    RUN["Runner"]
    WH[("dbt on DuckDB")]
    MOD["Competing-risks model"]
  end
  UI <-->|WebSocket| AA
  UI <-->|WebSocket| WA
  UI -->|HTTP| API
  AA --> REG
  AA --> LLM
  WA --> WF
  REG -->|fixtures mode| FIX
  REG -->|engine mode| WH
  API <-.->|lease and complete jobs| RUN
  RUN --> WH
  RUN --> MOD
```

1. **Sources land once.** `staysignal ingest land` validates each extract against its schema and stores it content-addressed and read-only; a re-delivery appends nothing.
2. **The warehouse builds as of a cutoff.** dbt on DuckDB with versioned mappings over bitemporal records, then point-in-time features as known at each cutoff.
3. **The model forecasts with honest ranges.** A discrete-time competing-risks model (voluntary, involuntary, retirement) with team-clustered uncertainty and shared shocks for the 80% and 95% ranges ([ADR 0004](docs/adr/0004-discrete-time-competing-risks.md)).
4. **A gate decides what publishes.** A failing check holds the run, a change beyond tolerance waits for approval, and a published run replays to the same hash ([ADR 0005](docs/adr/0005-publication-gate.md)).
5. **Agents explain, people approve.** The chat calls governed tools that authorize, suppress and round; a number that does not match a tool result fails the grounding check and the answer falls back to a template; agents draft and people approve ([ADR 0006](docs/adr/0006-agents-draft-humans-approve.md), [ADR 0007](docs/adr/0007-numbers-come-from-tools.md)).

### From sources to a published forecast

```mermaid
flowchart LR
  SRC["HRIS, payroll,<br/>ATS, org"] --> LAND[("Landing")]
  LAND --> STG["dbt staging,<br/>versioned mappings"]
  STG --> FEAT["Point-in-time<br/>features"]
  FEAT --> MOD["Competing-risks<br/>model"]
  MOD --> CAND["Candidate<br/>run"]
  STG --> CHK{"Checks"}
  CHK --> GATE{"Publication<br/>gate"}
  CAND --> GATE
  GATE -->|pass| PUB["Published"]
  GATE -->|check fails| HOLD["Held for<br/>review"]
  GATE -->|beyond tolerance| WAIT["Waits for<br/>approval"]
```

### Holding and repairing a bad payroll file

```mermaid
sequenceDiagram
  autonumber
  participant S as Payroll extract
  participant W as RoutineWorkflow
  participant E as Engine jobs
  participant A as Specialist agents
  actor D as Data Engineer
  S->>W: arrives with a new pay-basis code
  W->>E: ingest, run checks, score a candidate run
  E-->>W: pay checks fail
  W->>W: gate holds the run, published forecast unchanged
  W->>A: data quality, model and composition reports
  W->>E: propose a mapping fix from the evidence
  E-->>W: deterministic mapping proposal
  D->>W: approves (an agent cannot)
  W->>E: rebuild under the new mapping, re-check, compare
  E-->>W: checks pass, change within tolerance
  W->>W: publish a new version beside the old one
  W->>E: replay in a fresh warehouse
  E-->>W: identical business-result hash
```

In the public demo the engine's job results were recorded from the engine; the workflow, its gates, the approval and the audit run live in the visitor's sandbox.

### Approving a review

```mermaid
stateDiagram-v2
  direction LR
  state "Rolled back" as RolledBack
  [*] --> Draft: lead asks the chat to prepare it
  Draft --> Submitted: lead submits
  Submitted --> Approved: a different lead approves
  Submitted --> Rejected: rejected
  Approved --> RolledBack: rollback with a reason
  note left of Submitted: the same lead approving is refused with SELF_APPROVAL and logged
  note right of Approved: creates owned tasks with evidence
```

Every transition, refusals included, is a new entry in the hash-chained action log; nothing is edited or deleted.

### What runs where

Every local stand-in is labeled ([full matrix](docs/DEVELOPMENT.md#what-runs-where-in-full)).

| Concern | Public demo (live) | Local | Production design (not deployed) |
|---|---|---|---|
| App and API | Worker on Workers Free | wrangler dev | Worker behind Cloudflare Access |
| Sign-in | signed sandbox cookie, 4 hours | dev keys, role switcher | Access one-time PIN |
| Data | committed fixtures | dbt on DuckDB, or fixtures | dbt on BigQuery, never run |
| Engine jobs | results recorded from the engine | Python runner, computed live | runner on the operator's Mac |
| Chat model | recorded Qwen3.6-27B turns, or stub | local Qwen, recordings, or stub | Workers AI via AI Gateway, best effort |
| Memory | git-style store in SQLite | a real git repository | git-style history, not git |
| MCP | off (404) | dev token | Access service token |

<details>
<summary><b>Connect an MCP client</b></summary>

`/mcp` serves the governed read tools and `prepare_review` to MCP clients under the same permissions as the chat; no approval, submission, rollback or mapping action is exposed.

Locally, sign in with a dev token (`GET /dev/login?principal=pa-analyst@larkspur.example` on localhost) and send it as `Authorization: Bearer <token>`. In the production design, Cloudflare Access protects `/mcp` and a client uses an Access service token through `mcp-remote`:

```sh
npx mcp-remote https://<worker-host>/mcp --header "CF-Access-Client-Id:${CF_ACCESS_CLIENT_ID}" --header "CF-Access-Client-Secret:${CF_ACCESS_CLIENT_SECRET}"
```

The public demo answers 404 at `/mcp`. Details are in [docs/runbooks/prod-setup.md](docs/runbooks/prod-setup.md#mcp-clients-in-production).

</details>

## Research basis

StaySignal is a methods project on synthetic data, built on published turnover and forecasting research, with a pre-registered simulation study of its own. It is not empirical research on real employees.

- **Features follow the turnover literature.** Direction from published studies, size from the synthetic generator: tenure and pay (Rubenstein et al. 2018), relative pay (Card et al. 2012), manager changes (Ballinger, Lehman and Schoorman 2010), coworker departures (Felps et al. 2009) and reorganization (Trevor and Nyberg 2008).
- **Why no performance data?** Ratings are excluded by design (ADR 0015 in [SPEC.md](SPEC.md) section 2): rater bias, the curvilinear performance-turnover relationship (Trevor, Gerhart and Boudreau 1997), and the risk of steering decisions about individuals.
- **A pre-registered study.** [research/PREREGISTRATION.md](research/PREREGISTRATION.md) was locked by its SHA-256 before any run. It asks how late HR corrections, a missing extract, duplicates and shared team shocks affect calibration, and which handling restores it.

The full page is [docs/research-basis.md](docs/research-basis.md); about 55 verified references are in SPEC.md section 28.

## Responsible use

- **Cohorts only.** No individual risk score, ranking, list or timeline appears in any UI, API response, tool result, log or memory file, and individual predictions are never stored ([ADR 0001](docs/adr/0001-cohort-only-outputs.md)).
- **Small cells are protected.** Cohorts under 10 people are suppressed, values are rounded by cohort size, and comparisons over time need 50 people or more.
- **Residual risk.** Many queries across many runs can still narrow one person's contribution; closing that needs query auditing or noise, which are out of scope.
- **Actions are audited.** Approved reviews are screened for adverse impact by proxy groups (four-fifths rule of thumb, Fisher's exact test). Separation of duties holds between principals; in the public demo one visitor switches between the seven synthetic principals.

No protected attribute, performance rating or monitoring data is used. See the [model card](docs/model-card.md), [regulatory notes](docs/regulatory-notes.md), [employee notice template](docs/employee-notice-template.md) and SPEC.md section 17; this is not legal advice.

## Status

● Live in the public demo · ◆ Done, runs locally and in CI · ◐ Partial · ○ Designed, not deployed. Detail for every area is in [docs/STATUS.md](docs/STATUS.md).

| Area | State | Detail |
|---|---|---|
| [Public demo](docs/STATUS.md#public-demo) | ● Live | since 2026-10-15, a private sandbox per visitor |
| Forecast, What changed, Trust, Research | ● Live | from fixtures exported from the synthetic warehouse |
| [Data health: hold, repair, replay](docs/STATUS.md#warehouse-and-data-quality) | ● Live | workflow live; engine job results recorded |
| [Reviews, approvals, audit log](docs/STATUS.md#worker-agents-workflows-and-approvals) | ● Live | `SELF_APPROVAL`, rollback, hash chain |
| Chat with governed tools | ● Live | recorded Qwen3.6-27B turns or the labeled stub |
| [Scenario Lab](docs/STATUS.md#scenario-lab) | ◐ Partial | recorded sessions on a compact plan; not a forecast, not validated |
| [Synthetic world, warehouse, model](docs/STATUS.md#synthetic-world) | ◆ Local | seeded, pinned by SHA-256, CI regenerates on Linux |
| [Data-quality checks](docs/STATUS.md#warehouse-and-data-quality) | ◐ Partial | phase 1 plus F04, R02, R04; nine phase-2 checks not built |
| [Evaluation and research study](docs/STATUS.md#research-benchmark) | ◆ Local | recorded in `results/` |
| [Agent evals](docs/STATUS.md#agent-evals) | ◐ Partial | stub run in CI; Qwen3-1.7B run recorded; 27B run waits |
| MCP server | ◆ Local | same permissions as the chat; off in the public demo |
| [Production (Access, BigQuery, Workers AI)](docs/STATUS.md#production-path) | ○ Not deployed | dry runs and plan-only commands, tested against fakes |

## Run it locally

Needs Node 24 or later. This path uses committed fixtures and a scripted stub model: no Python, no model weights and no cloud account.

```sh
npm ci                 # dependencies
npm run dev:keys       # local dev keys in .dev.vars (gitignored)
npm run dev:wrangler   # builds the app and serves it on http://127.0.0.1:8795 (fixtures, stub model)
npm run stop           # stops every process the repository started
```

The engine path (uv, Python 3.12, a local DuckDB warehouse), the tests and checks, the public demo locally and recorded demo turns are in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documentation

- **Design:** [SPEC.md](SPEC.md), [CONTEXT.md](CONTEXT.md) (the domain glossary), [ADRs](docs/adr/), [research basis](docs/research-basis.md).
- **Evidence:** [docs/RESULTS.md](docs/RESULTS.md), [model card](docs/model-card.md), [pre-registration](research/PREREGISTRATION.md).
- **Governance:** [regulatory notes](docs/regulatory-notes.md), [employee notice template](docs/employee-notice-template.md), [data dictionary](docs/data-dictionary.md).
- **Running it:** [development](docs/DEVELOPMENT.md), [demo script](docs/demo-script.md), [public demo](docs/PUBLIC-DEMO.md), [production setup](docs/runbooks/prod-setup.md).
- **Tracking:** [status](docs/STATUS.md), [PROGRESS.md](PROGRESS.md), [reuse from other repositories](docs/REUSE.md), [NOTICE](NOTICE).

## License

MIT. See [LICENSE](LICENSE), and [NOTICE](NOTICE) for attributed reuse (listed in [docs/REUSE.md](docs/REUSE.md)).
