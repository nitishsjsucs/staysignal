# Regulatory notes

Not legal advice. StaySignal is designed to minimize regulatory exposure; it is not claimed to be out of scope of any law. Everything here concerns the synthetic company Larkspur Systems, which employs people in Raleigh, Pittsburgh, Vancouver and Manchester. The rows restate SPEC.md section 17.7, whose sources are listed in SPEC.md section 28; a real deployment needs counsel to confirm every row.

## Purpose and design controls

- **Purpose.** Cohort-level workforce planning support for People Partners. It never informs a decision about an individual: no individual score, ranking, list or timeline appears in any interface, API response, tool result, log or memory file (ADR 0001), and individual predictions are computed in memory and never persisted (ADR 0014).
- **Closed signal list.** The model uses only the features of SPEC 8.2. There is no field for protected attributes, special-category data, performance ratings, monitoring data or free-text personnel files. Location is a reporting dimension and never a model feature.
- **Proxies.** Tenure and level band correlate with age. An audit-only age-40-or-over flag exists in an isolated `audit` schema that no feature, dimension, tool or prompt can reach (ADR 0013; a test checks that no model outside the audit schema references it), so the action audit can screen for adverse impact. The model card reports proxy strength: tenure band AUC 0.62 and level band AUC 0.57 for the age flag on the synthetic population.
- **Disclosure control.** Cohorts under 10 are suppressed, served values are rounded by cohort size, comparisons over time need 50 or more people, and a comparison whose population changed by 1 to 9 people is withheld (SPEC 17.5).
- **Pay equity.** A compensation review task carries a blocking item: a pay-equity check by Compensation before any cohort pay change.
- **Exit reasons.** Exit-reason codes recorded at departure are unreliable, so the model distinguishes only voluntary, involuntary and retirement, and cause-specific results carry that caveat.
- **Performative prediction.** Every review is in the hash-chained action log, so a later evaluation can hold out cohorts that received attention.

## Jurisdictions

| Jurisdiction | Applies to Larkspur? | Design control | What a real deployment still needs |
|---|---|---|---|
| US federal: Title VII, the ADEA, the Uniform Guidelines (29 CFR 1607) | yes | no protected attribute as a feature; an action audit by group with the four-fifths screen and Fisher's exact test (built: `staysignal audit actions`, the Governance page); proxy strength reported | counsel; a real audit with governed protected attributes |
| North Carolina and Pennsylvania | yes | as above | counsel to confirm state requirements (the SPEC review identified no AI-specific employment statute there) |
| British Columbia: PIPA and the Human Rights Code | yes (Vancouver) | employee personal information used for managing employment; cohort-only outputs; the notice template | counsel; notice to employees |
| UK GDPR, the Data Protection Act 2018 and the Equality Act 2010 | yes (Manchester) | computing individual probabilities internally is profiling (UK GDPR Art 4(4)), so predictions are never persisted, which also limits what an access request can return; no solely automated decision about a person, so Art 22 is not engaged as designed; the notice template | a DPIA (Art 35), a legitimate-interests assessment, notice, an access-request process |
| Illinois Human Rights Act as amended by HB 3773 | no (no Illinois site) | location is not a model feature; the action audit; the notice template | if deployed in Illinois: notice before use and counsel |
| Texas TRAIGA (HB 149) | no (no Texas site) | the action audit still screens for impact | counsel if a Texas site opens |
| NYC Local Law 144 | no (no NYC site) | not an automated employment decision tool as designed: no candidate screening and no promotion decisions | a bias audit only if it ever substantially assisted hiring or promotion decisions in NYC |
| EU AI Act and GDPR | no (no EU site) | employment systems are listed in Annex III, and a listed system that profiles is high-risk; having no individual output reduces exposure but does not remove it | if deployed in the EU: treat as high-risk, a conformity assessment, a DPIA, works council consultation |

For every jurisdiction where it applies, a deployment also needs employee notice (see [employee-notice-template.md](employee-notice-template.md)) and consultation with employee representatives or a works council where one exists.

## Status in this repository

Built: cohort-only outputs, the disclosure rules, never persisting individual predictions, the isolated audit attribute, the pay-equity blocking item, the hash-chained action log, the action audit with adverse-impact screens (tenure band and location for leads and the auditor, the age flag for the auditor only) and proxy strength in the model card. On the twelve seeded synthetic reviews the location screen flags Vancouver below the four-fifths line (impact ratio 0.73, Fisher p < 0.001): a reason to look at how review cohorts are chosen, not a finding. The purpose-scoped access policy is compiled from `policy/access.yaml` with its BigQuery grant plan (`npm run policy:compile`) and checked in CI, but not deployed. Not built yet: the retention sweep (a later milestone in SPEC 24).
