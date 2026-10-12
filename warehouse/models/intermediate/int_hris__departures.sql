{#- Departures known at the vintage: spells with a termination, by cause, with the team at departure. Transfers keep
    the spell open; a rehire starts a new spell. -#}
select employee_key, spell_no, start_date, end_date, cause, termination_reason_code, end_team_id
from {{ ref('int_hris__spells') }}
where end_date is not null
