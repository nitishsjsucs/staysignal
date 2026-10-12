# ADR 0001: Cohort-only outputs

Status: accepted (2026-10-12)

## Context
A departure forecast is computed per person and summed per cohort. Showing an individual probability, a ranked list or a person's timeline would turn workforce planning into a tool for individual decisions, which is out of scope, ethically risky and, in several jurisdictions, regulated profiling. Even aggregates leak individuals when cohorts are small or when two answers can be subtracted.

## Decision
Every result that crosses the engine boundary is a cohort aggregate with at least 10 people after primary and complementary suppression, disclosure rounding by cohort size and the population-change rule (SPEC 17.5). Comparisons over time (what changed, forecast history, backtest series, O/E overlays) are served only for cohorts of 50 or more. Team-level values are served only to the `people_analyst` role, never ranked or colored by risk, and carry "not an evaluation of the team's manager".

## Consequences
The tool layer, the published dbt models and the API contracts all enforce the minimum cell size, and tests scan every output schema for person-level fields. Some questions get a refusal code (`SMALL_COHORT`, `COMPLEMENT_RISK`, `DIFFERENCING_RISK`) instead of a number. Residual risk remains: many queries across many runs can still narrow one person's contribution; closing it needs query auditing or noise, which are out of scope and stated in the README.
