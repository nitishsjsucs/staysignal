{#- One row per employment spell [start_date, end_date): end_date is the first day not employed, null while employed
    or when a later hire closed the spell without a termination. A migrated employee's spell starts at the legacy
    hire date. -#}
with recs as (
    select * from {{ ref('int_hris__spell_records') }}
),

starts as (
    select
        employee_key,
        spell_no,
        case
            when record_type = 'migration_baseline' and legacy_hire_date is not null then legacy_hire_date
            else effective_date
        end as start_date,
        record_id as start_record_id
    from recs
    where is_spell_start
),

ends as (
    select employee_key, spell_no, effective_date as end_date, termination_reason_code, team_id as end_team_id
    from recs
    where record_type = 'termination'
)

select
    s.employee_key,
    s.spell_no,
    s.start_date,
    e.end_date,
    case
        when e.end_date is null then null
        when e.termination_reason_code = 'VOL_RESIGN' then 'voluntary'
        when e.termination_reason_code = 'RETIRE' then 'retirement'
        else 'involuntary'
    end as cause,
    e.termination_reason_code,
    e.end_team_id,
    s.start_record_id
from starts as s
left join ends as e using (employee_key, spell_no)
