# Demo script

The runbook for beats 1 to 5 of SPEC.md section 3, with exact clicks and a Q&A crib. Everything shown is the synthetic company Larkspur Systems; every number below was produced by this repository on the canonical world (seed 20261011) and is labeled synthetic in the app. Beat 6 of SPEC.md (the Scenario Lab with an interview) is not part of the 7-day variant; two optional beats after beat 5 show the Research page and the Scenario Lab page. Model text is recorded and replayed (see Before you start); every number is computed live.

## Before you start

The demo runs no model live. Every piece of model text on screen (chat answers, Scenario Lab sessions, persona interview answers) was recorded once from Qwen3.6-27B on this laptop and is replayed; the tools, warehouse queries and numbers still compute live from the local warehouse. Each replayed output carries the same line: "Recorded from Qwen3.6-27B on this laptop, <date>; replayed", followed by what is live ("Numbers compute live from the warehouse" in the chat). Say why if asked: the 27B needs about 16.6 GB of the 24 GB laptop, the measured cold time to the first token for the agent's tool prefix is 20 to 34 seconds, and the memory guard has stopped it on swap growth several times (README Results, the 27B measurement), so a live call in an interview is impractical. No model server is needed; start nothing with `npm run llm`.

```sh
npm run dev:keys                                            # once: local dev keys and the runner token
uv run --project engine staysignal engine prepare --fresh   # land the world, build the warehouse, publish the two runs
npm run demo:snapshots                                      # the per-beat snapshots under var/snapshots/ (rebuild after any change to main)
npm run demo:reset -- --beat 1                              # about 3 seconds: restore the start of beat 1 and start the demo profile
```

`npm run demo` and `npm run demo:reset` start the demo profile with `SS_DEMO=1`: the built app under wrangler dev with the local engine on 8196, and the recorded provider only, whatever `SS_LLM` says. They print what can be replayed, for example `chat turns 6 of 6 demo questions; Lab sessions from the 27B: infra-data-merge, promotion-criteria-third-window; interview answers: 2`. Open `http://127.0.0.1:8795` in a browser at 1440 x 900 and sign in with the role switcher as **People Analytics Lead (pa-lead)**.

In demo mode:

- The chat dock offers the recorded questions as chips. A question with no recording gets a short message saying the demo replays recorded answers, with the recorded questions as chips; it never falls back to a stub or template answer. The boundary question is refused before any model call, so it needs no recording.
- The Scenario Lab lists only sessions recorded from the 27B; the stub placeholder sessions used by CI are hidden. With none recorded, the page says so.
- The persona interview answers only the recorded questions (shown as chips); any other question gets a short message pointing at them.

To reset during the demo: `npm run demo:reset -- --beat N` (beats 1 to 3 start from the same state, beat 4 with the run held, beat 5 after the repair). A reset also copies the current Lab sessions, research run and action audit into the restored state, so snapshots built before a new recording still show it.

### Recording, once, before the interview day

Close other apps and run nothing heavy beside the 27B. Each step writes files that are committed after both hygiene tiers pass (the pre-commit hook scans every staged file).

```sh
npm run llm -- start 27b                     # the guarded 27B on 8186 (refuses below 17 GB available)

# 1. the chat turns: every question in demo/questions.json (each makes at least two 27B calls; allow about a minute each)
npm run dev:wrangler                         # fixtures mode on 8795, not demo mode
npm run demo:record -- --provider mlx        # --only beat-2-what-changed re-asks one; a turn that fails grounding is not written
npm run stop                                 # stops wrangler and the 27B; start the 27B again for step 2

# 2. the Scenario Lab sessions (about 300 calls each; a rerun after an interruption resumes from var/lab/cache)
npm run lab:record -- --proposal promotion-criteria-third-window --provider openai
npm run lab:record -- --proposal infra-data-merge --provider openai
uv run --project engine staysignal lab export && npm run fixtures:index

# 3. the persona interview answers: the engine streams from the 27B outside demo mode
SS_LLM=mlx npm run dev:engine                # then on the Lab page ask each interview question once
npm run stop
```

For step 3, copy each answer from `var/engine/work/lab/interviews.jsonl` into `lab/interviews.json` as `{ "proposal", "persona_id", "question", "answer", "model": "Qwen3.6-27B (mlx-community/Qwen3.6-27B-4bit, mlx_lm.server)", "recorded_at": "<date>" }`. Then `npm test` (recorded turns replay with live tools and must pass grounding), `uv run --project sim pytest sim/tests` (the new sessions replay to their hashes), `npm run demo:snapshots`, and `npm run demo:reset -- --beat 1`. Until a recording exists the demo still runs: the chat offers the recorded questions only and the Lab page says no session is recorded yet.

## Frame (0:00 to 0:10)

Say: "Cohort-level planning support for People Partners. No individual scores anywhere a person can see. A synthetic company."

## Beat 1, forecast (0:10 to 0:50)

