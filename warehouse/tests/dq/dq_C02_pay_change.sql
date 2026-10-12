{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'C02'}) }}
{#- C02: annualized pay moves by at most 3x from the previous period for the same employee. -#}
with periods as ({{ latest_periods() }}),
cur as (
    select a.employee_key, a.annual_base from {{ ref('int_comp__annualized') }} as a, periods as p
    where a.pay_period = p.latest and a.annual_base is not null
),
prev as (
    select employee_key, annual_base from (
        select a.employee_key, a.annual_base,
            row_number() over (partition by a.employee_key order by a.recorded_at desc, a.vendor_file_id desc) as n
        from {{ ref('int_comp__annualized') }} as a, periods as p
        where a.pay_period = p.previous
    ) where n = 1 and annual_base is not null and annual_base <> 0
)
select c.employee_key from cur as c join prev as p using (employee_key)
where c.annual_base / p.annual_base > 3.0 or p.annual_base / c.annual_base > 3.0
