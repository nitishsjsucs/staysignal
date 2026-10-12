{#- Headcount and departures by cause per organization and month (published; cohort aggregates only). Cells under 10
    people are suppressed: the count is null and `suppressed` is true. -#}
with cells as (
    select
        month_start,
        coalesce(org_name, 'Unknown') as org_name,
        count(*) as headcount,
        count(*) filter (where departure_cause = 'voluntary') as voluntary_departures,
        count(*) filter (where departure_cause = 'involuntary') as involuntary_departures,
        count(*) filter (where departure_cause = 'retirement') as retirements
    from {{ ref('fct_employee_month') }}
    group by all
)

select
    month_start,
    org_name,
    headcount >= 10 as servable,
    case when headcount >= 10 then headcount end as headcount,
    case when headcount >= 10 then voluntary_departures end as voluntary_departures,
    case when headcount >= 10 then involuntary_departures end as involuntary_departures,
    case when headcount >= 10 then retirements end as retirements,
    headcount < 10 as suppressed
from cells
