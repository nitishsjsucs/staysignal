{{ config(severity='warn', tags=['dq', 'phase2'], meta={'check_id': 'R04'}) }}
{#- R04: every manager reference resolves to someone with an employment spell. Mirrors quality/run_checks.py
    manager_references. -#}
select r.employee_key, r.seq from {{ ref('int_hris__spell_records') }} as r
where r.record_type <> 'termination'
  and r.manager_key is not null
  and r.manager_key not in (select employee_key from {{ ref('int_hris__spells') }})
