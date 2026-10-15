# ADR 0018: Public demo mode

Status: accepted (2026-10-15)

## Context
Recruiters and hiring managers should be able to open one public link and click through the whole product. The deployed paths sit behind Cloudflare Access, and dev sign-in works only on localhost. A public link means untrusted visitors on the operator's Workers Free account, which four other repositories share: no model may be called, no real data path may be reachable, every visitor's actions must stay private to that visitor, and cost and storage must be bounded by arithmetic rather than hope.

## Decision
1. **A third auth mode.** `SS_AUTH_MODE=demo` is accepted only with `SS_PUBLIC_DEMO=1` and the secret `SS_DEMO_SIGNING_KEY` (base64 of at least 32 random bytes); `SS_PUBLIC_DEMO=1` is refused with any other auth mode. Demo mode also refuses every real data path: a data mode other than `fixtures`, the BigQuery variables and key, `SS_LLM=workers-ai`, the AI Gateway variables and token, an `AI` binding, runner and MCP tokens, Access variables and role bindings. When any rule fails, `parseConfig` throws and the Worker answers 503 to every request. Engine jobs complete inline from the committed job fixtures; the model provider is `recorded`.
2. **Sign-in.** A landing page explains the demo in two sentences; the visitor picks one of the seven synthetic principals (default People Analytics Lead). `POST /demo/session` creates a sandbox and sets the cookie `ss_demo` (`HttpOnly; Secure; SameSite=Lax; Path=/`): `v1.<payload>.<mac>`, where the payload holds the principal ID, the sandbox ID, issued and expiry times, and the MAC is HMAC-SHA256 under a key derived by HKDF from the signing key. Every request verifies it with a constant-time comparison; the expiry is at most 4 hours after issue and never later than the sandbox's. Roles and scopes come from `policy/` on the server, never from the cookie, so editing the payload cannot raise a role. `POST /demo/role` re-issues the cookie for another principal in the same sandbox with the same expiry; `POST /demo/reset` starts a fresh sandbox and retires the old one. Mutating requests must also come from the same origin.
3. **Isolation.** A sandbox ID is 20 base32 characters (100 random bits). All mutable state lives in the WorkspaceAgent `sbx-<id>`: runs and the published pointer, reviews, approvals, both audit chains, routine and held-run state, engine jobs, results, drafts, traces and memory writes. Chat history lives in AnalystAgent `an_` + HMAC of the sandbox and principal IDs. Workflow instance IDs carry the sandbox name and the workflow only talks to the agent that started it. Each sandbox starts from the committed demo state (API fixtures, recorded turns, recorded Lab sessions), bundled read-only. An alarm at the expiry destroys each sandbox object (`deleteAll`); a sandbox object woken after that (a late workflow step) seeds nothing and destroys itself two minutes later.
4. **Off in demo mode (404):** `/mcp`, `/dev/*`, `/api/dev/*`, `/internal/*` (runner protocol and fixture jobs), live LLM providers, Workers AI, AI Gateway and the engine.
5. **Chat.** Recorded Qwen3.6-27B turns replay for the recorded questions; any other question gets the deterministic stub (one tool chosen by rules, a template answer from its result, no model), and the answer's chip says which. The provenance line names "the author's laptop".
6. **Caps** (constants in `src/shared/demo/budget.ts`): new sandboxes per client per hour and per UTC day overall, live sandboxes, request units per sandbox per minute and per lifetime, one routine run per sandbox, request bodies of at most 8 KiB, questions of at most 500 characters, reasons of at most 300, WebSocket frames of at most 64 KiB and 20 per minute per connection. Over a cap the answer is 429 or 503 with "The demo is busy, try again later" and `Retry-After`. Creation counts live in one `DemoGate` Durable Object (SQLite), keyed by an HMAC of the client address (never the address itself) and pruned after 2 days. The per-minute window is kept in memory in the sandbox object, and the lifetime count is written every 25 units.

## Budget arithmetic
Workers Free, per account and UTC day (verified on developers.cloudflare.com, 2026-10-15): 100,000 Worker requests (Workflow executions included); Durable Objects 100,000 requests (incoming WebSocket messages at 20 to 1), 100,000 SQLite rows written (deletes count as writes) and 5 GB stored; 100 concurrent Workflow instances. Static asset requests are free. The demo plans for half of each daily allowance, because the account is shared.

A request costs units: a read 1, a write (POST) 8, a chat turn 4, the routine 80; a sandbox has 600 units. The measured upper bounds, asserted by `test/worker-public-demo/budget.test.ts`, are 5 Durable Object requests per unit, 2 rows written per unit, 300 rows written to seed a sandbox and 2 MiB stored per sandbox.

| Daily quantity | Bound | Demo budget |
|---|---|---|
| Worker requests | 15 sandboxes x 600 units = 9,000, plus 3 sign-in requests per sandbox | 50,000 |
| Durable Object requests | 15 x 600 x 5 = 45,000, plus 2 gate calls per sandbox | 50,000 |
| Rows written | 15 x 2 x (300 + 600 x 2) = 45,000 (the factor 2 counts the deletion at expiry) | 50,000 |
| Stored bytes at any time | 10 live sandboxes x 2 MiB = 20 MiB | 1 GiB |
| Concurrent Workflow instances | 10 live sandboxes x 1 routine = 10 | 50 |

`test/node/demo-budget.test.ts` recomputes this table from the constants and fails if any bound exceeds its budget.

## Consequences
On a busy day visitors see "The demo is busy, try again later"; raising a cap means changing the constants and passing the arithmetic test. Residual risks, stated in the README: requests without a valid cookie still count toward the account's daily Worker requests (Cloudflare answers error 1027 when they run out, for every Worker on the account), and workers.dev hostnames get no WAF rate-limiting rule; the per-minute window restarts when a sandbox object is evicted; the 10 ms CPU limit per invocation is not enforced by `wrangler dev`, so chat turns and investigation steps are best effort, as in the fixtures deployment. One visitor drives every role, so separation of duties is shown between principals, not between people.
