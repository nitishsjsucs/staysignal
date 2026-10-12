# ADR 0002: Runner pull model for Python compute

Status: accepted (2026-10-12). Copied from DataTrust ADR-0001 (MIT), adapted for StaySignal.

## Context
The Worker runs on Workers Free: 10 ms of CPU per request and per Workflow step, 50 subrequests. Feature computation, model fitting, Monte Carlo and dbt builds take seconds to minutes and need Python. The Worker must not run numeric work, and production must not need an always-on server.

## Decision
A Python runner leases engine jobs from the WorkspaceAgent over outbound HTTPS (`POST /internal/runner/lease`, `heartbeat`, `complete`), with server-paced polling (`next_poll_ms`) and a 120-second lease. Jobs carry a deterministic key, so completing twice is a no-op. Completion writes the job row first and then sends the workflow wake-up. The same protocol runs locally (the runner is embedded in the FastAPI engine) and in production (the runner on the operator's Mac against BigQuery). `scripts/fixture-runner.ts` speaks it without Python for CI.

## Consequences
Workflow steps only enqueue and wait, so each fits the Free CPU budget. A crashed runner costs one lease expiry and a bounded wait that is recorded as `stalled`. Every poll is a Worker request, so polling backs off when idle and stops after 30 idle minutes.
