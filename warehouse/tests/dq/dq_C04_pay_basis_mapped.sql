{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'C04'}) }}
{#- C04: every pay-basis code in the latest period is mapped explicitly by the active mapping (no default used). -#}
with periods as ({{ latest_periods() }})
select a.entity_code, a.pay_basis_code
from {{ ref('int_comp__annualized') }} as a, periods as p
where a.pay_period = p.latest and a.unknown_code