1. Click **Ask** (top right) and click the chip (or send): *Forecast voluntary departures in Engineering over the next 90 days.*
2. The dock shows the `forecast departures` tool card and an answer whose numbers link to the computed result, with the chip "Recorded from Qwen3.6-27B on this laptop, <date>; replayed. Numbers compute live from the warehouse." The page follows to Engineering at 3 months: **13.1** expected voluntary departures, 80% range **8 to 18**, 95% range **6 to 22**, next to the trailing-rate status quo.
3. Point at the trust strip (backtest observed over expected, how often the 80% range held, data freshness, checks passing), the fan chart (6 months, 80% and 95% bands, Other exits as a grey line) and the backtest strip (quarterly pseudo-real-time backtests: model and data as known at each cutoff, not forecasts that were published).

Key point: "In non-overlapping quarterly backtests our 80% range held 5 of 7 times." For Engineering at 3 months the trust strip reads observed over expected **0.77** and the 80% range held **5 of 7** windows, with 14 of 14 checks passing; they are synthetic-world results.

## Boundary (0:50 to 0:55)

Send: *Which engineers in Platform Engineering are most likely to quit?* The answer is **Refused: INDIVIDUAL_LEVEL**, refused before any model call, and the refusal is audited. Say: "There is no individual score to show."

## Beat 2, what changed (0:55 to 1:30)

Send: *What changed in Engineering since the previous forecast?* The page moves to **What changed**: an exact Shapley waterfall from `R-2026-09-01#1` to `R-2026-10-01#1` with five factors (Calendar, Composition, Input data, Model, Definition), drawn against the width of the 80% interval. Click **View as table** for the values. Each bar's result links to the two computed forecasts it compares.

Honest note if asked: on this world the Calendar factor is smaller than the design target and Input data comes out slightly positive; PROGRESS.md (Deviations) explains why and that they were reported, not tuned.

## Beat 3, inject a failure (1:30 to 2:05)

1. Click **Data health** in the left navigation, then **Simulate payroll arrival (synthetic)**.
2. Within a few seconds: the banner **Held for review: R-2026-10-01#2** with C01, C02 and C03 failing (C04 warns), the routine stepper stopping at the gate, the check heatmap, the lineage path from `stg_payroll__lines.pay_basis_code` to the candidate run, the root-cause ranking with the pay-basis mapping first, and the mapping change waiting for a data engineer.

Key point: "A vendor code change never reached a People Partner." The published forecast did not move.

## Beat 4, repair and replay (2:05 to 2:35)

1. Switch the role to **Data Engineer (data-eng)**. On Data health, the mapping card shows the diff (`ANN` means annual; unknown codes are rejected), generated deterministically from the vendor code dictionary and the probe that puts the Vancouver entity's amounts about 12 times their band midpoints.
2. Click **Approve** on the mapping card. The routine rebuilds the warehouse under the approved mapping (payroll@2: every feature recomputed from the landed sources, not only the affected models), rescores and re-checks, the banner turns to **Repaired: R-2026-10-01#3 replaced the held R-2026-10-01#2**, and the replay card shows **Identical business-result hash** with the forced payroll@1 replay differing, as it must. The live replay takes about 15 seconds; if it is still running, talk through the diff first.

Key point: "The corrected number is reproducible for Compensation and Finance."

## Beat 5, approved review (2:35 to 3:15)

1. Switch back to **People Analytics Lead (pa-lead)**, open **Reviews** and send: *Prepare a People Partner review for Platform Engineering.* The draft opens on the page with three group-level checks and their evidence links: compensation position against band midpoints (with the pay-equity blocking item), career progression and hiring coverage.
2. Click **Submit as pa-lead**, then **Approve** on the review: refused with **SELF_APPROVAL**, shown and audited.
3. Switch to **People Operations Director (people-ops-director)** and click **Approve**: three tasks owned by the Engineering People Partner, the compensation task carrying "Pay-equity check by Compensation before any cohort pay change".
4. Click **Roll back approval**, keep the reason "approved against the wrong cohort", and **Confirm rollback**: the tasks are cancelled and the audit card still says **Chain verified**.

Key point: "Nobody approves their own proposal, and every action can be undone with both entries on the record."

## Optional: Research page (about 45 seconds)

Click **Research** in the left navigation. The card **What did the pre-registered tests find?** lists six verdicts from 20 seeds of the synthetic world (`results/research-2026-10-13.json`), judged by decision rules written down before any result (`research/PREREGISTRATION.md`, never edited since).

- **H3a and H3b, consistent.** With shared team shocks at sigma 0.5, the independence intervals' 80% coverage falls to 74.3% while the shock-aware intervals hold 77.5%; at team level the shock-aware PIT distance is 0.029, under the 0.05 bound.
- **H1, H2 and H4, count against.** Matured outcomes are not shown equivalent to O/E 1 at any late-reporting share, the censored treatment of a missing extract gives O/E 0.965, and deduplication gives O/E 0.958. Say why honestly: the clean base world already over-predicts slightly (O/E about 0.96 to 0.97), so the handling choices that should restore 1 land near or below the 0.95 equivalence bound. That is a finding about the base world, to study separately, not a reason to move the bounds.
- **H5, descriptive.** No decision rule was registered; at a 30% late share with shocks at sigma 0.5, matured and shock-aware handling together gave O/E 0.994 and 80% coverage of 77.0%, against 1.030 and 74.9% for the naive handling with independence intervals.

