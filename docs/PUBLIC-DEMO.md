# Public demo

**Live at https://staysignal-demo.nitish-ratakonda.workers.dev since 2026-10-15**: a public link anyone can click through, with no account. The design is [ADR 0018](adr/0018-public-demo-mode.md); the caps and the budget arithmetic are there.

The landing page explains that the company and every number are synthetic and that the chat replays recorded model output. The visitor picks a role and gets a private sandbox of the whole product that resets after 4 hours. It runs on Cloudflare Workers Free with no Access, no AI binding, no AI Gateway, no BigQuery, no runner and no MCP.

## Contents

- [What a visitor sees](#what-a-visitor-sees)
- [Run it locally](#run-it-locally)
- [Deploying it (the repository owner)](#deploying-it-the-repository-owner)
- [Deploy check, 2026-10-15](#deploy-check-2026-10-15)
- [Limits and risks](#limits-and-risks)

## What a visitor sees

The README's [walkthrough in screenshots](../README.md#walkthrough-in-screenshots) shows each beat; this is the longer description of each. The screenshots are taken by `npm run docs:screenshots`, which serves the public demo locally and clicks each beat of the guided tour in Chromium, as a visitor would. Larkspur Systems is fictional, every number is synthetic, and every chat answer is a recorded Qwen3.6-27B turn replayed with its tools running live in the sandbox over results exported from the synthetic warehouse, or the labeled stub.

- **Start** ([screenshot](screenshots/01-landing.png)). Two sentences on what this is, a role picker and a private sandbox that resets after 4 hours.
- **The guided tour** ([screenshot](screenshots/02-guided-tour.png)) lists the eleven beats in order, each with one line on what to look at and the role it is best seen as; a banner on every page says this is a public demo and when the sandbox resets.
- **1. Forecast** ([screenshot](screenshots/03-forecast.png)). Expected voluntary departures for Engineering over 3 months with 80% and 95% ranges, beside the trailing-rate status quo, a trust strip and the backtests. The chat answer is a replayed recorded turn: its numbers are placeholders filled from the computed results (each a link to one), and its chips say it passed the numeric grounding check and where it was recorded.
- **Boundary.** Asking which engineers in a team are most likely to leave is refused by a deterministic pre-router before any model call: there is no individual score to show.
- **2. What changed** ([screenshot](screenshots/04-what-changed.png)). The change since the previous run, split exactly (Shapley) into calendar, composition, input data, model and metric definition, drawn against the width of the 80% range.
- **3. Data health** ([held](screenshots/05-data-health-held.png), [repaired](screenshots/06-data-health-repaired.png)). A simulated payroll extract mixes annual and monthly pay under a new pay-basis code. Checks fail upstream of the forecast features, lineage traces the bad column, three specialist agents report (in the public demo each report is a template filled from its tool results; no model runs), and the candidate run is held: the published forecast does not move. Acting as the Data Engineer, the visitor approves the mapping fix that a deterministic generator built from the evidence. The routine rebuilds under the approved mapping, publishes the repaired run within tolerance, and a replay in a fresh warehouse reproduces the same business-result hash. In the public demo the engine's jobs (checks, scoring, the rebuild and the replay) return results recorded from the engine on the author's laptop, as the page says; the workflow, its gates, the approval and the audit chain run live in the visitor's sandbox. Locally, `npm run dev:engine` computes every job live.
- **4. Reviews** ([refused](screenshots/07-reviews-self-approval-refused.png), [approved and rolled back](screenshots/08-reviews-approved-and-rolled-back.png)). The lead asks the chat to prepare a People Partner review for Platform Engineering and submits it; approving one's own submission is refused with `SELF_APPROVAL`, and the refusal is written to the hash-chained audit log. The People Operations Director approves, which creates owned tasks (the compensation task carries a pay-equity blocking item), then rolls the approval back with a reason. Nothing is deleted: each action is a new entry, and the chain verifies.
- **5. Trust** ([screenshot](screenshots/09-trust.png)). Why the forecast deserves trust: pseudo-real-time backtests, the reliability diagram, coverage against the nominal 80% and 95%, and the model comparison.
- **6. Research** ([screenshot](screenshots/10-research.png)). The pre-registered benchmark on 20 synthetic worlds: which data problems the intervals survive, with each hypothesis's verdict.
- **7. Scenario Lab** ([screenshot](screenshots/11-scenario-lab.png)). Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated. Synthetic personas react to a proposed change on a simulated forum, replayed from sessions recorded from Qwen3.6-27B.
- **8. Workforce** ([screenshot](screenshots/12-workforce.png)). Where a cohort's people came from and went over 12 months, and a funnel plot of observed over expected departures for groups of 50 or more.
- **9. Governance** ([screenshot](screenshots/13-governance.png)). The action audit of approved reviews (impact ratios by proxy screens against the four-fifths line), the roles and their scopes, and the disclosure rules.
- **10. Memory** ([screenshot](screenshots/14-memory.png)). The agent's git-style Markdown memory, as the People Analyst: search for what was decided, the notes, and the commits the routine and the approvals in this sandbox wrote.
- **11. Traces** ([screenshot](screenshots/15-traces.png)). Each chat answer's spans: the pre-router, the tool calls, the replayed recording, the grounding check and their timings.

The README's guided-tour animation (`docs/images/tour.gif`, with a still poster for reduced motion) is made from six of these screenshots by `npm run docs:tour`.

## Run it locally

```sh
npm run dev:public-demo        # the public demo locally (ADR 0018): built app on 8795, a throwaway session key
npm run test:e2e:public-demo   # the guided tour in Playwright against wrangler dev over https (a CI step)
npm run docs:screenshots       # retakes docs/screenshots/*.png from the public demo served locally
npm run docs:tour              # rebuilds docs/images/tour.gif and tour-poster.png from those screenshots
npm run stop                   # stops every process the repository started
```

## Deploying it (the repository owner)

Builders deploy nothing; the repository owner deployed it with these steps from the repository root:

```sh
npx wrangler whoami                       # signed in to the account that owns the workers.dev subdomain; the dashboard's Workers plan reads Free
npm run deploy -- --demo --dry-run        # renders infra/cloudflare/wrangler.demo.template.jsonc, checks the Free-plan and demo rules, builds, wrangler deploy --dry-run with the 8 MiB check
openssl rand -base64 48 | npx wrangler secret put SS_DEMO_SIGNING_KEY --name staysignal-demo   # the session key (48 random bytes); creates the Worker if it does not exist yet
npm run deploy -- --demo --yes            # deploys the Worker staysignal-demo
npx wrangler tail staysignal-demo --format json   # in a second terminal, before sharing the link: sign in once and ask one recorded question
```

The demo is then at https://staysignal-demo.nitish-ratakonda.workers.dev. Before sharing the link:

1. Read the tail's events for the sign-in and the chat turn: each `outcome` should be `ok`, not `exceededCpu`, and `cpuTime` says how close each came to the per-invocation limit (ADR 0018, Consequences).
2. If the tail delivers no events (it can be unreliable on some networks), read the same a few minutes later from the Worker's Metrics in the dashboard (CPU time and errors) or the GraphQL Analytics API (`workersInvocationsAdaptive`, its `cpuTime` quantiles and `status`).
3. Check that `curl -sI https://staysignal-demo.nitish-ratakonda.workers.dev/` shows the `Content-Security-Policy` and `X-Frame-Options: DENY` that `public/_headers` sets on the static assets.

To end every session at once, set a new key with the same `wrangler secret put` command (the gate then counts only the new key's sandboxes). To take the demo down, `npx wrangler delete --name staysignal-demo`.

## Deploy check, 2026-10-15

The owner's check of the first deploy, run with the commands above and `wrangler tail` during one visit (sign-in, the recorded forecast question, the payroll simulation). It is recorded in [PROGRESS.md](../PROGRESS.md) ("2026-10-15 public demo deployed"), not in a result file: it is an operations check, not a StaySignal result.

- The landing page returned 200 with the `Content-Security-Policy`, `X-Frame-Options: DENY`, `nosniff` and `no-referrer` headers.
- `/mcp`, `/api/dev/*`, `/internal/*` and `/agents/*` returned 404, and the API without a session returned 401.
- The recorded turn replayed with its grounding check passed, and the routine held run `R-2026-10-01#2` at the gate.
- Of 99 invocations, 97 ended `ok` and 2 were WebSocket streams closed by page navigation; none ended `exceededCpu`.
- CPU time had a median of 2 ms; the stateless Worker requests reached 18 ms at most, and the Durable Object events reached 89 ms (AnalystAgent) and 22 ms (WorkspaceAgent).

## Limits and risks

- Each visitor gets one sandbox of 600 request units (the guided tour uses about 375); a sandbox that has used them says so and offers a fresh one.
- At most 3 new sandboxes per client an hour (an IPv6 client counts by its /64), 15 a UTC day and 10 live at once. Over a cap the landing page says the demo is busy, when to retry, and links the README's walkthrough in screenshots.
- These caps keep the demo inside half of each Workers Free daily allowance of the shared account, but they can be used up on purpose: a script from a few addresses can take the day's 15 sandboxes, and every later visitor sees "busy" until 00:00 UTC.
- Requests without a valid cookie touch no Durable Object, yet still count toward the account's 100,000 daily Worker requests; if a flood uses those up, Cloudflare answers error 1027 for every Worker on the account until the next UTC day.
- A workers.dev hostname gets no WAF rate-limiting rule (a custom domain on a free zone would allow one).
- A browser without `Sec-Fetch-Site` (Safari before 16.4) lets an image or navigation from a same-site page spend a unit per request (ADR 0018, decision 8).
- After the first visitors, compare the Worker's and the Durable Objects' daily usage in the dashboard (Workers & Pages, the Worker's Metrics; Durable Objects) with the ADR's table.
