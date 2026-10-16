# Reuse from existing repositories

Code is copied from sibling repositories by the same author (MIT) and attributed in a header comment; nothing calls them at runtime. This table lists what has actually been copied so far and grows with each milestone (the full plan is [SPEC.md](../SPEC.md) section 19). The license and the attribution notice are in [LICENSE](../LICENSE) and [NOTICE](../NOTICE).

| Source | Copied | Adapted how |
|---|---|---|
| PeopleLake | `pipeline/src/peoplelake/prng.py`, `pipeline/src/peoplelake/canonical.py`, `src/worker/ingest/canonical-json.ts`, `src/worker/auth/access.ts`, `scripts/check-prose.ts`, `scripts/lib/prose.ts`, `scripts/lib/results.ts` | SplitMix64 streams (uniform, normal and lognormal draws and named streams added), canonical JSON in Python and TypeScript, Access JWT verification, the prose check with banned phrasing added |
| PeopleVault | `pipelines/src/peoplevault/pseudo.py`, `src/worker/pseudo/hmac.ts`, `src/worker/audit/audit-log.ts`, `scripts/lib/pids.ts`, `src/web/router.ts` | pseudonyms with StaySignal salts, the action log hash chain, process hygiene, the history router |
| PeopleLens | `worker/src/guard/disclosure.ts`, `worker/src/guard/suppression.ts` | rounding by cohort size and hidden-sum suppression |
| PeopleLens | `src/peoplelens/catalog/compiler.py`, `params.py`, `keys.py`, `parity.py`; the `pl_time` macro; the semantic-model layout | the MetricFlow catalog compiled ahead of time for DuckDB and BigQuery, the parameter contract with `__all__` filters and a server-bound scope, and parity against an independent reference |
| DataTrust | ADR-0001 (runner pull model); `packages/rca/src/summary/validate.ts`, `template.ts` and the grounded summary loop | the engine job protocol (ADR 0002) and numeric grounding with a template fallback (ADR 0007) |
| DataTrust | `dbt/macros/dialect/*`, `dbt/macros/print_dialect_macros.sql`, `pipelines/datatrust/dbt/dialect_check.py`, `pipelines/tests/test_dialect_macros.py`, `pipelines/datatrust/warehouse/readonly.py` | dialect macros for StaySignal's SQL, the banned-construct scan (extended) over an offline BigQuery compile, and the single-SELECT guard in front of the warehouse shim |
| onboardflow | `src/worker/workflows/gates.ts` and its ADR 0002 | workflow gates on Durable Object SQLite instead of D1 (ADR 0016) |

New in StaySignal: the action audit of approved reviews with proxy strength, the hazard-driven bitemporal world, the point-in-time features, the monthly flows model with its exact balance and the versioned metric definitions, the competing-risks model and its uncertainty, the evaluation, the change decomposition, the publication gate with deterministic repair and fresh-warehouse replay, the agents, workflows and approvals, the frontend, the public demo, and the charts and guided-tour animation of the README.
