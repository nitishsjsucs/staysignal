{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'R01'}) }}
{#- R01: every payroll line of the latest period belongs to someone active in HRIS during that period. -#}
with periods as ({{ latest_periods() }}),
active as ({{ active_in_latest_period() }}),
lines as (
    select l.entity_code, l.employee_key
    from {{ ref('stg_payroll__lines') }} as l, periods as p
    where {{ as_of('l.recorded_at') }} and l.pay_period = p.latest
)
select l.entity_code from lines as l
where l.employee_key is null or l.employee_key not in (select employee_key from active)
