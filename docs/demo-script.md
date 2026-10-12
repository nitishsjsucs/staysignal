# Demo script

The runbook for beats 1 to 5 of SPEC.md section 3, with exact clicks and a Q&A crib. Everything shown is the synthetic company Larkspur Systems; every number below was produced by this repository on the canonical world (seed 20261011) and is labeled synthetic in the app. Beat 6 (the Scenario Lab) is not part of the 7-day variant.

## Before the demo

```sh
npm run dev:keys                                            # once: local dev keys and the runner token
uv run --project engine staysignal engine prepare --fresh   # land the world, build the warehouse, publish the two runs
npm run demo:snapshots                                      # the per-beat snapshots under var/snapshots/
npm run demo:reset -- --beat 1                              # about 3 seconds: restore the start of beat 1 and start the demo profile
```

Open `http://127.0.0.1:8795` in a browser at 1440 x 900 and sign in with the role switcher as **People Analytics Lead (pa-lead)**. The demo profile runs the built app under wrangler dev with the local engine on 8196; every routine job is computed live by the engine.

Model text: the default demo mode replays recorded 27B turns with live tools. No 27B turn has been recorded yet (the memory guard stopped every 27B session so far, see PROGRESS.md), so answers currently come from the stub model, which routes each question to one governed tool and narrates with the template; the answer chips say so. To recover any beat: `npm run demo:reset -- --beat N`.

## Frame (0:00 to 0:10)

Say: "Cohort-level planning support for People Partners. No individual scores anywhere a person can see. A synthetic company."

## Beat 1, forecast (0:10 to 0:50)

1. Click **Ask** (top right) and send: *Forecast voluntary departures in Engineering over the next 90 days.*
2. The dock shows the `forecast departures` tool card and an answer whose numbers link to the computed result. The page follows to Engineering at 3 months: **13.1** expected voluntary departures, 80% range **8 to 18**, 95% range **6 to 22**, next to the trailing-rate status quo.
3. Point at the trust strip (backtest observed over expected, how often the 80% range held, data freshness, checks passing), the fan chart (6 months, 80% and 95% bands, Other exits as a grey line) and the backtest strip (quarterly pseudo-real-time backtests: model and data as known at each cutoff, not forecasts that were published).

Key point: "In non-overlapping quarterly backtests our 80% range held N of M times." Read N and M from the trust strip; they are synthetic-world results.

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
2. Click **Approve** on the mapping card. The routine rebuilds the affected models, the banner turns to **Repaired: R-2026-10-01#3 replaced the held R-2026-10-01#2**, and the replay card shows **Identical business-result hash** with the forced payroll@1 replay differing, as it must. The live replay takes about 15 seconds; if it is still running, talk through the diff first.

Key point: "The corrected number is reproducible for Compensation and Finance."

## Beat 5, approved review (2:35 to 3:15)

1. Switch back to **People Analytics Lead (pa-lead)**, open **Reviews** and send: *Prepare a People Partner review for Platform Engineering.* The draft opens on the page with three group-level checks and their evidence links: compensation position against band midpoints (with the pay-equity blocking item), career progression and hiring coverage.
2. Click **Submit as pa-lead**, then **Approve** on the review: refused with **SELF_APPROVAL**, shown and audited.
3. Switch to **People Operations Director (people-ops-director)** and click **Approve**: three tasks owned by the Engineering People Partner, the compensation task carrying "Pay-equity check by Compensation before any cohort pay change".
4. Click **Roll back approval**, keep the reason "approved against the wrong cohort", and **Confirm rollback**: the tasks are cancelled and the audit card still says **Chain verified**.

Key point: "Nobody approves their own proposal, and every action can be undone with both entries on the record."

## Q&A crib

- **Why discrete-time competing risks rather than Cox or Fine-Gray?** Departures are recorded by month and causes compete: a person who retires cannot resign. A landmark multinomial logit over calendar months gives cause-specific cumulative incidence directly, handles the monthly grid without tied-time corrections, and is about 150 lines with scipy and no GPL dependency (ADR 0004, SPEC section 9).
- **Tenure is an age proxy. What stops misuse?** Age is never a feature; tenure is modeled because it drives departure hazards. An audit-only age attribute is kept in an isolated schema (no model outside it may reference it, and a test checks that) for the planned action audit, which will check whether actions fall disproportionately on older cohorts; that audit is a later milestone (SPEC 17, ADR 0013 in SPEC section 2).
- **How reliable are exit reasons?** Reasons recorded at departure are known to be noisy, so the model only distinguishes voluntary, involuntary and retirement, and the voluntary definition is versioned (SPEC 7.4; references in SPEC 28).
- **Ecological fallacy?** Every output is a cohort aggregate and is read as a statement about the group's expected count, never about its members (ADR 0001).
- **Performative prediction?** A forecast that triggers retention actions changes the outcome it predicts; backtests are pseudo-real-time and published runs are kept apart from backtests, so their effect can be studied rather than hidden (SPEC 10).
- **Why no performance ratings?** Rater bias, a curvilinear relationship with turnover and the risk of steering decisions about individuals (ADR 0015 in SPEC section 2).
- **What can the synthetic world show?** That the pipeline, the uncertainty method and the controls work on a world with known truth (the oracle, `results/oracle-coverage-*.json`). It cannot show real-world accuracy.
- **What would validation on real data need?** Quarterly backtests at matured outcomes, calibration and coverage by cohort with block bootstrap, a data-quality baseline per source, and a review of the action audit before any rollout (SPEC 10, 17).
- **Regulatory position?** Cohort-level planning support, not automated decisions about individuals; the notes and the employee notice template are M3 documents (SPEC 17). This is not legal advice.
- **Can you undo a publication?** Publication is a pointer: rollback moves it back to version 1 with a reason, and version 3 stays in the run history (ADR 0005).
