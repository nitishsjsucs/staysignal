{{ config(severity='warn', tags=['dq', 'phase2'], meta={'check_id': 'R02'}) }}
{#- R02: a manager reference names someone employed on the record's effective date, allowing 30 days after the
    manager's spell ends for reports to be reassigned. References to no known employee are R04's. Mirrors
    quality/run_checks.py manager_references. -#}
with refs as (
    select employee_key, seq, effective_date, manager_key from {{ ref('int_hris__spell_records') }}
    where record_type <> 'termination' and manager_key is not null
),

spells as (
    select employee_key, start_date, end_date from {{ ref('int_hris__spells') }}
)

select r.employee_key, r.seq from refs as r
where r.manager_key in (select employee_key from spells)
  and not exists (
      select 1 from spells as m
      where m.employee_key = r.manager_key
        and m.start_date <= r.effective_date
        and (m.end_date is null or r.effective_date < {{ add_days('m.end_date', 30) }})
  )
