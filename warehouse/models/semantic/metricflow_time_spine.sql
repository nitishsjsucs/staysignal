{#- Day-grain time spine for MetricFlow (SPEC 7.3), 2023-04-01 (the HRIS migration) to 2027-12-31. -#}
select {{ mf_time('date_day') }} as date_day
from {{ day_series("date '2023-04-01'", "date '2027-12-31'") }} as days
