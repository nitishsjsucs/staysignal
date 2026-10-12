{{ config(tags=['published']) }}
{#- Every group-month of the flows balances exactly (SPEC 7.3): what was there, plus what came in, minus what left,
    is what is there next month. -#}
select row_key
from {{ ref('rpt_flows_monthly') }}
where next_headcount <> headcount + hires + transfers_in + restructured_in - transfers_out - restructured_out
    - voluntary_departures - involuntary_departures - retirements
