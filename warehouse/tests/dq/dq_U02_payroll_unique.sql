{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'U02'}) }}
{#- U02: payroll lines unique by (entity, employee, period) in the latest period; one row per extra line. -#}
with periods as ({{ latest_periods() }}),
lines as (
    select l.entity_code, l.employee_key, l.pay_period
    from {{ ref('stg_payroll__lines') }} as l, periods as p
    where {{ as_of('l.recorded_at') }} and l.pay_period = p.latest
),
keyed as (
    select *, row_number() over (partition by entity_code, employee_key, pay_period) as n from lines
)
select entity_code, pay_period from keyed where n > 1
