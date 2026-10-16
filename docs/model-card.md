# Model card: StaySignal voluntary departure forecast

Everything here describes models trained and evaluated on the synthetic company Larkspur Systems (seed 20261011). The results test the pipeline and the uncertainty method on a world with known truth; they say nothing about accuracy on real data.

## Intended use

Cohort-level workforce planning support for People Partners: the expected number of voluntary departures from a company, organization, group or (for People Analysts) team over the next 1, 3 or 6 months, with 80% and 95% ranges, the trailing-rate status quo beside it, and an explanation of what changed between forecasts.

Out of scope: any statement or decision about an individual (pay, promotion, performance, discipline, selection for retention offers, employment), ranking teams or managers, and use on a population the model was not trained for. No individual score is ever shown or stored (ADR 0001, ADR 0014).

## Model

- Landmark discrete-time competing-risks multinomial logit on calendar months (ADR 0004): at each monthly landmark, everyone employed contributes months 1 to 6 until the first event; causes are voluntary, involuntary and retirement, with per-cause feature masks, an L2 penalty and penalized period deviations.
- Features (SPEC 8.2): tenure (natural cubic spline of log months), time in role, time since the last promotion, first-promotion status, net manager changes in 180 days, compensation position against the band midpoint, the shrunk prior voluntary departure rate of the team, recent reorganization exposure, job family, level band, organization, employment type and, for the involuntary cause only, fixed-term days remaining. Location is never a feature.
- Uncertainty: team-clustered sandwich covariance for the parameters, team and organization shocks per quarter estimated by the method of moments with bootstrap draws, and nested Monte Carlo (parameters, organization shocks, team shocks, individual outcomes) with an exact variance decomposition.
- Artifact `m2026.09`: trained on 33 monthly landmarks from 2023-10-01 to 2026-06-01 (335,398 person-months, 3,792 voluntary, 991 involuntary and 188 retirement events, 119 team clusters), data as known at 2026-10-01T06:00Z, rows kept only when matured 75 days before the training cutoff; estimated sigma_team 0.43 (team overdispersion including contagion) and sigma_org 0.06 (from 11 quarterly windows).

## Data

Synthetic HRIS records (bitemporal, with planted duplicates, late terminations, corrections and rescissions), payroll lines, the organization tree, pay bands and ATS extracts, described in [data-dictionary.md](data-dictionary.md). Features use only records known at the cutoff (point-in-time; a property test checks no lookahead).

## Evaluation

The recorded numbers are in [RESULTS.md](RESULTS.md) (generated), the README's Results at a glance and `results/` (`backtest-*.json`, `calibration-*.json`, `model-comparison-*.json`, `challenger-*.json`, `recovery-*.json`, `oracle-coverage-*.json`), and on the Trust page.

In short, from the 2026-10-12 recordings:

| Measure | Company | Organizations |
|---|---|---|
| Observed over expected, 1 / 3 / 6 months | 0.92 / 0.89 / 0.82 | 0.92 / 0.89 / 0.82 |
| 80% range held, 1 / 3 / 6 months | 52% / 58% / 31% | 89% / 82% / 77% |
| 95% range held, 1 / 3 / 6 months | 86% / 84% / 63% | 98% / 92% / 86% |
| Skill against the trailing rate, 1 / 3 / 6 months | -15% / -10% / -2% | 1% / -1% / 4% |
| Independent windows behind each number | 21 / 6 / 2 | 21 / 6 / 2 |

Individual 3-month predictions (36,035 person-windows, deciles only): ICI 0.7 percentage points, E50 0.4, E90 1.7; the lowest deciles are under-predicted and the highest over-predicted. On the six mature quarterly origins of the model comparison, the oracle (which knows the true state) has observed over expected of 0.90 to 1.03, against 0.82 to 0.88 for the model. The SurvivalBoost challenger (`results/challenger-2026-10-12.json`, fitted on at most 12,000 person-landmarks) has observed over expected of 0.93 to 1.08 and too-narrow company ranges; the model refitted on the same rows is about as accurate as on all rows.

What this means: organization-level ranges are close to their nominal coverage, but company-level ranges are too narrow, because the organization-wide shock is estimated at 0.06 (from about 11 quarterly windows) against the generator's 0.20; every model, including the baselines, ran high because the generator's drift lowered recent departures. Treat company-level ranges as too optimistic until the shock estimate improves. The intervals use 20 parameter draws per run; re-recording after the parameter draws were made portable across platforms moved some coverage rates by up to 10 points, so single coverage figures carry Monte Carlo noise as well as the few independent windows.

## Limits

- The world contains a latent individual propensity the model cannot see, so individual discrimination is modest by design; the model is judged on cohort counts and calibration, not on ranking individuals.
- Drift after 2025-10-01 is planted in the generator; recent windows may show observed over expected below 1.
- Exit-reason codes are unreliable in real data, so only three causes are modeled and cause-specific results carry that caveat.
- Coverage numbers rest on few independent windows (printed beside every number); overlapping windows are not independent.
- Once forecasts drive reviews, later backtests are contaminated (performative prediction); reviews are logged so evaluations can hold reviewed cohorts out.
- Proxy strength (`staysignal audit actions`, 2026-10-12, [results/action-audit-2026-10-12.json](../results/action-audit-2026-10-12.json)): on the 2,023 people employed on 2026-10-01, tenure band separates the audit-only age-40-or-over flag with an AUC of 0.62 and level band with 0.57 (0.5 means no information). Both carry some age information, which is why the action audit screens by tenure band and why retirement is a cohort-level baseline with no individual score.

## Ethical considerations

Cohort outputs only, disclosure rounding and suppression, no protected attribute as a feature, the audit-only attribute isolated, a pay-equity blocking item on compensation tasks, and every action in a hash-chained log with rollback. See [regulatory-notes.md](regulatory-notes.md).
