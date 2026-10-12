# ADR 0004: Landmark discrete-time competing-risks multinomial logit

Status: accepted (2026-10-12)

## Context
Employees leave for different reasons, and treating involuntary exits and retirements as censoring overstates voluntary risk (1 minus Kaplan-Meier is biased under competing risks). HR events are recorded at the day or month grain, and features change over time. The forecast must be explainable to People Partners and analysts, and the repository is MIT, so GPL code (PyDTS, scikit-survival) cannot be used.

## Decision
A landmark discrete-time competing-risks model on calendar-month periods: at each monthly landmark, features are frozen and the next six months are modeled with cause-specific hazards `h_k(j | x) = exp(a_kj + x_k' b_k) / (1 + sum_m exp(a_mj + x_m' b_m))` for voluntary, involuntary and retirement, fit as one penalized multinomial logit with per-cause feature masks and period intercepts (Allison 1982; Tutz and Schmid 2016; Lee, Feuer and Fine 2018; landmarking per van Houwelingen 2007). Implemented in this repository with scipy (about 150 lines), with a cluster-robust sandwich covariance by team.

## Consequences
Cumulative incidence and cohort sums follow directly. Retirement uses period intercepts and organization only, so no age-related individual score exists. Coefficients are associational and labeled so. A test cross-checks unpenalized coefficients against statsmodels `MNLogit`.
