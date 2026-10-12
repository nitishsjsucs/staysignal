{#- Assigns every current record to an employment spell, in (effective date, recorded at, record id) order.
    A hire or rehire always starts a spell (closing an open one without a known end); the migration baseline starts
    one only when no spell is open; a termination closes the spell; records outside an open spell are orphans and
    are dropped (the checks catch them). Mirrors features/reference.py Vintage._spells. -#}
with ordered as (
    select
        *,
        row_number() over (partition by employee_key order by effective_date, recorded_at, record_id) as seq
    from {{ ref('int_hris__records_current') }}
),

prior as (
    select
        *,
        max(case when record_type in ('hire', 'rehire') then seq end) over (
            partition by employee_key order by seq rows between unbounded preceding and 1 preceding
        ) as last_hard_start,
        max(case when record_type = 'termination' then seq end) over (
            partition by employee_key order by seq rows between unbounded preceding and 1 preceding
        ) as last_termination
    from ordered
),

starts as (
    select
        *,
        case
            when record_type in ('hire', 'rehire') then 1
            when record_type = 'migration_baseline'
                and (last_hard_start is null or coalesce(last_termination, 0) > last_hard_start) then 1
            else 0
        end as is_start
    from prior
),

segmented as (
    select
        *,
        sum(is_start) over (partition by employee_key order by seq rows between unbounded preceding and current row)
            as spell_no
    from starts
),

closed as (
    select
        *,
        min(case when record_type = 'termination' then seq end) over (partition by employee_key, spell_no)
            as first_termination
    from segmented
    where spell_no > 0
)

select
    record_id,
    employee_key,
    spell_no,
    seq,
    record_type,
    effective_date,
    recorded_at,
    job_code,
    job_family,
    level,
    team_id,
    manager_key,
    location_code,
    employment_type,
    contract_end_date,
    termination_reason_code,
    legacy_hire_date,
    legacy_first_promotion_date,
    legacy_last_promotion_date,
    is_start = 1 as is_spell_start
from closed
where first_termination is null or seq <= first_termination
