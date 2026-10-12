# ADR 0006: Agents draft, humans submit and approve

Status: accepted (2026-10-12)

## Context
Agents prepare reviews and propose fixes quickly, but an action that changes what people see or do needs a human who is accountable for it, and separation of duties needs two different humans.

## Decision
A human who submits or adopts an agent draft becomes its proposer of record. The approver must be a different human who holds the subject's scope (`review:approve`, `publish:approve`, `mapping:approve`). Agents never approve. The rule is checked in the callable method and again in the workflow step after the gate wakes, and every refusal is audited with a code (`SELF_APPROVAL`, `WRONG_ROLE`, `AGENT_PRINCIPAL`, `STALE_SUBJECT`).

One documented exception: a payroll or HRIS mapping change proposed by the investigation, with the agent as proposer of record, is approved by a single human with `mapping:approve`. The mapping itself is generated deterministically from evidence, never by an LLM; the change is a reversible pointer; it is replay-verified; and every publication it leads to still passes the publication gate.

## Consequences
The demo shows a refused self-approval and a second approver. In production all demo principals are the operator's plus-addressed mailboxes, so the README says separation of duties is enforced between principals and the demo has one operator.
