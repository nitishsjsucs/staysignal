# ADR 0007: Numbers come from tools

Status: accepted (2026-10-12). Pattern copied from DataTrust's grounded summary loop (MIT).

## Context
LLMs restate numbers wrongly, invent directions ("rose" for a fall) and round inconsistently. A planning number narrated wrongly is worse than no narration.

## Decision
The model never computes or types a number. Tools return results stored under content-addressed IDs; the model sees each result only through a digest under a per-turn alias (`r1`, `r2`) and writes placeholders such as `{{r1.expected|int}}`, which the server renders from the stored result. After the model finishes, a numeric-grounding check rejects any remaining numeral or direction word that does not trace to a tool result in this turn (identifiers, horizons and small array-length counts are allowed). On failure the model gets one repair attempt quoting the violations; if that fails, a deterministic template renders the answer from the tool results. Every message carries `grounding: passed | repaired | template`.

## Consequences
Every number in the UI links to the computed result that produced it. Some answers read as templates; the eval records how often. Memory notes must cite result IDs, so the rule covers memory too.
