# ADR 0003: Bitemporal source records

Status: accepted (2026-10-12)

## Context
HR data arrives late and is corrected after the fact: terminations recorded weeks after they happen, manager changes reverted, audit batches restating the past. A feature computed with today's knowledge of the past leaks the future into backtests and makes a forecast irreproducible.

## Decision
Every source record carries an effective date (valid time) and a `recorded_at` timestamp (knowledge time). Features at cutoff `c` are computed from the vintage `v`: only records with `recorded_at <= v` and effective dates before `c`, with corrections applied only if they are themselves visible at `v`. Backtests use `v = c`. The `as_of(vintage)` macro (copied from PeopleLake) filters the bitemporal intermediates.

## Consequences
Point-in-time features are testable with a no-lookahead property test: adding any record recorded after `v` or effective on or after `c` changes nothing. What changed can separate late data about the past from new events. Storage keeps every version; nothing is updated in place.
