# StaySignal domain glossary

Single-context repository. These terms are used with these meanings in code, tests, docs and commit messages. Decisions live in `docs/adr/`.

## World and data

- **Larkspur Systems**: the fictional company (`larkspur.example`). Every person, team, record and proposal is synthetic and generated from a seed.
- **World**: the output of the seeded generator: source extracts, the audit-only attribute file, held-back future arrivals and the truth files. Profiles: `canonical` (the demo), `small` (tests and CI), `recovery` (estimator recovery), `research` (benchmark).
- **Source**: one of `hris`, `payroll`, `ats` (plus the organization tree `org` and reference bands `ref`). Generic names on purpose; no vendor product is simulated.
- **Extract**: one delivered source file. Landed immutably under its SHA-256.
- **Effective date** (valid time): when a fact is true in the business. **Recorded at** (knowledge time): when the source system recorded it.
- **Vintage** `v`: a knowledge time. A record is visible at `v` if `recorded_at <= v`.
- **Cutoff** `c`: 00:00 UTC on the first day of a month; the forecast date. Features use records effective before `c` and visible at `v`.
- **Spell**: one continuous employment period `[start_date, end_date)`. A rehire starts a new spell.
- **Correction**: a record that replaces the value of an earlier record (`corrects_record_id`). Only corrections visible at the vintage apply.
- **Late record**: a record whose `recorded_at` is well after its effective date (planted late terminations, the audit batch).
- **Conformed snapshot**: typed, deduplicated, pseudonymized staging records at a vintage, with source codes intact; replay can use it after raw files are deleted.
- **Pay basis**: the vendor code saying whether a payroll amount is monthly (`M`) or annual (`ANN`). A **mapping** turns codes into annualized pay; mappings are versioned (`payroll@1`, `payroll@2`).
- **Audit-only attribute**: the synthetic age-40-or-over flag, readable only by the action audit (ADR 0013).
- **Oracle**: a forward simulation of the generator from the true state at a cutoff; the unattainable floor for error and the reference for coverage.

## Forecasting

- **Departure**: the end of a spell. Causes: **voluntary**, **involuntary**, **retirement**. A transfer is not a departure.
- **Population** at `(c, v)`: people in a spell at the cutoff as known at the vintage, under a **metric definition** (`voluntary_departures@1` includes fixed-term employees, `@2` excludes them).
- **Horizon**: 1, 3 or 6 calendar months (about 30, 90 and 180 days). A question in days resolves to the nearest horizon.
- **Landmark**: a cutoff at which features are frozen; training stacks monthly landmarks into person-period rows.
- **Matured row**: a training row whose period ends at least 75 days before the training cutoff, so late records have arrived.
- **Cumulative incidence** `F_k(h)`: the probability of leaving by cause `k` within `h` months, accounting for the other causes.
- **Cohort**: a group of people defined by the semantic dimensions (organization, group, team for analysts only, job family, level band, tenure band, location). Never a person.
- **Expected departures**: the sum of the cohort's individual cumulative incidences. Individual values exist only in the scoring job's memory.
- **Shock**: a shared multiplier on the voluntary hazard for a team (per team and calendar quarter) or the whole company (per quarter); the reason intervals are wider than independence would suggest.
- **Forecast run**: one scoring of a cutoff and vintage with a model artifact, metric definition and mappings. Identified as `R-<cutoff>#<n>`; statuses `candidate`, `held`, `published`, `superseded`.
- **Run key**: SHA-256 of the run's canonical inputs; it seeds the Monte Carlo, so a rebuild gives the same intervals.
- **Business result hash**: SHA-256 of the canonical cohort table of a run; replay must reproduce it.
- **Published pointer**: which run is published. Publishing and rollback move the pointer; nothing is deleted.
- **Backtest**: a pseudo-real-time forecast made at a past origin with the model and data as known then, scored on mature windows. Not a forecast that was published.
- **What changed**: the exact Shapley decomposition of the difference between two runs into Calendar, Composition, Input data, Model and Definition.

## Governance

- **Principal**: an authenticated identity (a role mailbox such as `pa-lead@larkspur.example`, a service token, or the agent `agent:staysignal`).
- **Role** and **scope**: roles grant scopes (`forecast:read:all`, `review:approve`, ...); tools and actions require scopes.
- **Proposer of record**: the human who submits a draft or adopts an agent proposal. The approver must be a different human holding the subject's scope (`SELF_APPROVAL` otherwise).
- **Hold**: a candidate run is not published because an error-severity check upstream of its features failed.
- **Repair**: activating a new mapping version and rebuilding only the affected models.
- **Replay**: rebuilding a run in a fresh warehouse from landed files or a conformed snapshot and comparing its business result hash.
- **Action log**: the hash-chained, append-only record of every action, with daily **anchors** of its head written outside the Durable Object.
- **Disclosure rounding**: served expected values rounded to 0.1, 0.5 or 1 by cohort size.
- **Population-change rule**: a comparison of two populations is served only if the joiners plus leavers are 0 or at least 10.
- **Result**: any computed tool or API output, stored under a content-addressed `result_id`; narration cites results through per-turn aliases (`r1`, `r2`).
- **Grounding**: the check that every numeral and direction word in narration traces to a tool result; outcomes `passed`, `repaired`, `template`.
- **Routine**: an event-driven workflow (for example `source_arrival_refresh`) with declared scopes, approval checkpoints and reversible actions.
- **Gate**: a workflow wait whose truth lives in Durable Object SQLite; the event is only a wake-up (ADR 0016).

## Scenario Lab

- **Persona**: a synthetic forum participant built from a cohort cell of at least 10 people; never from an individual.
- **Hypothesis generation**: the Lab's only claim. It is not a forecast, not a survey and not validated, and never feeds forecasts or review evidence.
