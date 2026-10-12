{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'X01'}) }}
{#- X01: per entity, the number of people paid in the latest period equals the number of HRIS employees active at any
    point in it (exact). One row per person of difference. -#}
with periods as ({{ latest_periods() }}),
active as ({{ active_in_latest_period() }}),
paid as (
    select distinct l.entity_code, l.employee_key
    from {{ ref('stg_payroll__lines') }} as l, periods as p
    where {{ as_of('l.recorded_at') }} and l.pay_period = p.latest
),
counts as (
    select coalesce(a.entity_code, p.entity_code) as entity_code, coalesce(a.n, 0) as active_n, coalesce(p.n, 0) as paid_n
    from (select entity_code, count(*) as n from active group by 1) as a
    full outer join (select entity_code, count(*) as n from paid group by 1) as p using (entity_code)
)
select c.entity_code from counts as c, generate_series(1, abs(c.paid_n - c.active_n)) as g(i)
where c.paid_n <> c.active_n
