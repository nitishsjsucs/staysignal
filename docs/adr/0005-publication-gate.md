# ADR 0005: Publication gate and pointer-based publishing

Status: accepted (2026-10-12)

## Context
A vendor file that silently changes units can move a forecast by a large amount. A People Partner must never see a number built on data that failed its checks, and a published number must be restorable after a mistake without losing what was shown before.

## Decision
A forecast run is published only if every error-severity check whose node is upstream of the run's features (in the lineage graph) passes; otherwise it is held with its would-be values, failing checks and incident. A change beyond tolerance (more than 15% of the company expected value, or 25% for any organization) also waits for a `publish:approve` approval. Publication is a pointer per scope; rollback moves the pointer back and appends a reversal entry. Nothing is deleted.

## Consequences
A held run can never be published without a new run (tested). Every version stays in the run history, and rollback is one click with a reason. The hold costs a delay when a check fires falsely; the incident shows which check and why.
