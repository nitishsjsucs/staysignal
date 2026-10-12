{{ config(severity='warn', tags=['dq', 'phase1'], meta={'check_id': 'C01'}) }}
{#- C01: compa-ratio within [0.5, 2.0] for the latest period's lines, against the band of the employee's assignment
    in the spell that covers the period end. -#}
with periods as ({{ latest_periods() }}),
bounds as (select latest, cast(cast(latest || '-01' as date) + interval 1 month as date) as p1 from periods),
lines as (
    select a.* from {{ ref('int_comp__annualized') }} as a, bounds as b
    where a.pay_period = b.latest and a.annual_base is not null
),
covering as (
    select s.employee_key, s.spell_no from {{ ref('int_hris__spells') }} as s, bounds as b
    where s.start_date < b.p1 and (s.end_date is null or s.end_date > b.p1)
),
last_record as (
    select r.employee_key, r.job_family, r.level, r.location_code
    from {{ ref('int_hris__spell_records') }} as r
    join covering as c using (employee_key, spell_no)
    where r.record_type <> 'termination'
    qualify row_number() over (partition by r.employee_key order by r.seq desc) = 1
)
select l.entity_code
from lines as l
join last_record as r using (employee_key)
join {{ ref('stg_ref__bands') }} as band
    on band.job_family = r.job_family and band.level = r.level and band.location_code = r.location_code
where not (l.annual_base / band.band_mid between 0.5 and 2.0)