Key point: "Three of the six pre-registered verdicts count against the predictions, and the page says so."

## Optional: Scenario Lab page (about 45 seconds)

Skip this beat if `npm run demo` printed "Lab sessions from the 27B: none". Click **Scenario Lab**. Read the label first: "Hypothesis generation with synthetic personas. Not a forecast, not a survey, not validated." Personas built from cohort-level facts (cells of at least 10 people) react to a proposal on a simulated forum; nothing here feeds a forecast or a review.

1. Pick a proposal (promotion criteria with a June window, or the infrastructure and data merge).
2. Point at the banner: "Recorded from Qwen3.6-27B on this laptop, <date>; replayed. No model runs here; the charts are computed from the recorded posts." Every replicate replays to its database hash with no model (CI checks it).
3. Walk the views: theme bars with replicate ranges, attitude trajectories by tenure band, the influence network (simulated, colored by cohort only, not organizational network analysis), draft pilot items with the wording linter's findings, and the sanity panel, whose facts-only baseline and two negative controls show how much agreement is prompt echo.
4. Interview one persona: in **Ask one persona a question**, click one of the recorded questions. The answer carries the "Synthetic persona" chip, the same recorded-from line and the Lab label. A typed question that was not recorded gets a short message pointing at the recorded ones.

Key point: "This generates questions to test with real people; the sanity panel shows how much of it is prompt echo."

## Q&A crib

- **Why discrete-time competing risks rather than Cox or Fine-Gray?** Departures are recorded by month and causes compete: a person who retires cannot resign. A landmark multinomial logit over calendar months gives cause-specific cumulative incidence directly, handles the monthly grid without tied-time corrections, and is about 150 lines with scipy and no GPL dependency (ADR 0004, SPEC section 9).
- **Tenure is an age proxy. What stops misuse?** Age is never a feature; tenure is modeled because it drives departure hazards. An audit-only age attribute is kept in an isolated schema (no model outside it may reference it, and tests check the import, file and warehouse boundaries). The action audit is built (`staysignal audit actions`, the Governance page): it screens the twelve seeded synthetic approved reviews for adverse impact by tenure band and location (proxy screens, for leads and the auditor) and by the age-40-or-over flag (the auditor only), with impact ratios against the four-fifths rule of thumb and Fisher's exact test (SPEC 17, ADR 0013 in SPEC section 2).
- **How reliable are exit reasons?** Reasons recorded at departure are known to be noisy, so the model only distinguishes voluntary, involuntary and retirement, and the voluntary definition is versioned (SPEC 7.4; references in SPEC 28).
- **Ecological fallacy?** Every output is a cohort aggregate and is read as a statement about the group's expected count, never about its members (ADR 0001).
- **Performative prediction?** A forecast that triggers retention actions changes the outcome it predicts; backtests are pseudo-real-time and published runs are kept apart from backtests, so their effect can be studied rather than hidden (SPEC 10).
- **Why no performance ratings?** Rater bias, a curvilinear relationship with turnover and the risk of steering decisions about individuals (ADR 0015 in SPEC section 2).
- **What can the synthetic world show?** That the pipeline, the uncertainty method and the controls work on a world with known truth (the oracle, `results/oracle-coverage-*.json`). It cannot show real-world accuracy.
- **What would validation on real data need?** Quarterly backtests at matured outcomes, calibration and coverage by cohort with block bootstrap, a data-quality baseline per source, and a review of the action audit before any rollout (SPEC 10, 17).
- **Regulatory position?** Cohort-level planning support, not automated decisions about individuals; see `docs/regulatory-notes.md` and `docs/employee-notice-template.md` (SPEC 17). This is not legal advice.
- **How do you know the agent stays inside its rules?** A 200-question synthetic eval runs through the same turn as the chat dock. On Qwen3-1.7B, the small local test model, after the server-side cohort guard (`evals/results/agent-llama-2026-10-13.json`): 0 prompt-injection successes in 30 attempts and refusal accuracy 100% on 40 refusal items, all refused before any model call; routing 51.7% and grounding 50%, which is why numbers come only from tools and an answer that fails grounding falls back to a template. The 27B eval run is not done yet.
- **Why is the model output recorded rather than live?** The 27B (Qwen3.6-27B, 4-bit, on MLX) needs about 16.6 GB of this laptop's 24 GB; its measured cold time to the first token on the agent's tool prefix is 20 to 34 seconds, and the memory guard stopped it on swap growth during measurement. So every model output was recorded once on this laptop and is replayed, labeled with the model and date. The tools and numbers are not recorded: they run live against the warehouse on every replay, and `test/worker/recordings.test.ts` requires each replay to reproduce the recorded result IDs.
- **Can you undo a publication?** Publication is a pointer: rollback moves it back to version 1 with a reason, and version 3 stays in the run history (ADR 0005).
