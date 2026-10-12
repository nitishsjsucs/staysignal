{{ config(tags=['published']) }}
{#- No published cell describes fewer than 10 people unless it is suppressed (SPEC 17.5 rule 1). -#}
select run_id, cohort_id, horizon_months
from {{ source('engine_published', 'forecast_cohort') }}
where n < 10 and not suppressed
union all
select month_start::varchar, org_name, 0
from {{ ref('rpt_workforce_monthly') }}
where not suppressed and headcount < 10
